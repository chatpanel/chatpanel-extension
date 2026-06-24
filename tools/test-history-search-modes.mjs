import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const historyHtml = readFileSync(new URL('../extension/history.html', import.meta.url), 'utf8');
const historyJs = readFileSync(new URL('../extension/history.js', import.meta.url), 'utf8');

assert.match(historyHtml, /data-mode="smart"[\s\S]*Best match/, 'history search should expose Best match.');
assert.match(historyHtml, /data-mode="keyword"[\s\S]*Exact text/, 'history search should expose Exact text.');
assert.doesNotMatch(historyHtml, /data-mode="agent"/, 'history search should not expose an Agent mode tab.');
assert.doesNotMatch(historyHtml, />\s*Agent\s*</, 'history search should not show an Agent mode label.');

assert.match(historyJs, /let mode = 'smart';\s*\/\/ smart \| keyword/, 'history search mode should only document smart and keyword.');
assert.doesNotMatch(historyJs, /mode === 'agent'/, 'history search should not branch on an agent mode.');
assert.doesNotMatch(historyJs, /function searchAgent\(/, 'history page should not keep the old Agent-mode action.');
assert.doesNotMatch(historyJs, /dataset\.mode === 'agent'/, 'history mode buttons should not activate an Agent mode.');

console.log('history search mode tests passed');
