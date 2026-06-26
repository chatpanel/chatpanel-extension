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
    const native = Array.isArray(input.native) ? input.native : null; // raw Excalidraw elements
    if (!native && !skeletons.length) return { ok: false, error: 'no elements provided' };

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

    // native: raw Excalidraw elements authored by the model — fill only the
    // required bookkeeping fields if missing so Excalidraw doesn't drop them.
    const ensure = (el) => ({ id: uid(), seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false, updated: now, ...el });
    const out = [];
    if (native) for (const el of native) out.push(ensure(el || {}));
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
  capability: 'excalidraw',
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
          '(standalone flowchart/sequence/class/ER). Provide ONE input, then screenshot to validate. ' +
          EXCALIDRAW_FORMAT +
          '\nADVANCED: instead of `elements`, pass `native` — an array of raw Excalidraw element objects ' +
          '(official element schema) for full control; missing bookkeeping fields are filled in.',
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
            native: {
              type: 'array',
              description: 'ADVANCED. Raw Excalidraw element objects. Use instead of `elements` for full-schema control.',
              items: { type: 'object' },
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

    // PRIMARY path — explicit elements (or raw `native` elements) → localStorage
    // merge + reload (exact coords).
    const payloadJson = JSON.stringify({
      elements: Array.isArray(input?.elements) ? input.elements : [],
      native: Array.isArray(input?.native) ? input.native : undefined,
    });
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
// draw.io / diagrams.net (app.diagrams.net)
// --------------------------------------------------------------------------
// The live EditorUi instance isn't exposed on window, and there's no diagram in
// localStorage — so we drive draw.io's OWN "Extras → Edit Diagram" XML editor:
// read the current mxGraphModel, upsert our <mxCell> nodes, write it back, OK.
// Deterministic (draw.io parses the XML) and honors exact coordinates.

const DRAWIO_FORMAT =
  'Provide `elements` as an array of node/edge skeletons; ChatPanel turns them into draw.io ' +
  'mxGraph cells and applies them via the Edit Diagram XML. Coordinates are diagram pixels ' +
  '(x,y = top-left; y grows downward).\n' +
  'Nodes — give each an `id` so edges can reference it:\n' +
  '- { id, type:"rectangle"|"rounded"|"ellipse"|"diamond"|"text", x, y, width, height, text?, ' +
  'fillColor?, strokeColor? }\n' +
  'Edges (connectors between two nodes):\n' +
  '- { type:"edge", source:<nodeId>, target:<nodeId>, text? }\n' +
  'Colors are hex (e.g. "#d5e8d4"). To UPDATE an existing cell, reuse its id (from read_canvas).\n' +
  'OFFICIAL ICONS (AWS / GCP / Azure / UML …): set a full draw.io `style` on the node — it ' +
  'overrides the shape defaults. AWS example (size ~78×78): "sketch=0;html=1;aspect=fixed;' +
  'verticalLabelPosition=bottom;verticalAlign=top;align=center;shape=mxgraph.aws4.resourceIcon;' +
  'resIcon=mxgraph.aws4.ec2;" — use the real mxgraph.aws4.* resIcon names (ec2, s3, rds, lambda, ' +
  'vpc, cloudfront, route_53, elastic_load_balancing, cloudwatch, …). So for an AWS diagram, emit ' +
  'icon nodes with these styles instead of plain colored boxes.\n' +
  'Example — a two-box flow:\n' +
  '[ {"id":"a","type":"rounded","x":160,"y":80,"width":120,"height":60,"text":"Start","fillColor":"#d5e8d4"},' +
  ' {"id":"b","type":"rectangle","x":160,"y":220,"width":120,"height":60,"text":"Process"},' +
  ' {"type":"edge","source":"a","target":"b","text":"next"} ]';

// Self-contained MAIN-world routine: op = {op:'read'} or {op:'insert', elements}.
async function drawioOp(opJson) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findByText = (sel, re) => {
    for (const el of document.querySelectorAll(sel)) if (re.test((el.textContent || '').trim())) return el;
    return null;
  };
  const dialog = () => document.querySelector('.geDialog, [role="dialog"]');
  const getCM = () => {
    const el = (dialog() || document).querySelector('.CodeMirror');
    return el && el.CodeMirror ? el.CodeMirror : null;
  };
  const textarea = () => {
    const ta = (dialog() || document).querySelector('textarea');
    return ta && ta.offsetParent ? ta : null;
  };
  const editorReady = () => !!(getCM() || textarea());
  const readXml = () => {
    const cm = getCM();
    if (cm) return cm.getValue();
    const ta = textarea();
    return ta ? ta.value : null;
  };
  const writeXml = (xml) => {
    const cm = getCM();
    if (cm) {
      cm.setValue(xml);
      return true;
    }
    const ta = textarea();
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
    if (setter) setter.call(ta, xml);
    else ta.value = xml;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  // draw.io's menubar + popup menus use mxgraph GESTURE listeners (mousedown/
  // mouseup), not plain click — a bare .click() won't open them.
  const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  const gesture = (el) => {
    fire(el, 'mousedown');
    fire(el, 'mouseup');
    fire(el, 'click');
  };
  const clickBtn = (re) => {
    // Search the dialog first, then the whole document (draw.io's primary button
    // can sit just outside the matched container). Visible elements only.
    for (const scope of [dialog(), document].filter(Boolean)) {
      const btn = [...scope.querySelectorAll('button, .geBtn, .gePrimaryBtn, a, input[type=button], input[type=submit]')].find(
        (b) => b.offsetParent !== null && re.test((b.textContent || b.value || '').trim()),
      );
      if (btn) {
        gesture(btn);
        return true;
      }
    }
    return false;
  };
  const openDialog = async () => {
    if (editorReady()) return true;
    const extras = findByText('a.geItem, a, div, td', /^extras$/i);
    if (!extras) return false;
    gesture(extras);
    await sleep(280);
    const item = findByText('.mxPopupMenuItem, .mxPopupMenu td, .mxPopupMenu tr, a, div, td', /^edit diagram/i);
    if (!item) return false;
    gesture(item);
    await sleep(450);
    return editorReady();
  };

  try {
    const op = JSON.parse(opJson);
    if (!(await openDialog())) return { ok: false, error: 'Could not open draw.io Extras → Edit Diagram dialog.' };
    const xml = readXml();
    if (xml == null) return { ok: false, error: 'Edit Diagram editor not found.' };
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const model = doc.querySelector('mxGraphModel');
    const root = model && model.querySelector('root');
    if (!root) {
      clickBtn(/^cancel$/i);
      return { ok: false, error: 'Unexpected diagram XML (no <root>).' };
    }
    const cells = [...root.querySelectorAll('mxCell')];

    if (op.op === 'read') {
      const els = cells
        .filter((c) => c.getAttribute('vertex') === '1')
        .map((c) => {
          const g = c.querySelector('mxGeometry');
          const style = c.getAttribute('style') || '';
          let type = 'rectangle';
          if (/ellipse/.test(style)) type = 'ellipse';
          else if (/rhombus/.test(style)) type = 'diamond';
          else if (/(^|;)text(;|$)/.test(style)) type = 'text';
          return {
            id: c.getAttribute('id'),
            type,
            x: Math.round(parseFloat(g?.getAttribute('x') || '0')),
            y: Math.round(parseFloat(g?.getAttribute('y') || '0')),
            w: Math.round(parseFloat(g?.getAttribute('width') || '0')),
            h: Math.round(parseFloat(g?.getAttribute('height') || '0')),
            ...(c.getAttribute('value') ? { text: c.getAttribute('value').replace(/<[^>]+>/g, '').slice(0, 40) } : {}),
          };
        });
      clickBtn(/^cancel$/i);
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
    }

    // insert / upsert — from `elements` skeletons OR raw `native` mxGraph XML.
    const skeletons = Array.isArray(op.elements) ? op.elements : [];
    const native = typeof op.native === 'string' ? op.native.trim() : '';
    if (!native && !skeletons.length) {
      clickBtn(/^cancel$/i);
      return { ok: false, error: 'no elements provided' };
    }
    const uid = () => 'c' + Math.random().toString(36).slice(2, 10);
    const layerCell = cells.find((c) => c.getAttribute('parent') === '0');
    const layerParent = (layerCell && layerCell.getAttribute('id')) || '1';
    const byId = new Map(cells.map((c) => [c.getAttribute('id'), c]));
    let added = 0;
    let updated = 0;
    const upsert = (cell) => {
      const cid = cell.getAttribute('id');
      const old = cid && byId.get(cid);
      if (old && old.parentNode) {
        old.parentNode.replaceChild(cell, old);
        updated += 1;
      } else {
        root.appendChild(cell);
        if (cid) byId.set(cid, cell);
        added += 1;
      }
    };
    if (native) {
      // Raw mxGraph XML — accept a full <mxGraphModel> or bare <mxCell> fragments.
      const wrapped = native.includes('<mxGraphModel') ? native : `<root>${native}</root>`;
      const ndoc = new DOMParser().parseFromString(wrapped, 'text/xml');
      const newCells = [...ndoc.querySelectorAll('mxCell')].filter(
        (c) => c.getAttribute('vertex') === '1' || c.getAttribute('edge') === '1',
      );
      if (!newCells.length) {
        clickBtn(/^cancel$/i);
        return { ok: false, error: 'native XML contained no <mxCell vertex=…/edge=…> nodes' };
      }
      for (const c of newCells) upsert(doc.importNode(c, true));
    } else
      for (const el of skeletons) {
        const t = String(el.type || 'rectangle');
        const id = el.id || uid();
        const cell = doc.createElement('mxCell');
        cell.setAttribute('id', id);
        cell.setAttribute('parent', el.parent || layerParent);
        cell.setAttribute('value', el.text || '');
        if (t === 'edge') {
          cell.setAttribute('edge', '1');
          cell.setAttribute('style', el.style || 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;');
          if (el.source) cell.setAttribute('source', String(el.source));
          if (el.target) cell.setAttribute('target', String(el.target));
          const g = doc.createElement('mxGeometry');
          g.setAttribute('relative', '1');
          g.setAttribute('as', 'geometry');
          cell.appendChild(g);
        } else {
          cell.setAttribute('vertex', '1');
          const shape = t === 'ellipse' ? 'ellipse;' : t === 'diamond' ? 'rhombus;' : t === 'text' ? 'text;' : '';
          const rounded = t === 'rounded' ? 'rounded=1;' : t === 'rectangle' ? 'rounded=0;' : '';
          const fill = el.fillColor || el.backgroundColor;
          cell.setAttribute(
            'style',
            el.style ||
              `${shape}${rounded}whiteSpace=wrap;html=1;${fill ? `fillColor=${fill};` : ''}${el.strokeColor ? `strokeColor=${el.strokeColor};` : ''}`,
          );
          const g = doc.createElement('mxGeometry');
          g.setAttribute('x', String(Number(el.x) || 0));
          g.setAttribute('y', String(Number(el.y) || 0));
          g.setAttribute('width', String(Number(el.width) || 120));
          g.setAttribute('height', String(Number(el.height) || 60));
          g.setAttribute('as', 'geometry');
          cell.appendChild(g);
        }
        upsert(cell);
      }
    const newXml = new XMLSerializer().serializeToString(model);
    if (!writeXml(newXml)) {
      clickBtn(/^cancel$/i);
      return { ok: false, error: 'Could not write the diagram XML into the editor.' };
    }
    await sleep(150);
    const clicked = clickBtn(/^ok$/i);
    await sleep(350);
    // The dialog closing is the real confirmation that draw.io accepted the XML.
    const applied = clicked && !editorReady();
    const total = root.querySelectorAll('mxCell[vertex="1"], mxCell[edge="1"]').length;
    return { ok: true, via: 'edit-diagram', added, updated, total, applied };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const drawioAdapter = {
  id: 'drawio',
  label: 'draw.io',
  capability: 'drawio',
  toolNames: ['structured_insert', 'read_canvas'],
  match(host) {
    return host === 'app.diagrams.net' || host === 'draw.io' || host === 'www.draw.io' || host.endsWith('.diagrams.net');
  },
  handles(name) {
    return this.toolNames.includes(name);
  },
  systemGuidance() {
    return (
      'This page is draw.io. Build the diagram as DATA with `structured_insert` (nodes + edges) — do ' +
      'NOT pixel-draw. If the canvas is NOT empty, FIRST call `read_canvas` to see existing cells (ids, ' +
      'positions, bounding box), then place NEW nodes in free space or UPDATE one by reusing its id. ' +
      'Give nodes ids so edges can reference them via source/target. It applies through draw.io’s Edit ' +
      'Diagram XML and re-renders. Take ONE screenshot at the end to validate; do not re-insert.'
    );
  },
  toolSpecs() {
    return [
      {
        name: 'structured_insert',
        description:
          'Insert into / update the draw.io diagram by describing nodes and edges as data — exact ' +
          'coordinates, no pixel-dragging. To UPDATE a cell, reuse its id (from read_canvas); a new id ' +
          'ADDS. When adding to a non-empty diagram, call read_canvas first and place new nodes in free ' +
          'space. Screenshot once to validate. ' +
          DRAWIO_FORMAT +
          '\nADVANCED: instead of `elements`, pass `native` — a raw mxGraph XML string (bare <mxCell> ' +
          'nodes or a full <mxGraphModel>) using the official draw.io schema, merged by id.',
        parameters: {
          type: 'object',
          properties: {
            elements: {
              type: 'array',
              description: 'Node/edge skeletons (see the format above). Reuse an existing id to UPDATE that cell.',
              items: { type: 'object' },
            },
            native: {
              type: 'string',
              description: 'ADVANCED. Raw mxGraph XML (<mxCell> nodes or a full <mxGraphModel>). Use instead of `elements`.',
            },
          },
        },
      },
      {
        name: 'read_canvas',
        description:
          'List the cells currently in the draw.io diagram — each id, type, position (x,y) and size ' +
          '(w,h), plus the bounding box. ALWAYS call before adding to or editing a non-empty diagram so ' +
          'new nodes go in free space (e.g. below bbox.maxY) and edges/updates can reference the right ids.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ];
  },
  async _op(tabId, payload) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: drawioOp,
        args: [JSON.stringify(payload)],
      });
      return res?.result || { ok: false, error: 'injection returned no result' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
  async run(tabId, name, input, { cdp = false } = {}) {
    if (name === 'read_canvas') return this._op(tabId, { op: 'read' });
    const elements = Array.isArray(input?.elements) ? input.elements : [];
    const native = typeof input?.native === 'string' ? input.native : undefined;
    const r = await this._op(tabId, { op: 'insert', elements, native });
    if (!r.ok) return r;
    // Ctrl+Shift+H = Fit Page, so the result is framed in view.
    if (cdp) await cdpKeyChord(tabId, { key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72 }, 2 | 8).catch(() => {});
    return {
      ...r,
      verified: r.applied ? null : false,
      note: r.applied
        ? `Applied to the diagram (${r.added} added, ${r.updated} updated). Take ONE screenshot to validate — do NOT re-insert.`
        : 'Wrote the XML but could not confirm the dialog’s OK was clicked — screenshot to check; report if nothing changed.',
    };
  },
};

// --------------------------------------------------------------------------
// tldraw (tldraw.com) — the cleanest path: the live Editor is on window.editor,
// so we use its public API directly (createShapes / updateShapes /
// getCurrentPageShapes / zoomToFit). No dialog, no reload, exact coordinates.
// --------------------------------------------------------------------------

const TLDRAW_FORMAT =
  'Provide `elements` as an array of shape skeletons inserted via tldraw’s API at exact ' +
  'coordinates (x,y = top-left; y grows downward).\n' +
  'Shapes:\n' +
  '- geo: { id?, type:"rectangle"|"ellipse"|"diamond"|"triangle"|"rhombus"|"oval"|"cloud"|"star"|' +
  '"hexagon"|"pentagon", x, y, width, height, text?, color?, fill? }\n' +
  '- text: { type:"text", x, y, text, color? }\n' +
  '- arrow: { type:"arrow", x, y, width, height }  (straight arrow from x,y by width/height)\n' +
  'tldraw uses NAMED colors, NOT hex: black, grey, blue, light-blue, green, light-green, red, ' +
  'light-red, orange, yellow, violet, light-violet, white. fill: none | semi | solid | pattern.\n' +
  'To UPDATE a shape, reuse its id (from read_canvas).\n' +
  'Example: [ {"id":"a","type":"rectangle","x":120,"y":100,"width":160,"height":80,"text":"Start","color":"green"},' +
  ' {"id":"b","type":"ellipse","x":120,"y":260,"width":160,"height":80,"text":"End","color":"blue"} ]';

function tldrawReadScript() {
  try {
    const ed = window.editor;
    if (!ed || typeof ed.getCurrentPageShapes !== 'function') return { ok: false, error: 'tldraw editor not available on this page' };
    const els = ed.getCurrentPageShapes().map((s) => ({
      id: s.id,
      type: s.type === 'geo' ? s.props?.geo || 'geo' : s.type,
      x: Math.round(s.x || 0),
      y: Math.round(s.y || 0),
      w: Math.round(s.props?.w || 0),
      h: Math.round(s.props?.h || 0),
      ...(s.props?.text ? { text: String(s.props.text).slice(0, 40) } : {}),
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

function tldrawInsertScript(payloadJson) {
  try {
    const ed = window.editor;
    if (!ed || typeof ed.createShapes !== 'function') return { ok: false, error: 'tldraw editor not available on this page' };
    const parsed = (() => {
      try {
        return JSON.parse(payloadJson) || {};
      } catch {
        return {};
      }
    })();
    const skeletons = Array.isArray(parsed.elements) ? parsed.elements : [];
    const native = Array.isArray(parsed.native) ? parsed.native : null; // raw tldraw shape partials
    if (!native && !skeletons.length) return { ok: false, error: 'no elements or native shapes provided' };
    const GEO = {
      rectangle: 'rectangle', rounded: 'rectangle', box: 'rectangle', square: 'rectangle',
      ellipse: 'ellipse', circle: 'ellipse', oval: 'oval', diamond: 'diamond', rhombus: 'rhombus',
      triangle: 'triangle', cloud: 'cloud', star: 'star', hexagon: 'hexagon', pentagon: 'pentagon',
    };
    const COLORS = new Set(['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white']);
    const FILLS = new Set(['none', 'semi', 'solid', 'pattern', 'fill']);
    const mkId = () => 'shape:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const normId = (id) => (!id ? mkId() : String(id).startsWith('shape:') ? String(id) : 'shape:' + String(id).replace(/[^a-zA-Z0-9_-]/g, ''));
    // tldraw v3 labels are richText (a ProseMirror doc), not a plain string.
    const richTextOf = (s) => ({
      type: 'doc',
      content: String(s == null ? '' : s)
        .split('\n')
        .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
    });
    // The label-less base shape, plus its label text (applied separately so we can
    // try richText → plain text → no label across tldraw versions).
    const baseShape = (el) => {
      const raw = String(el.type || 'rectangle');
      const id = normId(el.id);
      const x = Number(el.x) || 0;
      const y = Number(el.y) || 0;
      if (raw === 'arrow' || raw === 'line') {
        return { shape: { id, type: 'arrow', x, y, props: { start: { x: 0, y: 0 }, end: { x: Number(el.width) || 120, y: Number(el.height) || 0 } } }, label: null };
      }
      if (raw === 'text') {
        const props = {};
        if (el.color && COLORS.has(el.color)) props.color = el.color;
        return { shape: { id, type: 'text', x, y, props }, label: el.text };
      }
      const kind = raw === 'geo' ? GEO[el.geo] || el.geo || 'rectangle' : GEO[raw] || 'rectangle';
      const props = { geo: kind, w: Number(el.width) || 120, h: Number(el.height) || 60 };
      if (el.color && COLORS.has(el.color)) props.color = el.color;
      if (el.fill && FILLS.has(el.fill)) props.fill = el.fill;
      return { shape: { id, type: 'geo', x, y, props }, label: el.text };
    };
    // Apply via the right call, trying label as richText (v3), then plain text (v2),
    // then no label — so one schema quirk can't drop the whole shape.
    const apply = (fn, base, label) => {
      const variants = label
        ? [
            { ...base, props: { ...base.props, richText: richTextOf(label) } },
            { ...base, props: { ...base.props, text: String(label) } },
            base,
          ]
        : [base];
      let lastErr = '';
      for (const v of variants) {
        try {
          fn([v]);
          return { ok: true };
        } catch (e) {
          lastErr = String((e && e.message) || e);
        }
      }
      return { ok: false, error: lastErr.slice(0, 160) };
    };
    const existing = new Set(ed.getCurrentPageShapes().map((s) => s.id));
    // native: raw tldraw shape partials (full power, model-authored, validated by
    // tldraw). skeletons: our safe converter. One path per call.
    const items = native
      ? native.map((sh) => ({ shape: { ...(sh || {}), id: normId(sh && sh.id), type: (sh && sh.type) || 'geo' }, label: null }))
      : skeletons.map(baseShape);
    let added = 0;
    let updated = 0;
    const failed = [];
    for (const { shape, label } of items) {
      const isUpdate = existing.has(shape.id);
      const r = apply(isUpdate ? ed.updateShapes.bind(ed) : ed.createShapes.bind(ed), shape, label);
      if (!r.ok) {
        failed.push({ id: shape.id, error: r.error });
        continue;
      }
      if (isUpdate) {
        updated += 1;
      } else {
        existing.add(shape.id);
        added += 1;
      }
    }
    try {
      if (typeof ed.zoomToFit === 'function') ed.zoomToFit();
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      via: native ? 'tldraw-api(native)' : 'tldraw-api',
      added,
      updated,
      total: ed.getCurrentPageShapes().length,
      ...(failed.length ? { failed } : {}),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const tldrawAdapter = {
  id: 'tldraw',
  label: 'tldraw',
  capability: 'tldraw',
  toolNames: ['structured_insert', 'read_canvas'],
  match(host) {
    return host === 'tldraw.com' || host === 'www.tldraw.com' || host.endsWith('.tldraw.com');
  },
  handles(name) {
    return this.toolNames.includes(name);
  },
  systemGuidance() {
    return (
      'This page is tldraw. Build shapes as DATA with `structured_insert` — do NOT pixel-draw. If ' +
      'the canvas is NOT empty, FIRST call `read_canvas` for existing shapes (ids + bounding box), ' +
      'then place new shapes in free space or UPDATE one by reusing its id. tldraw uses NAMED colors ' +
      '(blue/green/red/…), not hex. It applies instantly via tldraw’s API and zooms to fit. Take ONE ' +
      'screenshot at the end to validate; do not re-insert.'
    );
  },
  toolSpecs() {
    return [
      {
        name: 'structured_insert',
        description:
          'Insert into / update the tldraw canvas by describing shapes as data — exact coordinates, ' +
          'applied instantly via tldraw’s API (no dragging). To UPDATE a shape, reuse its id (from ' +
          'read_canvas); a new id ADDS. Place new shapes in free space on a non-empty canvas. ' +
          TLDRAW_FORMAT +
          '\nADVANCED: instead of `elements`, pass `native` — an array of raw tldraw shape records ' +
          '(the official TLShapePartial schema: {id?, type, x, y, props}) — for full power (frames, ' +
          'notes, draw, bindings). Rejected shapes are reported back with the validation error so you ' +
          'can fix and retry.',
        parameters: {
          type: 'object',
          properties: {
            elements: {
              type: 'array',
              description: 'Shape skeletons (see the format above). Reuse an existing id to UPDATE that shape.',
              items: { type: 'object' },
            },
            native: {
              type: 'array',
              description: 'ADVANCED. Raw tldraw shape records (TLShapePartial). Use instead of `elements` for full-schema control.',
              items: { type: 'object' },
            },
          },
        },
      },
      {
        name: 'read_canvas',
        description:
          'List the shapes currently on the tldraw canvas — each id, type, position (x,y) and size ' +
          '(w,h), plus the bounding box. ALWAYS call before adding to or editing a non-empty canvas so ' +
          'new shapes go in free space and updates target the right id.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ];
  },
  async _exec(tabId, func, arg) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func,
        args: arg === undefined ? [] : [arg],
      });
      return res?.result || { ok: false, error: 'injection returned no result' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
  async run(tabId, name, input) {
    if (name === 'read_canvas') return this._exec(tabId, tldrawReadScript);
    const payload = {
      elements: Array.isArray(input?.elements) ? input.elements : [],
      native: Array.isArray(input?.native) ? input.native : undefined,
    };
    const r = await this._exec(tabId, tldrawInsertScript, JSON.stringify(payload));
    if (!r.ok) return r;
    const landed = (r.added || 0) + (r.updated || 0);
    const failNote = r.failed?.length ? ` ${r.failed.length} shape(s) were REJECTED: ${r.failed[0].error} — fix the schema and retry only those.` : '';
    return {
      ...r,
      verified: landed > 0,
      note:
        (landed > 0
          ? `Inserted ${r.added}, updated ${r.updated} via tldraw’s API (scene now has ${r.total}); zoomed to fit. Take ONE screenshot to validate — do NOT re-insert.`
          : 'No shapes landed — the schema was rejected by this tldraw version.') + failNote,
    };
  },
};

// --------------------------------------------------------------------------
// Registry + capability router
// --------------------------------------------------------------------------

export const CANVAS_ADAPTERS = [excalidrawAdapter, drawioAdapter, tldrawAdapter];

// MAIN-world probe: which known canvas framework is present? Capability-based, so
// it works on embeds / self-hosted / unknown domains — not just the exact hosts.
function probeCanvasScript() {
  const has = (fn) => {
    try {
      return !!fn();
    } catch {
      return false;
    }
  };
  return {
    tldraw: has(() => window.editor && typeof window.editor.createShapes === 'function' && typeof window.editor.getCurrentPageShapes === 'function'),
    excalidraw:
      has(() => !!document.querySelector('.excalidraw')) ||
      has(() => JSON.parse(localStorage.getItem('excalidraw') || 'null') !== null) ||
      has(() => !!(window.excalidrawAPI || window.ExcalidrawAPI)),
    drawio: has(() => !!(window.mxUtils && window.EditorUi)) || has(() => !!document.querySelector('.geDiagramContainer, .geEditor, .geMenubar')),
  };
}

async function probeCanvas(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: probeCanvasScript });
    return res?.result || {};
  } catch {
    return {};
  }
}

// The adapter for a tab's URL (sync fast path). Feature-gating is applied by the
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

// The adapter for a tab — by URL first (cheap), else by CAPABILITY (probe the live
// page), so any page running a known framework gets the right adapter regardless
// of its domain. Returns null when nothing structured is detected (the agent then
// falls back to the universal pixel tools).
export async function detectCanvasAdapter(tabId, url) {
  const byUrl = matchCanvasAdapter(url);
  if (byUrl) return byUrl;
  if (tabId == null) return null;
  const caps = await probeCanvas(tabId);
  return CANVAS_ADAPTERS.find((a) => a.capability && caps[a.capability]) || null;
}
