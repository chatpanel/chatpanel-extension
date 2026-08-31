// Which engine / which tier answered? The step must say so — "web_search" alone doesn't
// tell you whether Brave or DuckDuckGo served it, or whether history came from the browser
// index or the gateway's warm copy. Both differ in coverage and freshness.
import assert from 'node:assert/strict';
import { toolStatus } from '../extension/js/tool-hints.js';
import { resultText } from '../extension/js/adaptive-tool-policy.js';

// A provider reports provenance through `note`; the model still reads `text` untouched.
const webResult = { text: '1. [A Title](https://example.com)', note: 'ChatPanel · brave, startpage' };
assert.equal(toolStatus(webResult), 'ChatPanel · brave, startpage', 'the badge names the engines');
assert.equal(resultText(webResult), '1. [A Title](https://example.com)', 'the model sees only the text');

const histResult = { text: 'results…', note: 'ChatPanel · browser + gateway' };
assert.equal(toolStatus(histResult), 'ChatPanel · browser + gateway', 'the badge names the tier');

// An error still wins over a note — provenance must never mask a failure.
assert.match(toolStatus({ error: 'boom', note: 'ChatPanel · brave' }), /^error: /);

// A plain string result (every other tool) is unchanged.
assert.equal(toolStatus('just text'), '');
assert.equal(resultText('just text'), 'just text');

console.log('ok — steps report which engine/tier answered, without changing what the model reads');
