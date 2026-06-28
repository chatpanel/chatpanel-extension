// Agent-facing layer over page-actions.js. Turns "fill forms & operate on the
// page" into model tools the chat loop can call, AND exposes a one-shot
// user-triggered entry point. Both routes share the same gated primitives.
//
//   Agent route:  providers.js is handed PAGE_TOOL_SPECS + makePageToolExecutor(tabId)
//                 and runs a tool-use loop (OpenAI / Anthropic API agents only —
//                 bridge CLIs run their own agentic loop and can't take these).
//   User route:   sidepanel calls inspectForms/fillForm/clickElement directly, or
//                 runPageActionTurn() to kick off a tool-enabled turn on demand.
//
// These primitives are intentionally UNGATED (free). The only access control is
// the user's explicit "Act on page" toggle (state.settings.ui.pageActions), checked
// in sidepanel.js where the provider is built; the CDP/"High-reliability" tools need
// the additional pageActionsCdp toggle. There is no Pro/requirePro check here — do
// not assume one exists when adding a new caller.

import {
  inspectForms, fillForm, clickElement, clickByText, fillCombobox, captureViewport, viewportInfo,
  collectMarks, clickAtSynthetic,
} from './page-actions.js';
import {
  cdpFillForm, cdpClickElement, cdpClickByText, cdpFillCombobox, cdpScreenshot,
  cdpClickAt, cdpTypeText, cdpPressKey, cdpScroll, cdpDrag,
} from './page-actions-cdp.js';

// Harness guidance folded into the system prompt when page tools are armed.
// Structured numbered loop (it gave the best drawing results) — keep it explicit,
// but the hard rule overriding everything is step 4/6: judge "done" from the
// SCREENSHOT, never from your plan, and never fabricate a result.
export const PAGE_AUTOMATION_SYSTEM =
  'USE ONLY the ChatPanel browser tools provided here (inspect_page, screenshot, read_canvas, ' +
  'structured_insert, click_element, click_by_text, click_at, type_text, press_key, fill_form, ' +
  'scroll, …) to see and act on this page — they are the ONLY tools connected to the user’s real, ' +
  'logged-in browser tab.\n' +
  'CRITICAL: do NOT use any built-in / in-app / native browser, computer-use, or an MCP like ' +
  '`agent.browsers` / a node REPL to drive the page. Those open a SEPARATE browser that is NOT wired ' +
  'to the user’s Chrome — they will report no tabs (`agent.browsers.list()` → `[]`, "Browser is not ' +
  'available"). If you EVER see an empty browser list or "no browser available", that means you reached ' +
  'for the WRONG browser: do NOT stop — immediately switch to the ChatPanel tools above (start with ' +
  'inspect_page or screenshot), which ARE connected to this tab. Never conclude the page can’t be ' +
  'controlled just because a non-ChatPanel browser came back empty.\n' +
  'You drive the current browser tab to complete the user’s request. Work from a PLAN and the ' +
  'tools’ TEXT results — you do NOT get a screenshot after every action. Take a screenshot only ' +
  'when you genuinely need to SEE the page, and ONCE at the end to validate. This keeps you fast ' +
  'and lets you operate even without vision.\n' +
  '1) PLAN. Restate the request as an explicit checklist: each target → the EXACT value/option. For ' +
  'a drawing, list every part with rough coordinates (body, cabin, wheels, windows, …). Resolve any ' +
  'ambiguity yourself first, e.g. "working week" = Mon–Fri, so the last working day is FRIDAY.\n' +
  '2) LOCATE. inspect_page returns the page’s fields, buttons, and links with selectors — prefer ' +
  'those. Only if you must act by raw pixel coordinate on a canvas, call screenshot ONCE (it carries ' +
  'a red coordinate grid) to read positions, then act — do NOT screenshot after each move.\n' +
  '3) ACT from your plan. fill_form for inputs/checkboxes/radios; fill_combobox for typeahead pickers ' +
  '(city/airport); click_element/click_by_text for buttons. On a structured app (e.g. Excalidraw) ' +
  'PREFER structured_insert — one data call, exact coordinates, no pixel-dragging. Each tool returns ' +
  'a TEXT result telling you what landed; proceed on that without a screenshot.\n' +
  '3a) COMMIT cell edits in spreadsheets (Google Sheets, Excel online): after type_text into a cell you ' +
  'MUST commit it with press_key Enter (or Tab) — typing alone leaves the cell in EDIT mode and the ' +
  'value/formula is NOT applied. Typing a formula ("=…") opens a formula-autocomplete popup that can ' +
  'SWALLOW the first Enter, so if the cell is still in edit mode press Enter ONCE MORE (repeated Enter ' +
  'is allowed and expected here — it is not a loop). A committed cell shows the COMPUTED value, not the ' +
  'raw "=…" text. Do not give up after a single Enter; press again, then validate.\n' +
  '4) VALIDATE — at the END, and EARLY on any failure. When the checklist is complete, take ONE ' +
  'screenshot and check every item against what is on screen. A tool replying "ok"/"verified" means ' +
  'the action LANDED — the end screenshot (or a tool’s verified:true) is your proof the GOAL is met. ' +
  'But if a tool result reports an error, or a later step won’t act as expected, STOP and validate ' +
  'THEN — a later failure usually means an EARLIER step went wrong, so re-check from there instead of ' +
  'pushing on. (No vision? Rely on the tools’ verified results and report exactly what they say.)\n' +
  '5) SUBMIT LAST. Never click Submit/Save/Send/Pay/Confirm until the end screenshot — or the tool’s ' +
  'verified result — confirms EVERY checklist item. If unsure, ask the user instead.\n' +
  '6) BE HONEST when a tool reports FAILURE (e.g. structured_insert verified:false): say so plainly ' +
  'and stop — do NOT silently switch to a flailing pixel-drawing fallback. You have NO ' +
  'image-generation tool and cannot fetch/export images: never claim you generated or exported one. ' +
  'Never invent selectors — use only ones from inspect_page.';

