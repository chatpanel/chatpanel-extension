// Pointer capture + the uncaptured-canvas state.
//
// The failure this guards against is silent: on a first-person canvas app that has
// NOT taken the pointer, keys work and clicks land, but mouse-look does nothing —
// so an agent aims forever at a view that never turns. Capture must FOCUS then
// VERIFY, and a relative move on an uncaptured page must say so out loud.
import assert from 'node:assert/strict';

const sent = [];
let state = { locked: false, w: 1000, h: 800, hasFocus: false, canvas: { w: 1000, h: 800, cx: 500, cy: 400 }, canvasApp: true };
let locksOnClick = false;      // does the page grab the pointer when clicked?
let elementAtPoint = { tag: 'canvas', id: '', cls: '', text: '' };
const focusCalls = [];

globalThis.chrome = {
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand(_t, method, params) {
      sent.push({ method, params });
      if (locksOnClick && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        state = { ...state, locked: true };
      }
    },
    onDetach: { addListener() {} },
  },
  scripting: {
    async executeScript({ func, args }) {
      // Two injected readers are used here: the pointer-state probe (no args) and
      // the "what is at this point" probe (x, y) used to diagnose a failed capture.
      if (args && args.length === 2) return [{ result: elementAtPoint }];
      return [{ result: state }];
    },
  },
  tabs: {
    async get() { return { windowId: 7 }; },
    async update(id, opts) { focusCalls.push({ kind: 'tab', id, opts }); },
    async captureVisibleTab() { return null; },
  },
  windows: { async update(id, opts) { focusCalls.push({ kind: 'window', id, opts }); } },
  runtime: {},
};

const { cdpCapturePointer, cdpMoveMouse } = await import('../extension/js/page-actions-cdp.js');

// Pointer state is cached per tab for a moment (aiming is a burst, and probing
// before every step would put a round-trip on the hot path). So each case below
// uses its OWN tab id rather than sleeping out the TTL.
const reset = () => { sent.length = 0; focusCalls.length = 0; };

// 1) Capture focuses the tab AND the window before clicking — without focus the
//    page's requestPointerLock() is rejected, which is the whole bug.
{
  reset();
  locksOnClick = true;
  state = { ...state, locked: false };
  const r = await cdpCapturePointer(1);
  assert.equal(r.ok, true, 'captured');
  assert.equal(r.pointerLock, true);
  assert.ok(focusCalls.some((c) => c.kind === 'tab' && c.opts.active === true), 'activated the tab');
  assert.ok(focusCalls.some((c) => c.kind === 'window' && c.opts.focused === true), 'focused the window');
  assert.deepEqual(r.capturedAt, { x: 500, y: 400 }, 'clicked the canvas centre');
  // Activating the tab is NOT enough — within the window, focus can still sit on
  // the side panel, and an unfocused document has its lock request rejected.
  assert.ok(
    sent.some((s) => s.method === 'Emulation.setFocusEmulationEnabled' && s.params.enabled === true),
    'forced focus emulation so the renderer treats the page as focused',
  );
  assert.ok(sent.some((s) => s.method === 'Page.bringToFront'), 'brought the CDP target to front');
  assert.equal(r.focusEmulated, true);
}

// 2) Already captured → no redundant click.
{
  reset();
  state = { ...state, locked: true };
  const r = await cdpCapturePointer(2);
  assert.equal(r.alreadyCaptured, true);
  assert.equal(sent.filter((s) => s.params?.type === 'mousePressed').length, 0, 'did not click again');
}

// 3) THE HONEST FAILURE: the click lands but the app never takes the pointer.
//    This must report ok:false with a diagnosis — not a bare success that leaves
//    the agent aiming into the void.
{
  reset();
  locksOnClick = false;
  state = { ...state, locked: false };
  elementAtPoint = { tag: 'canvas', id: '', cls: '', text: '' };
  const r = await cdpCapturePointer(3);
  assert.equal(r.ok, false);
  assert.equal(r.pointerLock, false);
  assert.match(r.error, /did not take the pointer/i);
  assert.match(r.error, /ask the user to click once/i, 'gives the user-facing fallback');
  assert.ok(sent.some((s) => s.params?.type === 'mousePressed'), 'it did try');
}

// 3b) The most useful failure: an overlay swallowed the click. The diagnosis must
//     name what was actually hit rather than blaming pointer lock generically.
{
  reset();
  locksOnClick = false;
  state = { ...state, locked: false };
  elementAtPoint = { tag: 'div', id: 'splash', cls: 'overlay', text: 'Click to play' };
  const r = await cdpCapturePointer(31);
  assert.equal(r.ok, false);
  assert.deepEqual(r.elementAtPoint, elementAtPoint);
  assert.match(r.error, /NOT the canvas/, 'says the click missed the canvas');
  assert.match(r.error, /Click to play/, 'quotes what it hit');
  elementAtPoint = { tag: 'canvas', id: '', cls: '', text: '' };
}

// 4) A relative move on an UNCAPTURED canvas app must warn that it was a cursor
//    slide, not a view turn — the exact misreading that made every aim look "ok".
{
  reset();
  state = { ...state, locked: false, canvasApp: true };
  const r = await cdpMoveMouse(4, { dx: -650, dy: 100 });
  assert.equal(r.pointerLock, false);
  assert.match(r.warning, /not.*pointer lock/i);
  assert.match(r.warning, /capture_pointer/, 'names the fix');
}

// 5) Same move on a NON-canvas page gets the milder hint (no capture advice —
//    there is nothing to capture on an ordinary web page).
{
  reset();
  state = { ...state, locked: false, canvasApp: false };
  const r = await cdpMoveMouse(5, { dx: 10, dy: 10 });
  assert.match(r.warning, /absolute/i);
  assert.ok(!/capture_pointer/.test(r.warning), 'no capture advice off-canvas');
}

// 6) Captured: a relative move IS a turn, and is not clamped to the viewport —
//    clamping would silently swallow every further turn past an edge.
{
  reset();
  state = { ...state, locked: true, canvasApp: true };
  await cdpMoveMouse(6, { dx: 5000, dy: 0 });
  const move = sent.find((s) => s.params?.type === 'mouseMoved');
  assert.ok(move.params.x > 1000, `allowed to drift off-viewport, got x=${move.params.x}`);
}

// 7) Captured: click_at must NOT move first — a pre-click move is a camera turn,
//    which would swing the aim off target before the click lands.
{
  reset();
  state = { ...state, locked: true };
  const { cdpClickAt } = await import('../extension/js/page-actions-cdp.js');
  const r = await cdpClickAt(7, 123, 456, 'right', 1);
  assert.equal(r.pointerLock, true);
  assert.ok(!sent.some((s) => s.params?.type === 'mouseMoved'), 'no pre-click move while captured');
  assert.match(r.note, /ignored/i, 'tells the caller its coordinates did nothing');
  const press = sent.find((s) => s.params?.type === 'mousePressed');
  assert.equal(press.params.button, 'right');
}

console.log('pointer-capture tests passed');
