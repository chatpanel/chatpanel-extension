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
  readAxTree,
  cdpFillForm, cdpClickElement, cdpClickByText, cdpFillCombobox, cdpScreenshot,
  cdpClickAt, cdpMoveMouse, cdpTypeText, cdpPressKey, cdpScroll, cdpDrag, cdpInputSequence,
  cdpCapturePointer, cdpEvaluate,
} from './page-actions-cdp.js';
import { SENSE_TOOL_SPECS, makeSenseExecutor } from './page-sense.js';
import { CALIBRATE_TOOL_SPEC, calibrateTurn } from './page-calibrate.js';

// Harness guidance folded into the system prompt when page tools are armed.
// Structured numbered loop (it gave the best drawing results) — keep it explicit,
// but the hard rule overriding everything is step 4/6: judge "done" from the
// SCREENSHOT, never from your plan, and never fabricate a result.
export const PAGE_AUTOMATION_SYSTEM =
  'USE ONLY the ChatPanel browser tools provided here (read_page, inspect_page, screenshot, ' +
  'read_canvas, structured_insert, click_element, click_by_text, click_at, type_text, press_key, ' +
  'fill_form, scroll, …) to see and act on this page — they are the ONLY tools connected to the ' +
  'user’s real, logged-in browser tab.\n' +
  // READING IS A FIRST-CLASS USE OF THIS TAB, and it was missing from the list above — every
  // tool named was an ACTION tool, so a model asked to summarise an article found nothing here
  // for reading and reached for its own fetch. In a real log: 40 screenshots and 10 read_page
  // calls, plus minute-long turns that made no ChatPanel call at all.
  'TO READ WHAT THE PAGE SAYS — an article, thread, comments, a document — call read_page. One ' +
  'call returns the body as text with nav and ads stripped, so it replaces a scroll-and-' +
  'screenshot loop.\n' +
  'DO NOT FETCH THE URL. Fetching, web-search, or any "read this link" tool of your own gets a ' +
  'DIFFERENT page from the one the user is looking at: not logged in, not rendered, often a ' +
  'login wall, a paywall or raw HTML — which is why those calls fail. This tab is already open, ' +
  'authenticated and rendered; read_page reads THAT. Screenshots are for when the LAYOUT matters, ' +
  'never for reading text.\n' +
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
  '3b) BEYOND LEFT-CLICK. Your input vocabulary is wider than a tap: click_at takes ' +
  '`button:"right"|"middle"` and `clicks:2`; press_key takes `holdMs` to HOLD a key down; move_mouse ' +
  'aims without pressing, absolutely {x,y} or as a relative turn {dx,dy}; draw_path drags with any ' +
  'button. Never report an action as impossible because a single left-click can’t do it — check these ' +
  'first. Common conventions across apps: right-click = secondary/context action, double-click = open ' +
  'or select-word, held key = a continuous action (move, sprint, pan), drag = draw or reposition.\n' +
  '3c) COMBINATIONS. Real apps need inputs held TOGETHER, which no single-shot tool can express — use ' +
  'input_sequence for those: a modifier held across a click or drag (Shift+drag to constrain, Ctrl+click ' +
  'to multi-select), Space held while dragging to pan, two direction keys at once for diagonal movement, ' +
  'a button held while the view turns. It releases everything at the end, so prefer ONE input_sequence ' +
  'over a fragile string of separate calls whenever the inputs overlap in time.\n' +
  '3d) CANVAS APPS AND GAMES — FIND THE CONTROLS, DON’T ASSUME THEM. A <canvas> exposes no DOM, so ' +
  'inspect_page will look empty; that does NOT mean the app is uncontrollable. Work out its real control ' +
  'scheme BEFORE acting, in this order: (a) if a KNOWN CONTROLS block appears below, start from it; ' +
  '(b) screenshot and read the on-screen UI — toolbars, a legend, a help/“?” overlay, a pause or settings ' +
  'menu often lists the keys; (c) try the app’s own help (press_key "Escape" or "h", or a visible ' +
  'Help/Controls button); (d) if it is still unclear, use web_search for the app or game NAME plus ' +
  '"controls" / "keyboard shortcuts" and follow what you find. State the scheme you are going to use ' +
  'before you drive it, and once you have CONFIRMED it works, call save_app_controls so later turns on ' +
  'this app skip the whole discovery step. Typical desktop conventions worth trying: WASD or the arrow ' +
  'keys to move, Space to jump/confirm, Shift to sprint, Escape to pause or release the pointer, number ' +
  'keys to select a tool or slot, scroll to zoom or cycle, and the two mouse buttons for the primary and ' +
  'secondary action.\n' +
  '3d-i) SENSE, DON’T STARE. A screenshot costs a full round-trip and hands you pixels you then have to ' +
  'interpret; the app’s real state is usually readable EXACTLY and far more cheaply. Before falling back ' +
  'to vision on a canvas app: probe_app_state to find where the app keeps its model, read_app_state to ' +
  'read it, and sense_canvas to get a grid/tile board as characters rather than an image. On a grid game ' +
  '(Snake, chess, puzzles) sense_canvas with cols/rows matching the real board gives you the exact ' +
  'position of everything — use that instead of screenshotting between moves. Keep screenshots for ' +
  'things structure cannot tell you (3D scenes, unknown layouts, final validation).\n' +
  '3d-ii) IN A FIRST-PERSON APP, CALIBRATE BEFORE AIMING. After capture_pointer, call calibrate_turn ' +
  'ONCE: it measures how far a mouse delta actually turns the view and returns viewPixelsPerDelta, so ' +
  'you can COMPUTE the turn that puts a target under the reticle (dx ≈ pixels-off-centre ÷ ' +
  'viewPixelsPerDelta) instead of guessing and re-screenshotting. Also build a mental map before you ' +
  'work: look around and note where you are, what is around you, and whether you are somewhere you can ' +
  'actually act — do not start a construction task while submerged, cornered, or facing empty sky.\n' +
  '3e) PREFER BUILDING OVER MIMING. Simulated input is the LAST resort, not the first. If the app can be ' +
  'given its content directly — a structured_insert tool offered for this page, an import/paste-JSON or ' +
  '“edit as code/source” panel, a command palette, a text or formula field, a URL that encodes state — ' +
  'construct the result in the app’s OWN language and hand it over in one step. That is exact, ' +
  'verifiable, and immune to a misplaced pixel; dozens of synthesized clicks and drags are none of those. ' +
  'Drive by pointer only when the app genuinely offers no data path in — a game, or a canvas with no ' +
  'import.\n' +
  '3f) FIRST-PERSON / 3D APPS — CAPTURE THE POINTER BEFORE YOU AIM. These apps only turn the view while ' +
  'they hold POINTER LOCK, and they can only take it from a click on a focused page — which is NOT the ' +
  'default here. Until they hold it, movement keys and clicks appear to work while mouse-look does ' +
  'nothing at all, so every aim attempt silently fails and you cannot line anything up. The order is: ' +
  '(1) screenshot — if it reports `canvasApp` without `pointerLock`, or a move_mouse {dx,dy} comes back ' +
  'with a pointerLock:false warning, you are in this state; (2) clear any splash / menu / “click to ' +
  'play” overlay; (3) call capture_pointer and CHECK it — it verifies the app really took the pointer; ' +
  '(4) only now aim with move_mouse {dx, dy}, re-screenshotting to see where you point.\n' +
  '3g) ONCE CAPTURED, coordinates stop meaning anything: click_at x/y is IGNORED and the app acts at its ' +
  'reticle (viewport centre). Clicking different coordinates changes NOTHING — that is why an action can ' +
  '“succeed” with no visible effect. AIM with move_mouse {dx, dy} until the target sits under the ' +
  'reticle, confirm on a screenshot, THEN click. If a click reports pointerLock:true, do not retry it at ' +
  'new coordinates — turn first. Escape releases the lock and restores ordinary coordinate clicking.\n' +
  '3h) IF TWO ATTEMPTS AT A PHYSICAL ACTION CHANGE NOTHING ON SCREEN, STOP AND RE-DIAGNOSE — do not ' +
  'keep varying coordinates. Ask what STATE you are in rather than what to click: is the pointer ' +
  'captured; is a menu or splash swallowing input; is the app paused; is your avatar stuck, submerged, ' +
  'or facing a surface that cannot be acted on. Fix the state (capture the pointer, close the overlay, ' +
  'move somewhere workable) before repeating the action. Report the state you were stuck in, not just ' +
  'that it failed.\n' +
  '4) VALIDATE — at the END, and EARLY on any failure. When the checklist is complete, take ONE ' +
  'screenshot and check every item against what is on screen. A tool replying "ok"/"verified" means ' +
  'the action LANDED — the end screenshot (or a tool’s verified:true) is your proof the GOAL is met. ' +
  'But if a tool result reports an error, or a later step won’t act as expected, STOP and validate ' +
  'THEN — a later failure usually means an EARLIER step went wrong, so re-check from there instead of ' +
  'pushing on. (No vision? Rely on the tools’ verified results and report exactly what they say.)\n' +
  '5) SUBMIT LAST. Never click Submit/Save/Send/Pay/Confirm until the end screenshot — or the tool’s ' +
  'verified result — confirms EVERY checklist item. If unsure, ask the user instead.\n' +
  '5a) ADAPT — DON’T HARDCODE, EXPLORE. Web UIs change (menus move, apps update, layouts differ), so ' +
  'never assume a fixed path and never fire the SAME failing call again. When a tool errors or you ' +
  'can’t find a control: (a) inspect_page for the real selectors, (b) screenshot to see the current ' +
  'layout, and (c) use the app’s OWN search / command palette to locate an action by NAME — many apps ' +
  'have a “/” or ⌘K box (e.g. draw.io’s “Type / to search” finds “Edit Diagram”). Try a DIFFERENT route ' +
  'each attempt (another selector, the search box, a keyboard shortcut). If two varied attempts fail, ' +
  'STOP, report what you tried and saw, and ask the user — do not loop on the identical action.\n' +
  '6) BE HONEST when a tool reports FAILURE (e.g. structured_insert verified:false): say so plainly ' +
  'and stop — do NOT silently switch to a flailing pixel-drawing fallback. You have NO ' +
  'image-generation tool and cannot fetch/export images: never claim you generated or exported one. ' +
  'Never invent selectors — use only ones from inspect_page.\n' +
  '7) MEETING CONTROLS are just ordinary on-page buttons. If the user asks to end/leave the call, ' +
  'mute/unmute, or turn the camera on/off in Google Meet / Zoom / Teams / Webex, do it by CLICKING the ' +
  'real control on the page (inspect_page or click_by_text for “Leave call”/“End call”/“Mute”/“Turn off ' +
  'camera”, or click_at on the toolbar icon). There is no separate meeting API and you do NOT need one — ' +
  'never claim “meeting/browser controls are unavailable”; treat the meeting UI like any other web page.';

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
    name: 'read_page',
    description:
      'READ the page as text — the article, thread, comments, or document body, with '
      + 'scripts, nav and ads stripped. Returns far more than a screenful, so ONE call '
      + 'usually replaces a whole scroll-and-screenshot loop. Use this whenever the task '
      + 'is to read, summarise, quote or answer questions about what the page SAYS. '
      + 'Screenshots are for when the LAYOUT matters (charts, canvases, where a control '
      + 'sits); they are a poor and expensive way to read text.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Cap on returned characters (default 40000).' },
      },
      required: [],
    },
  },
  {
    name: 'inspect_page',
    description:
      "Read the active browser tab's interactive elements: fillable form fields, " +
      'clickable buttons, AND links (anchors), plus an `accessibility` list of every ' +
      'named control with its role and state (what a screen reader sees). PREFER acting ' +
      'by NAME from that list — click_by_text with the name — over estimating pixel ' +
      'coordinates; the browser already knows where things are. Returns each with a stable `selector` ' +
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
      'Click at viewport pixel coordinates — for CANVAS apps (Sheets, Excalidraw, Figma), games, or anything with no DOM selector. ' +
      'Take a screenshot first; aim within the viewport size it reports. Pass `button:"right"` for the ' +
      'secondary / context-menu action, or `clicks:2` for a double-click (open an item, select a word). ' +
      'If the screenshot reports `pointerLock`, coordinates are ignored — aim with move_mouse {dx,dy} first. ' +
      'Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default left).',
        },
        clicks: { type: 'number', description: '1 = single (default), 2 = double-click.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'move_mouse',
    description:
      'Move the pointer WITHOUT clicking. Absolute {x, y} to hover a spot — opening a hover-only menu, ' +
      'revealing a tooltip, previewing under the cursor. Relative {dx, dy} to TURN — this is the only ' +
      'mode a pointer-locked app (first-person view, 3D canvas) understands: positive dx looks right, ' +
      'positive dy looks down. When a screenshot reports pointerLock, aim with {dx, dy} and re-screenshot ' +
      'to check before clicking. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute viewport x. Use with y.' },
        y: { type: 'number', description: 'Absolute viewport y. Use with x.' },
        dx: { type: 'number', description: 'Relative turn, pixels right. Use with dy.' },
        dy: { type: 'number', description: 'Relative turn, pixels down. Use with dx.' },
      },
      required: [],
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
      'Pass `holdMs` to HOLD the key down for that long instead of tapping it — that is how you drive any ' +
      'continuous, press-and-hold control: moving or panning (key:"w", holdMs:800), sprinting ("Shift+w"), ' +
      'charging an action. ' +
      'Max hold is 5000ms; the key is always released. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        holdMs: {
          type: 'number',
          description: 'Hold the key down this many ms (max 5000). Omit for a normal tap.',
        },
      },
      required: ['key'],
    },
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
    name: 'capture_pointer',
    description:
      'Give a first-person / 3D canvas app control of the mouse, so mouse-look works. Such apps only ' +
      'turn the view once they hold POINTER LOCK, and they can only take it from a click on a FOCUSED ' +
      'page — which is not the default when driving from the side panel. Symptom you are missing this: ' +
      'keys work and clicks land, but the view never turns and aiming changes nothing. Call this BEFORE ' +
      'aiming, and check the result: it verifies the app actually took the pointer rather than assuming. ' +
      'Not needed for flat canvas apps (whiteboards, editors, board games) — those take normal ' +
      'coordinate clicks. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Optional click point; defaults to the canvas centre.' },
        y: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'input_sequence',
    description:
      'Perform several inputs together, with things held DOWN across each other — the only way to express ' +
      'a combination: Shift held while dragging (constrain), Space held while dragging (pan), two direction ' +
      'keys at once (diagonal movement), a modifier held across a click (multi-select), a mouse button held ' +
      'while the view turns. Steps run in order and everything still held is released at the end, so you ' +
      'never have to unwind it yourself. Step types: ' +
      '{type:"key_down"|"key_up", key} (key may be a modifier: shift/ctrl/alt/meta), ' +
      '{type:"mouse_down"|"mouse_up", button}, ' +
      '{type:"move", dx, dy} relative or {type:"move", x, y} absolute, ' +
      '{type:"type", text}, {type:"wait", ms}. ' +
      'Example — Shift-constrained drag: [{"type":"key_down","key":"shift"},{"type":"mouse_down","button":"left"},' +
      '{"type":"move","dx":120,"dy":0},{"type":"mouse_up","button":"left"},{"type":"key_up","key":"shift"}]. ' +
      'Page actions ALSO work as steps, in the same {action, args} form used elsewhere: ' +
      '{"action":"click_at","args":{"x":500,"y":550}}, {"action":"drag_at","args":{"x":500,"y":550,"toX":700,"toY":550}}, ' +
      '{"action":"press_key","args":{"key":"Enter"}}, {"action":"type_text","args":{"text":"hi"}} — ' +
      'use these if the primitives are awkward. ' +
      'Max 40 steps. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered input steps.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['key_down', 'key_up', 'mouse_down', 'mouse_up', 'move', 'type', 'wait'],
              },
              key: { type: 'string', description: 'For key_down/key_up.' },
              button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'For mouse_down/mouse_up.' },
              x: { type: 'number' },
              y: { type: 'number' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              text: { type: 'string', description: 'For type.' },
              ms: { type: 'number', description: 'For wait.' },
            },
            required: ['type'],
          },
        },
      },
      required: ['steps'],
    },
  },
  ...SENSE_TOOL_SPECS,
  CALIBRATE_TOOL_SPEC,
  {
    // THE MISSING PRIMITIVE.
    //
    // Three separate runs tried to draw a shape with click_at — once, then twice, then a
    // hand-built input_sequence — and each time reported success having drawn nothing. The
    // model was not being stupid: to draw, it had `draw_path` (an ordered points array) and
    // `input_sequence` (compose it yourself from mouse_down and moves). Neither is the
    // obvious thing to reach for, and click_at was. A tool nobody reaches for is a tool
    // that does not exist, so the simplest drag is now its own action.
    name: 'drag_at',
    description:
      'Drag from one point to another with the button held — how you DRAW a shape, resize '
      + 'one, or select a region on a canvas. A single click_at does NOT draw: shapes '
      + '(rectangle, ellipse, line, arrow) are sized by dragging from one corner to the '
      + 'other. Select the tool first, then drag. Returns how far it actually travelled.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Start X, viewport pixels.' },
        y: { type: 'number', description: 'Start Y, viewport pixels.' },
        toX: { type: 'number', description: 'End X, viewport pixels.' },
        toY: { type: 'number', description: 'End Y, viewport pixels.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Button to hold (default left).' },
      },
      required: ['x', 'y', 'toX', 'toY'],
    },
  },
  {
    name: 'draw_path',
    description:
      'Draw a freehand stroke by dragging the mouse through a path of viewport points (button held) — e.g. the ' +
      'Excalidraw pencil. Select the pencil/tool first with click_at, then call this with ordered points. ' +
      'Pass `button:"right"` to drag with the secondary button. Needs High-reliability mode.',
    parameters: {
      type: 'object',
      properties: {
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Button to hold during the drag (default left).',
        },
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

// Developer-only. NOT part of PAGE_TOOL_SPECS: the caller adds it explicitly, and
// only when the developer setting is on (see sidepanel.js `pageToolProvider`), so
// an ordinary session never even sees that it exists.
export const EVAL_JS_TOOL_SPEC = {
  name: 'eval_js',
  description:
    'Run JavaScript in the page and return its value. Use this only when reading or driving the app ' +
    'through its own code is genuinely better than the input tools — reading exact state that ' +
    'read_app_state cannot reach, or installing a fast in-page control loop for a real-time app that a ' +
    'per-action round-trip is too slow for. The expression\'s value is returned (promises are awaited). ' +
    'The user must approve EVERY call and sees your exact code, so keep it short, single-purpose, and ' +
    'obviously safe to read. Never use it to read credentials, tokens, cookies, or personal data, and ' +
    'never to send data anywhere.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
      timeoutMs: { type: 'number', description: 'Give up after this long (default 5000).' },
    },
    required: ['code'],
  },
};