// Capture a screenshot, preferring CDP (works on background tabs) then the
// visible-tab fallback. Returns a JPEG data URL or null.
async function screenshot(tabId, cdp) {
  let img = cdp ? await cdpScreenshot(tabId).catch(() => null) : null;
  if (!img) img = await captureViewport(tabId);
  return img;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}

// Overlay a labelled coordinate grid (in VIEWPORT CSS pixels) on a screenshot so
// the model can READ coordinates off it instead of guessing — a big accuracy
// boost for click_at/draw_path, especially for weaker models. Returns a new JPEG
// data URL (or the original if anything fails / no DOM canvas available).
async function annotateGrid(dataUrl, vp) {
  if (!dataUrl || !vp || typeof document === 'undefined') return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    if (!W || !H) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sx = W / vp.w; // image px per CSS px (≈ devicePixelRatio)
    const sy = H / vp.h;
    const step = vp.w > 1400 ? 200 : 100; // CSS px between gridlines
    const fs = Math.round(11 * sx);
    ctx.font = `${fs}px sans-serif`;
    ctx.textBaseline = 'top';
    for (let x = step; x < vp.w; x += step) {
      const px = Math.round(x * sx);
      ctx.strokeStyle = 'rgba(255,0,0,.22)';
      ctx.lineWidth = Math.max(1, Math.round(sx));
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = 'rgba(220,0,0,.95)';
      ctx.fillText(String(x), px + 2, 2);
    }
    for (let y = step; y < vp.h; y += step) {
      const py = Math.round(y * sy);
      ctx.strokeStyle = 'rgba(255,0,0,.22)';
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
      ctx.stroke();
      ctx.fillStyle = 'rgba(220,0,0,.95)';
      ctx.fillText(String(y), 2, py + 2);
    }
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return dataUrl;
  }
}

