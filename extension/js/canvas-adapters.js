// Canvas / structured-editor adapters.
//
// Some web apps are driven far more reliably by their OWN data format than by
// pixel-level pointer automation (draw_path/click_at). When the active tab is one
// of these, we expose a single `structured_insert` tool whose payload is the
// app's native representation, and inject it directly — one call instead of dozens
// of mouse strokes, and ZERO per-step screenshots (works for non-vision models).
//
// An adapter is:
//   { id, label, toolName,
//     match(hostname) -> boolean,
//     systemGuidance() -> string,   // folded into the page-tools system prompt
//     toolSpec() -> ToolSpec,       // appended to PAGE_TOOL_SPECS for this tab
//     insert(tabId, input, { cdp }) -> Promise<result> }
//
// Gated as a Pro feature (`structuredInsert`) at the point the tool is offered
// (see sidepanel.js `pageToolProvider`), so the spec never reaches a Free client.

import { cdpKeyChord } from './page-actions-cdp.js';

// --------------------------------------------------------------------------
// Excalidraw (excalidraw.com)
// --------------------------------------------------------------------------

const EXCALIDRAW_FORMAT =
  'Provide `elements` as an array of shape skeletons; ChatPanel fills in Excalidraw’s ' +
  'required fields and writes them into the scene at your EXACT coordinates. x,y = the ' +
  'shape’s top-left; y grows downward. Keep a drawing within roughly 0..1000 on both axes.\n' +
  'Supported types and fields:\n' +
  '- rectangle | ellipse | diamond: { type, x, y, width, height, strokeColor?, ' +
  "backgroundColor?, fillStyle? ('solid'|'hachure'|'cross-hatch'), strokeWidth? }\n" +
  '- text: { type:"text", x, y, text, fontSize? (default 20), strokeColor? }\n' +
  '- arrow | line: { type, x, y, points?: [[0,0],[dx,dy],…] relative to x,y; or give ' +
  'width/height for a straight segment; endArrowhead? }\n' +
  "Colors are hex (e.g. '#1e1e1e' stroke, '#a5d8ff' fill) or 'transparent'.\n" +
  'Example — a labeled box, an arrow, and a circle:\n' +
  '[ {"type":"rectangle","x":100,"y":100,"width":160,"height":80,"backgroundColor":"#a5d8ff"},' +
  ' {"type":"text","x":120,"y":130,"text":"Start","fontSize":20},' +
  ' {"type":"arrow","x":270,"y":140,"points":[[0,0],[110,0]]},' +
  ' {"type":"ellipse","x":390,"y":105,"width":90,"height":90,"backgroundColor":"#b2f2bb"} ]\n' +
  'PLAN the whole drawing first, then send ALL elements in ONE call — e.g. a car = a big ' +
  'rounded rectangle body + a smaller rectangle cabin on top + 2 ellipse wheels + 2 small ' +
  'rectangle windows + a small ellipse headlight. One call renders the whole drawing.';

