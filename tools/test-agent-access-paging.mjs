// The cross-agent read log is unbounded — a working agent writes hundreds of rows — so the
// settings page renders a page of it, not all of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paginateEntries } from '../extension/js/paginate.js';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('settings.js');
const css = read('settings.css');
const search = read('js/conversation-search.js');
const paginate = read('js/paginate.js');

// One implementation, reused — not a second copy next to the first.
assert.match(js, /import \{ paginateEntries \} from '\.\/js\/paginate\.js'/, 'settings must reuse the shared pager.');
assert.match(search, /export \{ paginateEntries \} from '\.\/paginate\.js'/, 'the old home must re-export, not re-implement.');
assert.ok(!/export function paginateEntries/.test(search), 'there must be exactly one paginateEntries.');
// The point of the extraction: settings must not drag a BM25 index in to slice an array.
assert.ok(!/^import/m.test(paginate), 'the pager must be a leaf — nothing behind it.');

assert.match(js, /function renderAgentAccess\(\)/, 'the access table must render on its own, without re-fetching.');
assert.match(js, /OBS_ACCESS_PAGE_SIZE/, 'the page size must be named.');
assert.match(js, /obsAccessPage = pageData\.page/, 'the page must be clamped by the pager, not reset on refresh.');
assert.match(js, /id="obs-access-prev"/, 'there must be a previous-page control.');
assert.match(js, /id="obs-access-next"/, 'there must be a next-page control.');
assert.match(js, /obs-access-next'\)\?\.addEventListener\('click', \(\) => \{ obsAccessPage \+= 1; renderAgentAccess\(\); \}\)/,
  'paging must re-render from memory — never ask the gateway again.');
assert.match(css, /\.obs-pager/, 'the pager must be styled.');

// The arithmetic itself, on the shape this table uses.
const rows = Array.from({ length: 137 }, (_, i) => ({ ts: i, tool: 't' }));
const p1 = paginateEntries(rows, { page: 1, pageSize: 25 });
assert.equal(p1.items.length, 25);
assert.equal(p1.start, 1);
assert.equal(p1.hasPrev, false);
assert.equal(p1.hasNext, true);
const last = paginateEntries(rows, { page: 99, pageSize: 25 });
assert.equal(last.page, 6, 'a page past the end clamps to the last real one');
assert.equal(last.end, 137);
assert.equal(last.hasNext, false);
const empty = paginateEntries([], { page: 3, pageSize: 25 });
assert.deepEqual([empty.page, empty.start, empty.end, empty.total], [1, 0, 0, 0]);

console.log('ok — the agent-access log pages, and there is one pager doing it');
