import assert from 'node:assert/strict';
import { normalizeSteps } from '../extension/js/page-actions-cdp.js';

const types = (steps) => normalizeSteps(steps).map((s) => s.type);

// THE REPORTED FAILURE. The dispatcher teaches {action, args} at the top level, so a model
// that had just learned it reused it one level down — got `unknown step type "undefined"`,
// retried the identical call three times, then emitted malformed tool syntax and gave up.
// That is our inconsistency surfacing as the model's failure.
const asPageActions = normalizeSteps([
  { action: 'click_at', args: { x: 500, y: 630 } },
  { action: 'click_at', args: { x: 700, y: 630 } },
]);
assert.deepEqual(asPageActions.map((s) => s.type), ['move', 'mouse_down', 'mouse_up', 'move', 'mouse_down', 'mouse_up']);
assert.deepEqual({ x: asPageActions[0].x, y: asPageActions[0].y }, { x: 500, y: 630 });

// A drag becomes press, move, release — the combination a small model cannot express as
// primitives but can express as a drag.
assert.deepEqual(
  types([{ action: 'drag_at', args: { x: 500, y: 550, toX: 700, toY: 550 } }]),
  ['move', 'mouse_down', 'move', 'mouse_up'],
);
const drag = normalizeSteps([{ action: 'drag_at', args: { x: 5, y: 6, toX: 70, toY: 80 } }]);
assert.deepEqual({ x: drag[2].x, y: drag[2].y }, { x: 70, y: 80 }, 'the drag destination was lost');
// The lowercase spelling a model actually emitted (`dragat`, `tox`) works too.
assert.deepEqual(types([{ action: 'dragat', args: { x: 1, y: 2, tox: 3, toy: 4 } }]), ['move', 'mouse_down', 'move', 'mouse_up']);

// The documented primitive shape is untouched — this is additive, not a replacement.
const primitives = [
  { type: 'key_down', key: 'shift' },
  { type: 'mouse_down', button: 'left' },
  { type: 'move', dx: 120, dy: 0 },
  { type: 'mouse_up', button: 'left' },
  { type: 'key_up', key: 'shift' },
];
assert.deepEqual(normalizeSteps(primitives), primitives);

// Underscore-free spellings are accepted rather than corrected: small models drop them,
// and rejecting "keydown" teaches nothing that accepting it does not.
assert.deepEqual(types([{ type: 'keydown', key: 'a' }, { type: 'mouseup' }]), ['key_down', 'mouse_up']);

// press_key expands to a down/up pair, so a key press composes inside a held combination.
assert.deepEqual(types([{ action: 'press_key', args: { key: 'Enter' } }]), ['key_down', 'key_up']);

// Mixed shapes in one sequence — a model part-way through learning the convention.
assert.deepEqual(
  types([{ type: 'key_down', key: 'shift' }, { action: 'click_at', args: { x: 1, y: 2 } }, { type: 'key_up', key: 'shift' }]),
  ['key_down', 'move', 'mouse_down', 'mouse_up', 'key_up'],
);

// An unknown step is passed through UNCHANGED so the executor raises its own correctable
// error. Guessing here would turn a clear failure into a silent wrong action.
assert.deepEqual(normalizeSteps([{ type: 'teleport', x: 1 }]), [{ type: 'teleport', x: 1 }]);
assert.deepEqual(normalizeSteps([]), []);
assert.deepEqual(normalizeSteps(null), []);

console.log('✓ input_sequence: page actions compose as steps, both shapes accepted');