// Runs in the PAGE's MAIN world. Normalizes the skeletons into full Excalidraw
// elements, then either (a) inserts via the app's runtime API if a host exposes
// one (embeds), or (b) MERGES them into localStorage['excalidraw'] — Excalidraw's
// own scene store (confirmed via diagnostics). The caller then reloads the tab so
// Excalidraw hydrates the new scene. Returns a serializable result.
function prepareExcalidraw(payloadJson) {
  try {
    const input = JSON.parse(payloadJson);
    const skeletons = Array.isArray(input.elements) ? input.elements : [];
    if (!skeletons.length) return { ok: false, error: 'no elements provided' };

    const rnd = () => Math.floor(Math.random() * 2 ** 31);
    const uid = () => {
      const cs = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < 16; i++) s += cs[Math.floor(Math.random() * cs.length)];
      return s;
    };
    const now = Date.now();

    const base = (type, el) => ({
      id: el.id || uid(),
      type,
      x: Number(el.x) || 0,
      y: Number(el.y) || 0,
      width: Number(el.width) || 100,
      height: Number(el.height) || 100,
      angle: 0,
      strokeColor: el.strokeColor || '#1e1e1e',
      backgroundColor: el.backgroundColor || 'transparent',
      fillStyle: el.fillStyle || 'solid',
      strokeWidth: Number(el.strokeWidth) || 2,
      strokeStyle: el.strokeStyle || 'solid',
      roughness: el.roughness == null ? 1 : Number(el.roughness),
      opacity: el.opacity == null ? 100 : Number(el.opacity),
      groupIds: [],
      frameId: null,
      roundness: type === 'rectangle' ? { type: 3 } : null,
      seed: rnd(),
      version: 1,
      versionNonce: rnd(),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
    });

    const out = [];
    for (const el of skeletons) {
      const t = String(el.type || 'rectangle');
      if (t === 'text') {
        const fontSize = Number(el.fontSize) || 20;
        const text = String(el.text == null ? '' : el.text);
        const lines = text.split('\n');
        const longest = Math.max(1, ...lines.map((l) => l.length));
        out.push({
          ...base('text', {
            ...el,
            width: el.width || Math.round(fontSize * 0.6 * longest),
            height: el.height || Math.round(lines.length * fontSize * 1.25),
          }),
          text,
          originalText: text,
          fontSize,
          fontFamily: Number(el.fontFamily) || 1,
          textAlign: el.textAlign || 'left',
          verticalAlign: el.verticalAlign || 'top',
          containerId: null,
          lineHeight: 1.25,
          baseline: Math.round(fontSize * 0.9),
        });
      } else if (t === 'arrow' || t === 'line') {
        const pts =
          Array.isArray(el.points) && el.points.length
            ? el.points.map((p) => [Number(p[0]) || 0, Number(p[1]) || 0])
            : [[0, 0], [Number(el.width) || 100, Number(el.height) || 0]];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        out.push({
          ...base(t, {
            ...el,
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          }),
          points: pts,
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: t === 'arrow' ? el.endArrowhead || 'arrow' : null,
        });
      } else {
        out.push(base(t === 'ellipse' || t === 'diamond' ? t : 'rectangle', el));
      }
    }

    // (a) Programmatic API, if the host page exposes one (common in embeds). This
    // renders immediately with no reload.
    const api = window.excalidrawAPI || window.ExcalidrawAPI || null;
    if (api && typeof api.updateScene === 'function') {
      const cur = typeof api.getSceneElements === 'function' ? api.getSceneElements() : [];
      api.updateScene({ elements: [...cur, ...out] });
      if (typeof api.scrollToContent === 'function') api.scrollToContent(out, { fitToContent: true });
      return { ok: true, via: 'api', inserted: out.length, verified: true };
    }

    // (b) UPSERT into Excalidraw's own localStorage scene, then the caller reloads
    // the tab so Excalidraw restores it. An incoming element whose id matches an
    // existing one REPLACES it (update); a new id is APPENDED (add). This is what
    // lets the model add in free space or edit a specific shape without clobbering
    // the rest — provided it read the scene first (see read_canvas).
    try {
      const KEY = 'excalidraw';
      const existing = JSON.parse(localStorage.getItem(KEY) || '[]');
      const arr = Array.isArray(existing) ? existing : [];
      const before = arr.length;
      const byId = new Map(arr.map((e) => [e && e.id, e]));
      let added = 0;
      let updated = 0;
      for (const el of out) {
        if (byId.has(el.id)) updated += 1;
        else added += 1;
        byId.set(el.id, el);
      }
      const merged = [...byId.values()];
      localStorage.setItem(KEY, JSON.stringify(merged));
      return { ok: true, via: 'localStorage', inserted: out.length, added, updated, before, total: merged.length, ids: out.map((e) => e.id) };
    } catch (e) {
      return { ok: false, error: 'scene write failed: ' + ((e && e.message) || e) };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// BACKUP path. Runs in the PAGE's MAIN world and drives Excalidraw's OWN "Mermaid
// to Excalidraw" dialog: open it, type the Mermaid, click Insert. Uses Excalidraw's
// native converter (flowchart/sequence/class/ER) with auto-layout. Text-based
// selectors so it survives layout changes. Returns a serializable result.
async function insertMermaidViaDialog(mermaidText) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.querySelector('.excalidraw') || document;
  const vis = (el) => el && el.offsetParent !== null;
  const findByText = (sels, re) => {
    for (const el of (root.querySelectorAll(sels) || [])) {
      const t = (el.textContent || '').trim();
      if (re.test(t) || re.test(el.getAttribute('aria-label') || '') || re.test(el.title || '')) return el;
    }
    return null;
  };
  const dialogTextarea = () => {
    const dlg = document.querySelector('[role="dialog"], .Dialog, .excalidraw-modal-container');
    return (dlg || document).querySelector('textarea');
  };

  try {
    // 1) Open the Mermaid dialog if it isn't already showing.
    if (!vis(dialogTextarea())) {
      const moreBtn =
        root.querySelector('[data-testid="main-menu-trigger"]') ||
        root.querySelector('[data-testid="dropdown-menu-button"]') ||
        findByText('button', /more tools|more shapes|extra tools/i);
      if (moreBtn) {
        moreBtn.click();
        await sleep(220);
      }
      const item = findByText('button, [role="menuitem"], .dropdown-menu-item, li', /mermaid to excalidraw/i);
      if (item) {
        item.click();
        await sleep(550);
      }
    }

    const ta = dialogTextarea();
    if (!vis(ta)) {
      return {
        ok: false,
        error:
          'Could not open Excalidraw’s Mermaid dialog (editor not found). Open it once manually: the ' +
          'shapes/extra-tools menu → "Mermaid to Excalidraw", then retry.',
      };
    }

    // 2) Set the Mermaid text on the React-controlled textarea and let it parse.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
    if (setter) setter.call(ta, mermaidText);
    else ta.value = mermaidText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(900);

    // 3) Click Insert.
    const insertBtn =
      document.querySelector('[data-testid="mermaid-insert"]') || findByText('button', /^\s*insert\b/i);
    if (!insertBtn) return { ok: false, error: 'Mermaid dialog opened but its Insert button was not found.' };
    insertBtn.click();
    await sleep(450);
    return { ok: true, via: 'mermaid-dialog' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Read Excalidraw's persisted element count — used to CONFIRM the scene grew after
// the reload. Read-only; null if unreadable.
function excalidrawCountScript() {
  try {
    const a = JSON.parse(localStorage.getItem('excalidraw') || '[]');
    return Array.isArray(a) ? a.length : null;
  } catch {
    return null;
  }
}
async function readExcalidrawCount(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: excalidrawCountScript });
    return res?.result ?? null;
  } catch {
    return null;
  }
}

// The ids of every (non-deleted) element currently in the scene — used to confirm
// an upsert landed even when the COUNT didn't change (a pure update).
function excalidrawIdsScript() {
  try {
    const a = JSON.parse(localStorage.getItem('excalidraw') || '[]');
    return Array.isArray(a) ? a.filter((e) => e && !e.isDeleted).map((e) => e.id) : null;
  } catch {
    return null;
  }
}
async function readExcalidrawIds(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: excalidrawIdsScript });
    return res?.result ?? null;
  } catch {
    return null;
  }
}