// Set-of-Mark overlay: draw a numbered, boxed tag on each interactive element so
// the model can pick a NUMBER (click_mark) instead of estimating coordinates.
async function annotateMarks(dataUrl, marks, vp) {
  if (!dataUrl || !marks?.length || !vp || typeof document === 'undefined') return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sx = W / vp.w;
    const sy = H / vp.h;
    const fs = Math.round(11 * sx);
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textBaseline = 'top';
    marks.forEach((m, i) => {
      const bx = m.left * sx;
      const by = m.top * sy;
      ctx.strokeStyle = 'rgba(0,120,255,.9)';
      ctx.lineWidth = Math.max(1, Math.round(sx));
      ctx.strokeRect(bx, by, m.w * sx, m.h * sy);
      const tag = String(i + 1);
      const pad = Math.round(2 * sx);
      const tw = ctx.measureText(tag).width + pad * 2;
      const th = fs + pad * 2;
      const ty = Math.max(0, by - th);
      ctx.fillStyle = 'rgba(0,120,255,.95)';
      ctx.fillRect(bx, ty, tw, th);
      ctx.fillStyle = '#fff';
      ctx.fillText(tag, bx + pad, ty + pad);
    });
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return dataUrl;
  }
}

// Provider-agnostic tool specs. providers.js maps these into OpenAI's
// `{type:'function', function:{…}}` and Anthropic's `{name, input_schema}` shapes.
export const PAGE_TOOL_SPECS = [
  {
    name: 'inspect_page',
    description:
      "Read the active browser tab's interactive elements: fillable form fields, " +
      'clickable buttons, AND links (anchors). Returns each with a stable `selector` ' +
      '— fields also carry label/type/current value/(dropdown) options; links carry ' +
      'their text and href. ALWAYS call this first so you know the exact selectors ' +
      'before filling or clicking. To click a link (e.g. a “comments” link), find it ' +
      'in `links` and pass its selector to click_element.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fill_form',
    description:
      'Set values on form fields in the active tab. Use selectors returned by ' +
      'inspect_page. For checkboxes/radios pass true/false; for dropdowns pass ' +
      'the option value or its visible label. Does NOT submit — call click_element for that.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'The fields to fill.',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector from inspect_page.' },
              value: {
                type: ['string', 'boolean', 'number'],
                description: 'Value to set (true/false for checkbox/radio).',
              },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture a screenshot of the current page so you can SEE its visual state — ' +
      'use it when an action didn’t work, when you’re unsure what’s on screen, or to ' +
      'decide your next step. It shows the page visually but NOT click coordinates, so ' +
      'pair it with inspect_page to get the selectors you can act on.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'marked_screenshot',
    description:
      'Screenshot with EVERY clickable element boxed and tagged with a number (Set-of-Mark). ' +
      'This is the most reliable way to find what to click — especially on visually complex pages ' +
      'or canvas-app toolbars (e.g. Excalidraw’s pencil). Read the numbers, then call click_mark {n}. ' +
      'Prefer this over guessing click_at coordinates.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'click_mark',
    description:
      'Click the numbered element from the most recent marked_screenshot — exactly at its box, ' +
      'no coordinates needed. Call marked_screenshot first to get the numbers.',
    parameters: {
      type: 'object',
      properties: { n: { type: 'number', description: 'The mark number to click.' } },
      required: ['n'],
    },
  },
  {
    name: 'click_element',
    description:
      'Click a button or link in the active tab (e.g. submit, next, add). Use a ' +
      'selector from inspect_page. Returns the clicked element’s text.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill_combobox',
    description:
      'Fill a typeahead / autocomplete field where you must SELECT a suggestion from ' +
      'a dropdown — city / airport / destination pickers (e.g. Expedia “Where to?”), ' +
      '@-mentions, country selectors. Types the value, waits for the dropdown, and ' +
      'clicks the matching suggestion. Use THIS instead of fill_form whenever a field ' +
      'shows live suggestions or rejects typed text with “please select…”. Most ' +
      'reliable with High-reliability page control on.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input (from inspect_page).' },
        value: { type: 'string', description: 'Text to type, e.g. a city name.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'click_by_text',
    description:
      "Click a button or link by its visible text / accessible name when you don't " +
      'have a reliable selector — e.g. a "Search" or "Submit" button on a complex app. ' +
      'Matches case-insensitively (exact, then prefix, then substring). Optionally ' +
      'restrict to a role. Prefer this over guessing a selector for action buttons.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text / accessible name to match.' },
        role: {
          type: 'string',
          enum: ['button', 'link', 'any'],
          description: 'Restrict the match (default any).',
        },
      },
      required: ['text'],
    },
  },
  // ---- Vision / coordinate "computer use" tools (CDP / High-reliability only) ----
  {
    name: 'click_at',
    description:
      'Click at viewport pixel coordinates — for CANVAS apps (Sheets, Excalidraw, Figma) or anything with no DOM selector. ' +
      'Take a screenshot first; aim within the viewport size it reports. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text at the CURRENT focus (after a click_at) using real keystrokes. Needs High-reliability mode.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'press_key',
    description:
      'Press one key or a modifier CHORD. Single keys: Enter, Tab, Escape, Backspace, Delete, ' +
      'Home, End, Space, Arrow{Up,Down,Left,Right}, a letter, or a digit. Chords use "+": e.g. ' +
      '"Shift+1" (Excalidraw zoom-to-fit), "Cmd+A"/"Ctrl+A" (select all), "Ctrl+Enter". ' +
      'Needs High-reliability mode.',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page vertically by `dy` pixels (positive = down). Returns `movedBy` and ' +
      '`atBottom` — when `atBottom` is true you have reached the end, so STOP scrolling. ' +
      'Prefer one large scroll (about a full viewport, e.g. 800–1000) over many small ones. ' +
      'Needs High-reliability mode.',
    parameters: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] },
  },
  {
    name: 'draw_path',
    description:
      'Draw a freehand stroke by dragging the mouse through a path of viewport points (button held) — e.g. the ' +
      'Excalidraw pencil. Select the pencil/tool first with click_at, then call this with ordered points. ' +
      'Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          description: 'Ordered path points in viewport pixels.',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
      },
      required: ['points'],
    },
  },
];