// Keep tool results small — the model re-reads them every step, and a big form
// page can have dozens of fields. Trim option lists and string lengths.
/**
 * The page as readable text.
 *
 * Reading and acting are different capabilities, and only acting is risky. Without this
 * the only way to READ a page was to screenshot it and scroll — which cost a vision call
 * per screenful, missed anything off-screen, and dragged a read-only question through the
 * action path. A real run spent seven actions (three screenshots, three scrolls, a failed
 * PageDown) to read one Hacker News thread that this returns in a single call.
 *
 * Runs in the page, returns only text: no DOM, no scripts, nothing executable.
 */
async function readPageText(tabId, maxChars) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (cap) => {
      const drop = 'script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,[aria-hidden="true"]';
      // Prefer the semantic content root when the page offers one; a thread or article
      // page then loses its chrome without guessing.
      const root = document.querySelector('main, article, [role="main"]') || document.body;
      const clone = root.cloneNode(true);
      for (const el of clone.querySelectorAll(drop)) el.remove();
      const text = (clone.innerText || clone.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return {
        title: document.title || '',
        url: location.href,
        chars: text.length,
        truncated: text.length > cap,
        text: text.slice(0, cap),
      };
    },
    args: [maxChars],
  });
  return res?.result || { error: 'Could not read this page (restricted or empty).' };
}

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

