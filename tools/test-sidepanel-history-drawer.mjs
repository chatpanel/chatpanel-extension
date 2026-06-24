import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

assert.match(html, /id="history-modes"/, 'History drawer should expose search mode controls.');
assert.match(html, /data-mode="smart"[^>]*>Best match</, 'History drawer should have a Best match search mode.');
assert.match(html, /data-mode="keyword"[^>]*>Exact text</, 'History drawer should have an Exact text search mode.');
assert.match(html, /id="history-page-prev"/, 'History drawer should have a previous page button.');
assert.match(html, /id="history-page-next"/, 'History drawer should have a next page button.');
assert.match(html, /id="history-page-status"/, 'History drawer should show page/range status.');

assert.match(js, /HISTORY_PAGE_SIZE/, 'History drawer should use a bounded page size.');
assert.match(js, /rankConversationEntries/, 'History drawer should use ranked conversation search.');
assert.match(js, /paginateEntries/, 'History drawer should paginate matching conversations.');
assert.match(js, /historyView\.mode/, 'History drawer should track the selected search mode.');
assert.match(js, /getConversation\(e\.id\)/, 'History drawer should load conversation bodies when searching.');

assert.match(css, /\.history-modes/, 'History drawer search mode controls should be styled.');
assert.match(css, /\.history-pager/, 'History drawer pager should be styled.');

console.log('sidepanel history drawer tests passed');
