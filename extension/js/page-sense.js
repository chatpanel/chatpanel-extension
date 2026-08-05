// DETERMINISTIC SENSING — read what an app actually IS, instead of looking at it.
//
// Vision is the right tool for an unknown UI and the wrong tool for a game loop.
// A screenshot costs a full model round-trip (~1-3s) and returns pixels the model
// must then interpret; a grid-based game changes state every ~100ms and its board
// is exactly representable as a small array. So this module reads structure:
//
//   sense_canvas    → sample a canvas on a grid, return symbols + a colour legend.
//                     A Snake board becomes ~20 lines of text, exact and cheap.
//   read_app_state  → read the app's OWN JavaScript state by path. When an app
//                     exposes its model, this beats every form of looking.
//   probe_app_state → find what state exists, so read_app_state has paths to ask for.
//
// This is the same move `read_canvas` makes for Excalidraw (read the scene from
// storage, don't look at the drawing), generalized past one app.
//
// SECURITY. These are READ-ONLY, but page JavaScript is where apps keep session
// tokens, so a raw dump of `window` would be a credential-exfiltration path. Every
// value returned is therefore filtered: keys that look like secrets are replaced
// with a marker, never their value, and output is depth- and size-capped. Reading
// still only reaches pages the user has already armed page actions on.

// Keys whose VALUE must never leave the page. Matched loosely on the key name
// because the point is to be conservative — a false positive costs the model one
// unhelpful field, a false negative leaks a credential into a model context.
const SECRET_KEY_RE =
  /(^|[_\-.])?(token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|authorization|credential|session|cookie|jwt|bearer|private[_-]?key|refresh|access[_-]?key|signature|csrf|nonce)($|[_\-.])?/i;

export const REDACTED = '[[REDACTED]]';

// --------------------------------------------------------------------------
// Injected readers — self-contained (they run in the page, not here).
// --------------------------------------------------------------------------

// Sample a canvas on a regular grid and describe it as symbols. Returns rows of
// characters plus a legend, which is a fraction of a screenshot's cost and is
// EXACT — no interpretation step that can be wrong.
function senseCanvasInPage(opts) {
  const { cols, rows, index, x0, y0, w0, h0, tolerance } = opts;
  const canvases = [...document.querySelectorAll('canvas')];
  if (!canvases.length) return { ok: false, error: 'no <canvas> on this page' };

  let canvas;
  if (Number.isFinite(index)) {
    canvas = canvases[index];
    if (!canvas) return { ok: false, error: `no canvas at index ${index} (found ${canvases.length})` };
  } else {
    // Default to the largest — on a game page that is the playfield.
    canvas = canvases.reduce((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height > ra.width * ra.height ? b : a;
    });
  }

  let ctx;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) {
    return {
      ok: false,
      webgl: true,
      error:
        'This canvas is not 2D (WebGL/WebGPU), so its pixels cannot be read this way. Use a screenshot ' +
        'for it, or read_app_state if the app exposes its state in JavaScript.',
    };
  }

  // Region defaults to the whole backing store. Coordinates are in canvas pixels.
  const cw = canvas.width;
  const ch = canvas.height;
  const rx = Number.isFinite(x0) ? Math.max(0, Math.min(cw, x0)) : 0;
  const ry = Number.isFinite(y0) ? Math.max(0, Math.min(ch, y0)) : 0;
  const rw = Number.isFinite(w0) ? Math.max(1, Math.min(cw - rx, w0)) : cw - rx;
  const rh = Number.isFinite(h0) ? Math.max(1, Math.min(ch - ry, h0)) : ch - ry;

  let data;
  try {
    data = ctx.getImageData(rx, ry, rw, rh).data;
  } catch (e) {
    // A canvas tainted by cross-origin content cannot be read at all.
    return { ok: false, tainted: true, error: `canvas pixels unreadable: ${String((e && e.message) || e)}` };
  }

  const nc = Math.max(1, Math.min(120, Math.round(cols) || 32));
  const nr = Math.max(1, Math.min(120, Math.round(rows) || 32));
  const tol = Math.max(0, Math.min(128, Number.isFinite(tolerance) ? tolerance : 24));

  // Quantize so anti-aliasing and gradients don't explode the legend.
  const q = (v) => (tol <= 1 ? v : Math.round(v / tol) * tol);
  const buckets = new Map(); // "r,g,b" → { symbol, count, rgb }
  const SYMBOLS = '.#*+o=xX%@ABCDEFGHIJKLMNPQRSTUVWZ0123456789';
  const grid = [];

  for (let r = 0; r < nr; r++) {
    let line = '';
    for (let c = 0; c < nc; c++) {
      // Centre of the cell — avoids grid lines and cell borders.
      const px = Math.min(rw - 1, Math.floor((c + 0.5) * (rw / nc)));
      const py = Math.min(rh - 1, Math.floor((r + 0.5) * (rh / nr)));
      const i = (py * rw + px) * 4;
      const key = `${q(data[i])},${q(data[i + 1])},${q(data[i + 2])}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          symbol: SYMBOLS[buckets.size] || '?',
          count: 0,
          rgb: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`,
        };
        buckets.set(key, b);
      }
      b.count++;
      line += b.symbol;
    }
    grid.push(line);
  }

  const rect = canvas.getBoundingClientRect();
  return {
    ok: true,
    grid,
    cols: nc,
    rows: nr,
    legend: [...buckets.values()]
      .sort((a, b) => b.count - a.count)
      .map((b) => ({ symbol: b.symbol, rgb: b.rgb, cells: b.count })),
    canvas: {
      pixelSize: { w: cw, h: ch },
      // Viewport rect, so a grid cell can be converted back into a click point.
      viewport: {
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height),
      },
      count: canvases.length,
    },
  };
}

