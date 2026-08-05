// Composite input: the CDP events a sequence emits must carry the modifier and
// button bitmasks that are held AT THAT MOMENT — otherwise a Shift-drag reaches
// the page as a plain drag — and nothing may be left held when it ends.
import assert from 'node:assert/strict';

const sent = [];          // every dispatched CDP command
let pointerLocked = false;

globalThis.chrome = {
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand(_target, method, params) { sent.push({ method, params }); },
    onDetach: { addListener() {} },
  },
  scripting: {
    // The only injected read a sequence makes is the pointer state.
    async executeScript() {
      return [{ result: { locked: pointerLocked, w: 1000, h: 800 } }];
    },
  },
  tabs: { async get() { return { windowId: 1 }; }, async captureVisibleTab() { return null; } },
  runtime: {},
};

const { cdpInputSequence } = await import('../extension/js/page-actions-cdp.js');

const keyEvents = () => sent.filter((s) => s.method === 'Input.dispatchKeyEvent');
const mouseEvents = () => sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
const reset = () => { sent.length = 0; };

// 1) Shift held across a drag: every event between the modifier down and up must
//    report modifiers=8, and the move must report the held button.
{
  reset();
  const r = await cdpInputSequence(1, [
    { type: 'key_down', key: 'shift' },
    { type: 'mouse_down', button: 'left' },
    { type: 'move', dx: 120, dy: 0 },
    { type: 'mouse_up', button: 'left' },
    { type: 'key_up', key: 'shift' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.steps, 5);

  const down = mouseEvents().find((e) => e.params.type === 'mousePressed');
  assert.equal(down.params.modifiers, 8, 'press carries Shift');
  assert.equal(down.params.buttons, 1, 'left button in the held mask');

  const move = mouseEvents().find((e) => e.params.type === 'mouseMoved');
  assert.equal(move.params.modifiers, 8, 'move carries Shift');
  assert.equal(move.params.buttons, 1, 'move reports the button still held');

  const up = mouseEvents().find((e) => e.params.type === 'mouseReleased');
  assert.equal(up.params.buttons, 0, 'button cleared from the mask on release');
}

// 2) Two direction keys at once — both stay down across the wait, so the app sees
//    diagonal movement rather than two sequential nudges.
{
  reset();
  await cdpInputSequence(1, [
    { type: 'key_down', key: 'w' },
    { type: 'key_down', key: 'a' },
    { type: 'wait', ms: 5 },
    { type: 'key_up', key: 'a' },
    { type: 'key_up', key: 'w' },
  ]);
  const evs = keyEvents();
  assert.equal(evs.filter((e) => e.params.type === 'rawKeyDown').length, 2);
  assert.equal(evs.filter((e) => e.params.type === 'keyUp').length, 2);
  // No keyUp for 'w' before 'a' went down → they genuinely overlapped.
  const wUpIdx = evs.findIndex((e) => e.params.type === 'keyUp' && e.params.key === 'w');
  const aDownIdx = evs.findIndex((e) => e.params.type === 'rawKeyDown' && e.params.key === 'a');
  assert.ok(aDownIdx < wUpIdx, 'a goes down while w is still held');
}

// 3) THE SAFETY PROPERTY: a step that fails mid-sequence still releases whatever
//    is held, so the page is never stranded with a stuck key or button.
{
  reset();
  const r = await cdpInputSequence(1, [
    { type: 'key_down', key: 'shift' },
    { type: 'mouse_down', button: 'left' },
    { type: 'bogus_step' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown step type/);
  assert.ok(
    mouseEvents().some((e) => e.params.type === 'mouseReleased'),
    'held button released despite the failure',
  );
  assert.ok(
    keyEvents().some((e) => e.params.type === 'keyUp' && e.params.key === 'Shift'),
    'held modifier released despite the failure',
  );
}

// 4) The clipboard block can't be bypassed by holding the modifier separately.
{
  reset();
  const r = await cdpInputSequence(1, [
    { type: 'key_down', key: 'ctrl' },
    { type: 'key_down', key: 'v' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /clipboard/i);
  assert.ok(
    keyEvents().some((e) => e.params.type === 'keyUp' && e.params.key === 'Control'),
    'the modifier it did press is still released',
  );
}

// 5) Under pointer lock, absolute moves are refused (they would be silently
//    meaningless) while relative turns are allowed.
{
  pointerLocked = true;
  reset();
  const bad = await cdpInputSequence(1, [{ type: 'move', x: 100, y: 100 }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /pointer lock/i);

  reset();
  const good = await cdpInputSequence(1, [{ type: 'move', dx: 40, dy: -10 }]);
  assert.equal(good.ok, true);
  assert.equal(good.pointerLock, true);
  pointerLocked = false;
}

// 6) Bounds: an over-long sequence is refused up front rather than half-run.
{
  reset();
  const r = await cdpInputSequence(1, Array.from({ length: 41 }, () => ({ type: 'wait', ms: 0 })));
  assert.equal(r.ok, false);
  assert.match(r.error, /too many steps/);
  assert.equal(sent.length, 0, 'nothing dispatched');
}

// 7) An empty list is a no-op error, not a crash.
{
  reset();
  assert.equal((await cdpInputSequence(1, [])).ok, false);
  assert.equal((await cdpInputSequence(1, undefined)).ok, false);
}

console.log('input-sequence tests passed');
