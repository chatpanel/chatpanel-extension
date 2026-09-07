// "Go to google.com and search for chat panel", said from a New Tab page, used to reach an
// agent with no page tools at all — the provider returned null wherever the tab was not a web
// page, and open_tab went with it. These pin the fallback: one action, gated, and honest.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeOpenTabOnlyProvider, openTabOnlySystem, whereNoPage } from '../extension/js/page-tools-anywhere.js';
import { PAGE_TOOL_SPECS } from '../extension/js/page-tools.js';

const spec = PAGE_TOOL_SPECS.find((s) => s.name === 'open_tab');
const SEARCH_URL = 'https://www.google.com/search?q=chat+panel';
const build = (gate, run) => makeOpenTabOnlyProvider({ spec, where: 'a new tab', gate, run });
const call = (p, action, args) => p.execute('page', { action, args });

// ── it offers exactly one action ──────────────────────────────────────────────
{
  const p = build(async () => true, async () => ({ ok: true }));
  assert.equal(p.specs.length, 1, 'one dispatch tool');
  const text = JSON.stringify(p.specs[0]);
  assert.match(text, /open_tab/);
  for (const other of ['navigate', 'read_page', 'click_at', 'screenshot', 'eval_js']) assert.doesNotMatch(text, new RegExp(other), `${other} must not be offered without a page`);
  assert.match(p.system, /not a web page/);
  assert.match(p.system, /open_tab/);
  assert.match(p.system, /Never tell the user you cannot open a page/);
}

// ── approved: the browser call runs with the url, focus defaults on ───────────
{
  const calls = [];
  const p = build(async () => true, async (url, opts) => { calls.push([url, opts]); return { url, tabId: 7 }; });
  const out = JSON.parse(await call(p, 'open_tab', { url: SEARCH_URL }));
  assert.deepEqual(calls, [[SEARCH_URL, { active: true }]]);
  assert.equal(out.tabId, 7);
  assert.match(out.note, /Nothing here can read or act on it/);
}

// ── declined: nothing opens, and the model is told not to retry ───────────────
{
  let ran = 0;
  const p = build(async () => false, async () => { ran++; return {}; });
  const out = JSON.parse(await call(p, 'open_tab', { url: SEARCH_URL }));
  assert.equal(ran, 0, 'a declined open must not reach the browser');
  assert.match(out.error, /DECLINED/);
}

// ── the gate sees the url it is approving ─────────────────────────────────────
{
  let seen = null;
  const p = build(async (input) => { seen = input; return true; }, async () => ({}));
  await call(p, 'open_tab', { url: SEARCH_URL, focus: false });
  assert.equal(seen.url, SEARCH_URL);
}

// ── anything else is refused with the reason, not silently ignored ────────────
{
  let ran = 0;
  const p = build(async () => true, async () => { ran++; return {}; });
  const out = JSON.parse(await call(p, 'navigate', { url: SEARCH_URL }));
  assert.equal(ran, 0);
  assert.match(String(out.error || ''), /open_tab|unknown|not/i);
}

// ── the wrong spec is a programming error, not a quiet no-op ─────────────────
assert.throws(() => makeOpenTabOnlyProvider({ spec: PAGE_TOOL_SPECS.find((s) => s.name === 'navigate'), gate: async () => true, run: async () => ({}) }));

// ── where the user is, in words ───────────────────────────────────────────────
assert.equal(whereNoPage(''), 'a new tab');
assert.equal(whereNoPage('chrome://newtab/'), 'a new tab');
assert.equal(whereNoPage('chrome://settings/privacy'), 'a browser settings page');
assert.equal(whereNoPage('chrome-extension://abc/notes.html'), 'an extension page');
assert.equal(whereNoPage('file:///tmp/a.pdf'), 'a local file');
assert.match(openTabOnlySystem('a new tab'), /current tab is a new tab/);

// ── the side panel takes this path instead of returning null ──────────────────
{
  const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const at = src.indexOf('no readable web tab is active');
  assert.ok(at > 0, 'the no-readable-tab branch still exists');
  const branch = src.slice(at, src.indexOf('\n  }\n', at));
  assert.doesNotMatch(branch, /return null/, 'no readable tab must NOT mean no tools');
  assert.match(branch, /import\('\.\/js\/page-tools-anywhere\.js'\)/, 'the fallback is dynamic-imported (off first paint)');
  assert.match(branch, /spokenAuthorityFor\('open_tab'/, 'a spoken destination still counts as approval');
  assert.match(branch, /confirmPageAction\(/, 'otherwise the exact URL is confirmed');
  assert.doesNotMatch(src, /^import[^\n]*page-tools-anywhere/m, 'never a static import');
}

console.log('✓ page tools anywhere: without a web page the agent still gets open_tab — gated, alone, and told why');