// Read the app's own state by path. `paths` are dotted, rooted at window —
// "game.score", "window.state.player.x". Values are summarized, never dumped:
// depth-capped, array-capped, and secret-looking keys never yield their value.
function readAppStateInPage(payload) {
  const { paths, maxDepth, secretRe } = payload;
  const SECRET = new RegExp(secretRe.source, secretRe.flags);
  const MARK = '[[REDACTED]]';
  const MAX_ARRAY = 50;
  const MAX_KEYS = 60;
  const MAX_STR = 200;

  function summarize(v, depth, key) {
    if (key && SECRET.test(String(key))) return MARK;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'undefined') return undefined;
    if (t === 'function') return `[function ${v.name || 'anonymous'}]`;
    if (t === 'symbol' || t === 'bigint') return String(v);
    if (depth <= 0) return Array.isArray(v) ? `[array(${v.length})]` : '[object]';
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ARRAY).map((e) => summarize(e, depth - 1));
      if (v.length > MAX_ARRAY) out.push(`…+${v.length - MAX_ARRAY} more`);
      return out;
    }
    if (ArrayBuffer.isView(v)) return `[${v.constructor.name}(${v.length})]`;
    // Guarded: this runs inside whatever context the page provides, and a bare
    // `instanceof Element` would throw the whole read if the binding is absent.
    if (typeof Element !== 'undefined' && v instanceof Element) {
      return `[<${String(v.tagName || '').toLowerCase()}>]`;
    }
    const out = {};
    let n = 0;
    for (const k in v) {
      if (n++ >= MAX_KEYS) { out['…'] = 'more keys omitted'; break; }
      try {
        out[k] = summarize(v[k], depth - 1, k);
      } catch {
        out[k] = '[unreadable]';
      }
    }
    return out;
  }

  const depth = Math.max(1, Math.min(5, Math.round(maxDepth) || 2));
  const results = {};
  for (const raw of paths) {
    const path = String(raw).replace(/^window\./, '');
    try {
      let cur = window;
      let ok = true;
      for (const seg of path.split('.').filter(Boolean)) {
        if (cur == null) { ok = false; break; }
        cur = cur[seg];
      }
      results[raw] = ok && cur !== undefined ? summarize(cur, depth, path.split('.').pop()) : '[not found]';
    } catch (e) {
      results[raw] = `[error: ${String((e && e.message) || e)}]`;
    }
  }
  return { ok: true, state: results };
}

// What non-standard state does this page hang off `window`? This is how you FIND
// the game object before you can read it. Returns names and shapes only — never
// values, so a probe can never be the thing that leaks a credential.
function probeAppStateInPage() {
  const STANDARD = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window) || {}));
  const found = [];
  for (const k of Object.getOwnPropertyNames(window)) {
    if (STANDARD.has(k) || /^(webkit|moz|ms|on)[A-Z]/.test(k) || k.length > 40) continue;
    let v;
    try {
      v = window[k];
    } catch {
      continue;
    }
    const t = typeof v;
    if (v == null || t === 'undefined') continue;
    if (t === 'function') {
      // Constructors and namespaces are worth naming; plain helpers are noise.
      if (!/^[A-Z]/.test(k)) continue;
      found.push({ name: k, type: 'function' });
    } else if (t === 'object') {
      let keys = [];
      try {
        keys = Object.keys(v).slice(0, 25);
      } catch {
        /* exotic proxy */
      }
      if (!keys.length) continue;
      found.push({
        name: k,
        type: Array.isArray(v) ? `array(${v.length})` : 'object',
        keys,
      });
    }
  }
  return {
    ok: true,
    globals: found.slice(0, 60),
    note:
      'Names and key SHAPES only — no values. Pick a promising path and read it with read_app_state ' +
      '(e.g. probe shows {name:"game", keys:["score","board"]} → read "game.board").',
  };
}

