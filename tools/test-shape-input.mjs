import assert from 'node:assert/strict';
import { shapeListFrom, normalizeShape } from '../extension/js/canvas-adapters.js';

// Every adapter declares `elements`; models keep sending `shapes`. On tldraw a run sent
// `shapes` three times and got "no elements or native shapes provided" each time — a message
// that names the key it wanted only if you already know the answer. The word is arbitrary
// (tldraw's own API calls them shapes) and the payload was correct, so rejecting it taught
// the model nothing except that the tool was broken.
const shapes = [{ type: 'ellipse', x: 0, y: 0, width: 200, height: 180 }];

assert.deepEqual(shapeListFrom({ elements: shapes }), shapes, 'the documented key must keep working');
assert.deepEqual(shapeListFrom({ shapes }), shapes, 'the key a real model sent was rejected');
assert.deepEqual(shapeListFrom({ items: shapes }), shapes);
assert.deepEqual(shapeListFrom({ nodes: shapes }), shapes);
// A bare array is unambiguous — refusing it would be pedantry, not safety.
assert.deepEqual(shapeListFrom(shapes), shapes);

// `elements` wins when both are present, so the documented key stays authoritative and the
// synonym can never silently override it.
assert.deepEqual(shapeListFrom({ elements: shapes, shapes: [{ type: 'rectangle' }] }), shapes);

// Nothing usable is still nothing — the caller's error path must stay reachable.
assert.deepEqual(shapeListFrom({}), []);
assert.deepEqual(shapeListFrom(null), []);
assert.deepEqual(shapeListFrom({ elements: 'not an array' }), []);

// ── the same tolerance one level down, where it matters more ─────────────────
// A model sent {type:"ellipse", x:0, y:0, w:200, h:180} — correct except that we only read
// width/height. Thirteen shapes were inserted, every dimension dropped, and they came out
// identically sized and piled on top of each other while the tool reported success.
// Silently ignoring a field is the worst option available: the call succeeds, the drawing
// is wrong, and nothing says why.
const abbreviated = normalizeShape({ type: 'ellipse', x: 0, y: 0, w: 200, h: 180 });
assert.equal(abbreviated.width, 200);
assert.equal(abbreviated.height, 180);
// The original keys survive, so an adapter that reads either still works.
assert.equal(abbreviated.w, 200);

// An explicit key always wins over its alias — the documented name stays authoritative.
assert.equal(normalizeShape({ width: 10, w: 999 }).width, 10);
assert.equal(normalizeShape({ strokeColor: 'red', color: 'blue' }).strokeColor, 'red');

// `color` maps to the stroke because every shape has one; guessing it meant the fill would
// be inventing intent from an ambiguous word.
assert.equal(normalizeShape({ color: 'black' }).strokeColor, 'black');
assert.equal(normalizeShape({ background: '#fff' }).backgroundColor, '#fff');
assert.equal(normalizeShape({ label: 'hi' }).text, 'hi');

// Normalisation runs across the whole list, whichever key the list arrived under.
const viaShapes = shapeListFrom({ shapes: [{ type: 'ellipse', w: 5, h: 6 }] });
assert.deepEqual([viaShapes[0].width, viaShapes[0].height], [5, 6]);

// Non-objects pass through untouched rather than being coerced into something.
assert.equal(normalizeShape(null), null);
assert.equal(normalizeShape('x'), 'x');

console.log('✓ shape input: documented keys authoritative, obvious aliases accepted at both levels');