export function makePageToolExecutor(tabId, { cdp = false, adapter = null, devJs = false } = {}) {
  const doFill = cdp ? cdpFillForm : fillForm;
  const doClick = cdp ? cdpClickElement : clickElement;
  const doClickText = cdp ? cdpClickByText : clickByText;
  const doCombobox = cdp ? cdpFillCombobox : fillCombobox;
  const sense = makeSenseExecutor(tabId); // deterministic reads; returns null if not its tool
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
      // Deterministic sensing (sense_canvas / probe_app_state / read_app_state).
      // Read-only and CDP-independent — an app's own state is readable whether or
      // not trusted events are on.
      {
        const sensed = await sense(name, input);
        if (sensed !== null) return JSON.stringify(sensed);
      }
      if (name === 'eval_js') {
        // Second, independent gate. The spec is only offered when the developer
        // setting is on; this refuses even if a caller somehow asks anyway, so
        // the capability can never be reached by a model that was handed a stale
        // or hand-written tool list.
        if (!devJs) {
          return JSON.stringify({
            error: 'Running JavaScript in the page is a developer-only feature and is turned OFF. Use the ' +
              'regular page tools (read_app_state, sense_canvas, click_at, …) instead.',
          });
        }
        if (!cdp) {
          return JSON.stringify({
            error: 'This needs High-reliability page control (trusted events) — turn it on in Settings → page control.',
          });
        }
        const r = await cdpEvaluate(tabId, input?.code, { timeoutMs: input?.timeoutMs });
        return JSON.stringify(r);
      }
      if (name === 'calibrate_turn') {
        if (!cdp) {
          return JSON.stringify({
            error: 'This needs High-reliability page control (trusted events) — turn it on in Settings → page control.',
          });
        }
        const vp = await viewportInfo(tabId);
        return JSON.stringify(await calibrateTurn(tabId, { delta: input?.delta, viewportWidth: vp?.w }));
      }
      if (name === 'read_page') {
        return JSON.stringify(await readPageText(tabId, Number(input?.maxChars) || 40000));
      }
      if (name === 'inspect_page') {
        const dom = compactInspect(await inspectForms(tabId));
        // The accessibility tree alongside the DOM inspection, when CDP is available.
        // Names and roles are what a small model can actually aim with — it guessed pixel
        // coordinates twice, drew nothing, and reported success. Best-effort: a page
        // without a tree (or a stripped build) still gets the DOM answer it always got.
        if (cdp) {
          try {
            const ax = await readAxTree(tabId);
            if (ax?.nodes?.length) return JSON.stringify({ ...dom, accessibility: ax.nodes, axTruncated: ax.truncated });
          } catch { /* fall through to the DOM-only answer */ }
        }
        return JSON.stringify(dom);
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
        // Under pointer lock the grid is a trap — coordinates do nothing — so say
        // so instead of inviting the model to read pixels off it.
        const grid = `Screenshot attached WITH a red coordinate grid (labels are viewport pixels). READ the grid to pick click_at/draw_path coordinates — do not guess. Aim within 0..${
          vp?.w ?? '?'
        } × 0..${vp?.h ?? '?'}. For ordinary forms, inspect_page gives selectors.`;
        let note;
        if (vp?.pointerLock) {
          // Under lock the grid is a trap — coordinates do nothing.
          note = `Screenshot attached. This page holds POINTER LOCK: click_at coordinates are IGNORED and the app acts at its reticle (centre, about ${Math.round((vp.w || 0) / 2)},${Math.round((vp.h || 0) / 2)}). Do NOT pick coordinates off the grid. AIM by turning the view with move_mouse {dx, dy} (positive dx = right, positive dy = down), re-screenshot to see where you are pointing, then click_at. Press Escape to release the lock and get normal coordinate clicking back.`;
        } else if (vp?.canvasApp) {
          // The state that silently defeats aiming: a canvas app that has NOT taken
          // the pointer. Movement keys work, clicks land, the view never turns.
          note = `${grid}\nNOTE: this page is dominated by a <canvas> and does NOT currently hold the pointer. If it is a first-person / 3D app, mouse-look will do NOTHING until you call capture_pointer (it focuses the tab and clicks the canvas, which is what lets the app take the pointer). Do that BEFORE trying to aim with move_mouse {dx, dy}. If instead this is a flat canvas app (a whiteboard, a board game, an editor), ignore this and click coordinates normally.`;
        } else {
          note = grid;
        }
        return {
          text: JSON.stringify({
            ok: true,
            viewport: vp ? { w: vp.w, h: vp.h } : undefined,
            pointerLock: vp?.pointerLock || undefined,
            canvasApp: vp?.canvasApp || undefined,
            note,
          }),
          image: gridded,
        };
      }
      // Coordinate / "computer use" tools — CDP-only (need trusted events). Their
      // result is purely VISUAL, and weak models won't screenshot on their own, so
      // we ATTACH a fresh screenshot of the result — this is what lets the model
      // SEE its mistake (a misplaced stroke) and self-correct.
      if (['click_at', 'drag_at', 'move_mouse', 'type_text', 'press_key', 'scroll', 'draw_path', 'input_sequence', 'capture_pointer'].includes(name)) {
        if (!cdp) {
          return JSON.stringify({
            error: 'This needs High-reliability page control (trusted events) — turn it on in Settings → page control.',
          });
        }
        // Scroll is cheap and self-reporting (returns movedBy/atBottom), so skip
        // the costly per-step screenshot here — the model stops on atBottom. The
        // other coordinate tools are visual-only, so they keep the result shot.
        if (name === 'scroll') return JSON.stringify(await cdpScroll(tabId, undefined, undefined, input?.dy));
        // move_mouse is likewise cheap and non-committal (hover / aim), and is
        // often called several times in a row to steer — don't pay for a
        // screenshot on each one; the model shoots when it wants to look.
        if (name === 'move_mouse') {
          return JSON.stringify(await cdpMoveMouse(tabId, {
            x: input?.x, y: input?.y, dx: input?.dx, dy: input?.dy,
          }));
        }
        // capture_pointer's outcome is invisible in a screenshot (the view looks
        // identical whether or not the app took the pointer), so its verified
        // text result is the whole point — don't spend a shot on it.
        if (name === 'capture_pointer') {
          return JSON.stringify(await cdpCapturePointer(tabId, { x: input?.x, y: input?.y }));
        }
        let r;
        // Two points, button held the whole way — cdpDrag already walks the pointer between
        // them, which is what a canvas needs to size a shape. This is a NAME for something
        // the engine could always do; the absence of the name is what sent three runs to
        // click_at instead.
        if (name === 'drag_at') {
          // WALKED, not jumped. cdpDrag moves point-to-point, so handing it two points
          // presses, makes ONE jump, and releases — which a canvas reads as a click that
          // happened to end elsewhere. Excalidraw, Figma and tldraw all size a shape from
          // the intermediate pointermoves, so the path is filled in here.
          const x0 = Number(input?.x); const y0 = Number(input?.y);
          const x1 = Number(input?.toX); const y1 = Number(input?.toY);
          if (![x0, y0, x1, y1].every(Number.isFinite)) {
            return JSON.stringify({ error: 'drag_at needs {x, y, toX, toY} as numbers.' });
          }
          const HOPS = 12;
          const pts = [{ x: x0, y: y0 }];
          for (let i = 1; i <= HOPS; i++) pts.push({ x: x0 + ((x1 - x0) * i) / HOPS, y: y0 + ((y1 - y0) * i) / HOPS });
          r = await cdpDrag(tabId, pts, input?.button);
          // Report the distance, so "it ran" and "it dragged" stay distinguishable — a
          // zero-length drag is a click, and the result should not let that pass as a draw.
          if (r && r.ok !== false) r.draggedPx = Math.round(Math.hypot(x1 - x0, y1 - y0));
        } else if (name === 'click_at') r = await cdpClickAt(tabId, input?.x, input?.y, input?.button, input?.clicks);
        else if (name === 'type_text') r = await cdpTypeText(tabId, input?.text);
        else if (name === 'press_key') r = await cdpPressKey(tabId, input?.key, input?.holdMs);
        else if (name === 'input_sequence') r = await cdpInputSequence(tabId, input?.steps);
        else r = await cdpDrag(tabId, input?.points, input?.button);
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