// A compact listing of what's currently on the canvas so the model can place new
// shapes in FREE space (or update one by id) instead of dropping them on top of
// existing content. Runs in the page's MAIN world; reads Excalidraw's own store.
function readCanvasScript() {
  try {
    const a = JSON.parse(localStorage.getItem('excalidraw') || '[]');
    if (!Array.isArray(a)) return { ok: true, count: 0, bbox: null, elements: [] };
    const els = a
      .filter((e) => e && !e.isDeleted)
      .map((e) => ({
        id: e.id,
        type: e.type,
        x: Math.round(e.x || 0),
        y: Math.round(e.y || 0),
        w: Math.round(e.width || 0),
        h: Math.round(e.height || 0),
        ...(e.text ? { text: String(e.text).slice(0, 40) } : {}),
        ...(e.backgroundColor && e.backgroundColor !== 'transparent' ? { fill: e.backgroundColor } : {}),
      }));
    let bbox = null;
    if (els.length) {
      bbox = {
        minX: Math.min(...els.map((e) => e.x)),
        minY: Math.min(...els.map((e) => e.y)),
        maxX: Math.max(...els.map((e) => e.x + e.w)),
        maxY: Math.max(...els.map((e) => e.y + e.h)),
      };
    }
    return { ok: true, count: els.length, bbox, elements: els.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
async function readCanvas(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readCanvasScript });
    return res?.result || { ok: false, error: 'could not read canvas' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll the persisted count until it grows past `before` (debounced save) or times
// out. READ-ONLY — never mutates, so it can't create duplicates.
async function waitForExcalidrawGrowth(tabId, before, timeoutMs = 2500) {
  let last = before;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await wait(200);
    const c = await readExcalidrawCount(tabId);
    if (c != null) {
      last = c;
      if (before == null || c > before) return c;
    }
  }
  return last;
}
// Resolve once the tab finishes (re)loading, or after a timeout. The listener is
// added BEFORE reload by the caller to avoid missing a fast 'complete'.
function waitForTabComplete(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    try {
      chrome.tabs.onUpdated.addListener(listener);
    } catch {
      resolve(false);
      return;
    }
    setTimeout(() => finish(false), timeoutMs);
  });
}

