// The panel tells every model what it can RENDER. Without this, an agent with filesystem
// tools answers "make me a game" by writing index.html and telling the user to open it —
// the thing they asked to see never appears in the chat.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('function runtimeContextSystem'));
const body = fn.slice(0, fn.indexOf('\n}\n'));

// It names each renderable block type, so the model knows which fence to reach for.
for (const kind of ['html', 'mermaid', 'svg']) {
  assert.ok(body.includes(kind), `the render hint names \`\`\`${kind}`);
}
// And it closes the exact failure mode: file-only answers.
assert.match(body, /IN YOUR REPLY/, 'asks for the code in the reply');
assert.match(body, /only to a file|open a file in a browser/, 'names the file-only failure');
// It must not forbid writing files — agents that can, should still do both.
assert.match(body, /write the file too/, 'writing a file as well is still allowed');

console.log('ok — models are told what the panel renders, and to put the code in the reply');
