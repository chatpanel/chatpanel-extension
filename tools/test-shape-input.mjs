import assert from 'node:assert/strict';
import { shapeListFrom } from '../extension/js/canvas-adapters.js';

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

console.log('✓ shape input: the documented key is authoritative, the obvious synonyms are accepted');