const excalidrawAdapter = {
  id: 'excalidraw',
  label: 'Excalidraw',
  toolNames: ['structured_insert', 'read_canvas'],
  match(host) {
    return host === 'excalidraw.com' || host.endsWith('.excalidraw.com');
  },
  handles(name) {
    return this.toolNames.includes(name);
  },
  systemGuidance() {
    return (
      'This page is Excalidraw. Build shapes as DATA with `structured_insert` — do NOT pixel-draw ' +
      'with draw_path/click_at/click_mark. If the canvas is NOT empty (you are adding to or editing an ' +
      'existing drawing), FIRST call `read_canvas` to see what is already there — its element ids and ' +
      'the bounding box — then place NEW shapes in EMPTY space (e.g. below bbox.maxY + ~40, or to the ' +
      'right of bbox.maxX) so they do not land on top of existing content, or UPDATE a specific shape by ' +
      'reusing its id. PLAN every shape with x/y/size, then send them ALL in ONE call; it writes them at ' +
      'your exact coordinates and reloads the tab to render. TRUST the result’s `verified` flag — you do ' +
      'NOT need to screenshot each step; take ONE screenshot at the END to validate. For a STANDALONE ' +
      'standard diagram you may instead pass `mermaid`. If verified:false, the insert FAILED — say so ' +
      'plainly; do not silently fall back to pixel-drawing.'
    );
  },
  toolSpecs() {
    return [
      {
        name: 'structured_insert',
        description:
          'Insert into / update the Excalidraw canvas. PRIMARY: pass `elements` — shapes as data written ' +
          'at EXACT coordinates in ONE call, no pixel-dragging. To UPDATE an existing shape, include its ' +
          '`id` (from read_canvas) — a matching id REPLACES that shape, a new/absent id ADDS one. When ' +
          'adding to a non-empty canvas, call read_canvas first and place new shapes in free space so ' +
          'they don’t overlap. BACKUP: pass `mermaid` instead — a Mermaid diagram Excalidraw lays out ' +
          '(standalone flowchart/sequence/class/ER). Provide ONE of the two, then screenshot to validate. ' +
          EXCALIDRAW_FORMAT,
        parameters: {
          type: 'object',
          properties: {
            elements: {
              type: 'array',
              description:
                'PRIMARY. Shape skeletons (see the format above). Include an existing `id` to UPDATE that ' +
                'shape; omit it to ADD a new one.',
              items: { type: 'object' },
            },
            mermaid: {
              type: 'string',
              description:
                'BACKUP. A Mermaid diagram (flowchart/sequence/class/ER) for Excalidraw to auto-layout. ' +
                'Use instead of `elements` for a standalone diagram; the elements path is preferred otherwise.',
            },
          },
        },
      },
      {
        name: 'read_canvas',
        description:
          'List everything currently on the Excalidraw canvas — each element’s id, type, position (x,y) ' +
          'and size (w,h), plus the overall bounding box. ALWAYS call this BEFORE adding to or editing a ' +
          'non-empty canvas, so you can place new shapes in EMPTY space (e.g. below bbox.maxY) instead of ' +
          'on top of existing content, or target a shape to update by its id.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ];
  },
  async run(tabId, name, input, { cdp = false } = {}) {
    if (name === 'read_canvas') return readCanvas(tabId);
    return this.insert(tabId, input, { cdp });
  },
  async insert(tabId, input, { cdp = false } = {}) {
    // BACKUP path — only when `mermaid` is provided: drive Excalidraw's own
    // "Mermaid to Excalidraw" converter (auto-layout for flowchart/sequence/
    // class/ER). Leaves the proven elements path below completely untouched.
    const mermaid = typeof input?.mermaid === 'string' ? input.mermaid.trim() : '';
    if (mermaid) {
      const before = await readExcalidrawCount(tabId);
      let m;
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: insertMermaidViaDialog,
          args: [mermaid],
        });
        m = res?.result || { ok: false, error: 'injection returned no result' };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      if (!m.ok) return m;
      const after = await waitForExcalidrawGrowth(tabId, before);
      if (cdp) await cdpKeyChord(tabId, { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }, 8).catch(() => {});
      const verified = before != null && after != null ? after > before : null;
      return {
        ok: true,
        via: 'mermaid-dialog',
        sceneBefore: before,
        sceneAfter: after,
        verified,
        note:
          verified === true
            ? `Mermaid diagram inserted (scene now has ${after}) and zoomed to fit. Take ONE screenshot to validate — then DONE.`
            : 'Drove the Mermaid dialog but could not confirm the scene grew — its selectors may differ on this Excalidraw build. Screenshot to check; if empty, use the `elements` path instead.',
      };
    }

    // PRIMARY path — explicit elements → localStorage merge + reload (exact coords).
    const payloadJson = JSON.stringify({ elements: Array.isArray(input?.elements) ? input.elements : [] });
    let r;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: prepareExcalidraw,
        args: [payloadJson],
      });
      r = res?.result || { ok: false, error: 'injection returned no result' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
    if (!r.ok || r.via === 'api') return r;

    // localStorage path: reload so Excalidraw hydrates the merged scene, then frame
    // it with a trusted zoom-to-fit (Shift+1). Confirm by re-reading the count.
    const loaded = waitForTabComplete(tabId); // listener added before reload
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      /* fall through — verification will catch a failure */
    }
    await loaded;
    await wait(800); // let Excalidraw hydrate the scene from localStorage
    const sceneIds = await readExcalidrawIds(tabId);
    if (cdp) await cdpKeyChord(tabId, { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 }, 8).catch(() => {});
    // Verify by ID presence — this confirms UPDATES (count unchanged) too, not just
    // adds. All of our written ids must be present in the reloaded scene.
    const landed = Array.isArray(sceneIds) && Array.isArray(r.ids) ? r.ids.filter((id) => sceneIds.includes(id)).length : null;
    const verified = landed == null ? null : landed === r.ids.length;
    const ops = [r.added ? `${r.added} added` : '', r.updated ? `${r.updated} updated` : ''].filter(Boolean).join(', ') || `${r.inserted} shapes`;
    return {
      ok: true,
      via: 'localStorage-reload',
      inserted: r.inserted,
      added: r.added,
      updated: r.updated,
      sceneBefore: r.before,
      sceneTotal: Array.isArray(sceneIds) ? sceneIds.length : r.total,
      reloaded: true,
      verified,
      note:
        verified === true
          ? `Applied ${ops} at your exact coordinates; the page reloaded and rendered them (scene now has ${Array.isArray(sceneIds) ? sceneIds.length : r.total} elements). Take ONE screenshot to validate — then DONE. Do NOT re-insert.`
          : 'Could not confirm the shapes landed after reload — the insert may have FAILED (e.g. a collab room not restoring from local storage). Report this plainly; do NOT silently switch to pixel-drawing.',
    };
  },
};

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

export const CANVAS_ADAPTERS = [excalidrawAdapter];

// The adapter matching this tab's URL, or null. Feature-gating is applied by the
// caller — matching here is purely "does this app have a structured path?".
export function matchCanvasAdapter(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return CANVAS_ADAPTERS.find((a) => a.match(host)) || null;
}