// Keep tool results small — the model re-reads them every step, and a big form
// page can have dozens of fields. Trim option lists and string lengths.
function compactInspect(r) {
  const fields = (r.fields || []).map((f) => {
    const out = {
      selector: f.selector,
      type: f.type,
      label: f.label,
      ...(f.required ? { required: true } : {}),
      value: f.value,
    };
    if (f.options) out.options = f.options.slice(0, 30);
    return out;
  });
  return {
    url: r.url,
    title: r.title,
    fields: fields.slice(0, 80),
    buttons: (r.buttons || []).filter((b) => b.text).slice(0, 30),
    links: (r.links || []).slice(0, 60),
  };
}

// Build an executor bound to a specific tab. Returns async (name, input) → JSON
// string (what the model sees back). Errors are returned, not thrown, so the
// model can recover (retry a different selector) instead of the turn aborting.
//
// `cdp` selects the action backend for fill/click: true → trusted events via
// chrome.debugger (high-reliability mode), false → synthetic events via
// chrome.scripting. Reading (inspect) always uses scripting. If a CDP action
// fails for a reason that the scripting path could still handle (e.g. the
// debugger couldn't attach), we fall back rather than fail the turn.
// Chrome forbids ALL automation (debugger AND scripting) on pages it won't let
// extensions touch: chrome:// pages, the Web Store, PDFs, and pages owned by
// OTHER extensions (e.g. a New-Tab override). Both CDP and synthetic fail the
// same way, so detect it and return a clear message instead of a cryptic error
// plus a pointless synthetic retry.
// Match ONLY genuine "this page is off-limits" errors — NOT the injectError
// boilerplate ("…Chrome blocks scripting some pages (chrome://, the Web Store…)"),
// which would otherwise mislabel every ordinary failure as "blocked".
const BLOCKED_PAGE_RE = /cannot access (a chrome|contents)|cannot be scripted|extensions gallery/i;
const blockedPageResult = () =>
  JSON.stringify({
    error:
      "This page can’t be automated — it’s a browser page, the Web Store, a PDF, or another extension’s page (e.g. a New-Tab override). Switch to a normal website tab and try again.",
    blocked: true,
  });

