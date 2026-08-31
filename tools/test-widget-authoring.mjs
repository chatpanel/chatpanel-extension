// Nobody should have to know an API to ask for a timer. The model is what should know it —
// otherwise the whole widget surface is undiscoverable and it writes a paragraph describing
// a timer instead of building one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { widgetAuthoringSystem } from '../extension/js/tool-hints.js';

const sys = widgetAuthoringSystem();

// It must name the thing the user cannot be expected to know.
assert.match(sys, /chatpanel\.setState/, 'names the save call');
assert.match(sys, /chatpanel\.getState/, 'and how to load it back');
assert.match(sys, /```html/, 'and the shape ChatPanel actually renders');
assert.match(sys, /Keep/, 'and that keeping it is what makes it permanent');

// The two traps a model would otherwise fall into.
assert.match(sys, /localStorage/, 'warns off localStorage, which the sandbox discards');
assert.match(sys, /NO network access/i, 'and off fetching, which the sandbox blocks');

// It has to actually reach the model, on turns with tools and without.
const turn = readFileSync(new URL('../extension/js/turn-tools.js', import.meta.url), 'utf8');
assert.match(turn, /const widgetSystem = widgetAuthoringSystem\(\)/, 'built every turn');
assert.match(turn, /system = \[skillSystem, widgetSystem\]/, 'reaches a turn with no toolset');
assert.match(turn, /\[skillSystem, catalogSystem, widgetSystem, toolset\.system\]/, 'and a turn with one');

// It rides on every turn, so it must stay cheap.
assert.ok(sys.length < 1400, `guidance is ${sys.length} chars — keep it lean, it ships every turn`);

console.log(`ok — the model is told how to build a keepable widget (${sys.length} chars)`);