// --------------------------------------------------------------------------
// Public capability — thin wrappers so callers never touch the injection detail.
// --------------------------------------------------------------------------

async function inject(tabId, func, args, world) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    ...(world ? { world } : {}),
    func,
    args,
  });
  return res?.result;
}

export async function senseCanvas(tabId, opts = {}) {
  try {
    // The page's canvas lives in the shared DOM, so the isolated world can read
    // it — no need for MAIN-world access here.
    return await inject(tabId, senseCanvasInPage, [{
      cols: opts.cols, rows: opts.rows, index: opts.index,
      x0: opts.x, y0: opts.y, w0: opts.w, h0: opts.h,
      tolerance: opts.tolerance,
    }]);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function readAppState(tabId, { paths, maxDepth } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).slice(0, 20).map(String);
  if (!list.length) return { ok: false, error: 'read_app_state needs at least one path' };
  try {
    // MAIN world: page JS state is invisible from the isolated world.
    return await inject(
      tabId,
      readAppStateInPage,
      [{ paths: list, maxDepth, secretRe: { source: SECRET_KEY_RE.source, flags: SECRET_KEY_RE.flags } }],
      'MAIN',
    );
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function probeAppState(tabId) {
  try {
    return await inject(tabId, probeAppStateInPage, [], 'MAIN');
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export const SENSE_TOOL_SPECS = [
  {
    name: 'sense_canvas',
    description:
      'Read a canvas as a GRID of symbols instead of looking at a picture of it — exact, tiny, and far ' +
      'cheaper than a screenshot. Ideal for grid or tile games (Snake, chess, puzzles, board games) and ' +
      'any canvas with flat distinct colours: you get the actual board state, not an interpretation of ' +
      'pixels. Returns `grid` (rows of characters), a `legend` mapping each symbol to its colour and cell ' +
      'count, and the canvas rect so you can convert a cell back into a click point. Choose cols/rows to ' +
      'match the game\'s real board (a 20x20 board → cols:20, rows:20) — matching the true grid is what ' +
      'makes each cell one game square. Only works on 2D canvases; WebGL/3D returns an error, use a ' +
      'screenshot there.',
    parameters: {
      type: 'object',
      properties: {
        cols: { type: 'number', description: 'Grid columns to sample (default 32, max 120).' },
        rows: { type: 'number', description: 'Grid rows to sample (default 32, max 120).' },
        index: { type: 'number', description: 'Which canvas, if the page has several. Default: the largest.' },
        x: { type: 'number', description: 'Optional sub-region in canvas pixels.' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        tolerance: { type: 'number', description: 'Colour quantization step (default 24). Raise to merge shades.' },
      },
      required: [],
    },
  },
  {
    name: 'probe_app_state',
    description:
      'List the app\'s own JavaScript state objects on this page — names and key shapes only, no values. ' +
      'Use it to FIND where an app keeps its model (a game object, a store, a scene) before reading it ' +
      'with read_app_state. When an app exposes its state, reading it beats every form of looking at it.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_app_state',
    description:
      'Read the app\'s own state by dotted path (e.g. "game.score", "state.player.x"), rooted at window. ' +
      'This is the most reliable way to know what an app is actually doing — exact values, no vision, no ' +
      'guessing. Call probe_app_state first to find paths. Values are summarized and depth-capped, and ' +
      'anything that looks like a credential is withheld.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Dotted paths to read (max 20).',
          items: { type: 'string' },
        },
        maxDepth: { type: 'number', description: 'How deep to expand objects (1-5, default 2).' },
      },
      required: ['paths'],
    },
  },
];

// Executor for the sensing tools. Returns null for anything it doesn't own, so
// the caller can fall through to its other tool families.
export function makeSenseExecutor(tabId) {
  return async (name, input) => {
    if (name === 'sense_canvas') return senseCanvas(tabId, input || {});
    if (name === 'probe_app_state') return probeAppState(tabId);
    if (name === 'read_app_state') {
      return readAppState(tabId, { paths: input?.paths, maxDepth: input?.maxDepth });
    }
    return null;
  };
}