export function makePageToolExecutor(tabId, { cdp = false, adapter = null } = {}) {
  const doFill = cdp ? cdpFillForm : fillForm;
  const doClick = cdp ? cdpClickElement : clickElement;
  const doClickText = cdp ? cdpClickByText : clickByText;
  const doCombobox = cdp ? cdpFillCombobox : fillCombobox;
  let lastMarks = []; // Set-of-Mark from the latest marked_screenshot (for click_mark)
  // A result is "trouble" if it errored, didn't take, or couldn't be confirmed.
  const resultIndicatesError = (r) =>
    !!r && typeof r === 'object' && (r.error != null || r.ok === false || r.verified === false || r.blocked);

  // Coordinate / "computer use" actions return TEXT only on success — NO per-step
  // screenshot (cheap, and non-vision models can operate). Strategy (see
  // PAGE_AUTOMATION_SYSTEM): PLAN → act from text results → validate at the END.
  // BUT if an action REPORTS A PROBLEM, validation kicks in immediately: attach a
  // screenshot so the model can SEE the state and recover — a later step failing
  // usually means an EARLIER step went wrong.
  const actionResult = async (resultObj) => {
    if (!resultIndicatesError(resultObj)) return JSON.stringify(resultObj);
    const image = await screenshot(tabId, cdp).catch(() => null);
    if (!image) return JSON.stringify(resultObj);
    const vp = await viewportInfo(tabId);
    return {
      text: JSON.stringify({
        ...resultObj,
        note: 'This step reported a PROBLEM — screenshot attached. Validate before continuing: a later step failing usually means an EARLIER step went wrong. Re-check from the last known-good state instead of blindly pushing on.',
      }),
      image: await annotateGrid(image, vp),
    };
  };
  return async function execute(name, input) {
    try {
      // Structured-editor adapter (e.g. Excalidraw): insert the app's native data
      // in one shot instead of pixel-driving. Only present when the active tab
      // matched an adapter AND the user is entitled (gated where the tool is added).
      if (adapter && adapter.handles(name)) {
        return JSON.stringify(await adapter.run(tabId, name, input, { cdp }));
      }
      if (name === 'inspect_page') {
        return JSON.stringify(compactInspect(await inspectForms(tabId)));
      }
      if (name === 'marked_screenshot') {
        const image = await screenshot(tabId, cdp);
        if (!image) return JSON.stringify({ error: 'Could not capture a screenshot — bring the tab to the front, or enable High-reliability mode.' });
        const vp = await viewportInfo(tabId);
        lastMarks = await collectMarks(tabId);
        const marked = await annotateMarks(image, lastMarks, vp);
        const legend = lastMarks.map((m, i) => `${i + 1}:${m.label || m.role}`).join(' · ');
        return {
          text: JSON.stringify({
            ok: true,
            count: lastMarks.length,
            legend,
            note: 'Each clickable element is boxed with a number. Call click_mark {n} to click one EXACTLY — no coordinates needed.',
          }),
          image: marked,
        };
      }
      if (name === 'click_mark') {
        const n = Number(input?.n);
        const m = lastMarks[n - 1];
        if (!m) return JSON.stringify({ error: `No mark ${n}. Call marked_screenshot first, then use a number from it.` });
        try {
          if (cdp) return actionResult({ ...(await cdpClickAt(tabId, m.x, m.y)), label: m.label });
          return JSON.stringify({ ...(await clickAtSynthetic(tabId, m.x, m.y)), label: m.label });
        } catch (e) {
          if (BLOCKED_PAGE_RE.test(e.message)) return blockedPageResult();
          throw e;
        }
      }
      if (name === 'screenshot') {
        const image = await screenshot(tabId, cdp);
        if (!image) {
          return JSON.stringify({
            error:
              'Could not capture a screenshot — the tab may be in the background. Bring it to the front, or enable High-reliability mode (CDP can shoot background tabs).',
          });
        }
        // Return BOTH text and the image; the provider loop feeds the image to the model.
        const vp = await viewportInfo(tabId);
        const gridded = await annotateGrid(image, vp); // labelled coordinate grid → accurate clicks
        return {
          text: JSON.stringify({
            ok: true,
            viewport: vp ? { w: vp.w, h: vp.h } : undefined,
            note: `Screenshot attached WITH a red coordinate grid (labels are viewport pixels). READ the grid to pick click_at/draw_path coordinates — do not guess. Aim within 0..${
              vp?.w ?? '?'
            } × 0..${vp?.h ?? '?'}. For ordinary forms, inspect_page gives selectors.`,
          }),
          image: gridded,
        };
      }
      // Coordinate / "computer use" tools — CDP-only (need trusted events). Their
      // result is purely VISUAL, and weak models won't screenshot on their own, so
      // we ATTACH a fresh screenshot of the result — this is what lets the model
      // SEE its mistake (a misplaced stroke) and self-correct.
      if (['click_at', 'type_text', 'press_key', 'scroll', 'draw_path'].includes(name)) {
        if (!cdp) {
          return JSON.stringify({
            error: 'This needs High-reliability page control (trusted events) — turn it on in Settings → page control.',
          });
        }
        // Scroll is cheap and self-reporting (returns movedBy/atBottom), so skip
        // the costly per-step screenshot here — the model stops on atBottom. The
        // other coordinate tools are visual-only, so they keep the result shot.
        if (name === 'scroll') return JSON.stringify(await cdpScroll(tabId, undefined, undefined, input?.dy));
        let r;
        if (name === 'click_at') r = await cdpClickAt(tabId, input?.x, input?.y);
        else if (name === 'type_text') r = await cdpTypeText(tabId, input?.text);
        else if (name === 'press_key') r = await cdpPressKey(tabId, input?.key);
        else r = await cdpDrag(tabId, input?.points);
        return actionResult(r);
      }
      if (name === 'fill_form') {
        const fields = input?.fields || [];
        let results;
        let mode = cdp ? 'trusted' : 'synthetic';
        try {
          results = await doFill(tabId, fields);
        } catch (e) {
          if (cdp && e.code === 'no-debugger-perm') throw e; // surface, don't silently downgrade
          if (BLOCKED_PAGE_RE.test(e.message)) return blockedPageResult(); // synthetic fails too
          if (cdp) {
            // CDP couldn't attach/run — fall back, but make it LOUD so we can see it.
            console.warn('[chatpanel] CDP fill failed, falling back to synthetic:', e.message);
            results = await fillForm(tabId, fields);
            mode = 'synthetic (CDP failed: ' + e.message + ')';
          } else throw e;
        }
        const applied = results.filter((r) => r.applied !== false && r.ok).length;
        return JSON.stringify({ filled: applied, total: results.length, mode, results });
      }
      if (name === 'click_element') {
        try {
          return JSON.stringify(await doClick(tabId, input?.selector));
        } catch (e) {
          if (BLOCKED_PAGE_RE.test(e.message)) return blockedPageResult();
          if (cdp && e.code !== 'no-debugger-perm') {
            console.warn('[chatpanel] CDP click failed, falling back to synthetic:', e.message);
            return JSON.stringify({ ...(await clickElement(tabId, input?.selector)), mode: 'synthetic (CDP failed: ' + e.message + ')' });
          }
          throw e;
        }
      }
      if (name === 'fill_combobox') {
        try {
          return JSON.stringify(await doCombobox(tabId, input?.selector, input?.value));
        } catch (e) {
          if (BLOCKED_PAGE_RE.test(e.message)) return blockedPageResult();
          if (cdp && e.code !== 'no-debugger-perm') {
            console.warn('[chatpanel] CDP fill_combobox failed, falling back to synthetic:', e.message);
            return JSON.stringify({ ...(await fillCombobox(tabId, input?.selector, input?.value)), mode: 'synthetic (CDP failed: ' + e.message + ')' });
          }
          throw e;
        }
      }
      if (name === 'click_by_text') {
        try {
          return JSON.stringify(await doClickText(tabId, input?.text, input?.role || 'any'));
        } catch (e) {
          if (BLOCKED_PAGE_RE.test(e.message)) return blockedPageResult();
          if (cdp && e.code !== 'no-debugger-perm') {
            console.warn('[chatpanel] CDP click_by_text failed, falling back to synthetic:', e.message);
            return JSON.stringify({ ...(await clickByText(tabId, input?.text, input?.role || 'any')), mode: 'synthetic (CDP failed: ' + e.message + ')' });
          }
          throw e;
        }
      }
      return JSON.stringify({ error: `unknown tool: ${name}` });
    } catch (e) {
      // Surface Pro-gate distinctly so the UI can upsell rather than show a raw error.
      return JSON.stringify({ error: e.message, upsell: e.upsell || undefined });
    }
  };
}
