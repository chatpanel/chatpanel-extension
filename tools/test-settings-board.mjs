// Settings → Teams → Board: the run store's threads as a board, with an ask a person can
// answer, a draft to approve, a reply box. Driven against a DOM shim over a fake store.
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.style = ''; this.innerHTML = ''; this.hidden = false; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(typeof k === 'string' ? { text: k } : k); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  focus() { document.activeElement = this; }
  type(text) { this.value = text; for (const fn of this.listeners.input || []) fn({}); }
  *walk() { yield this; for (const c of this.children) if (c instanceof El) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  all(pred) { return [...this.walk()].filter(pred); }
  querySelector(sel) { return this.find((n) => (sel.startsWith('#') ? n.id === sel.slice(1) : n.className.split(/\s+/).includes(sel.slice(1)))); }
}
Object.defineProperty(El.prototype, 'innerHTML', { get() { return this._html || ''; }, set(v) { this._html = v; if (v === '') this.children = []; } });
globalThis.document = { createElement: (t) => new El(t), activeElement: null };
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {} } } };

// The gateway, as the board reads it.
const run = {
  id: 'run_1', team: 'travel', status: 'running', client: 'desktop', createdAt: 1, request: 'a trip', roles: ['researcher', 'planner'],
  tasks: [{ id: 't1', role: 'researcher', status: 'waiting', findings: 1, model: 'claude/opus' }],
  usage: { cap: { tokens: 30000 }, spent: { tokens: 1200 } },
  threads: {
    threads: [
      { id: 'th1', kind: 'task', taskId: 't1', title: 'Find facts', by: 'runner', status: 'open', at: 1, posts: 1 },
      { id: 'ask1', kind: 'ask', taskId: 't1', title: 'Which week?', by: 'researcher', status: 'waiting', at: 2, posts: 1, ask: { type: 'info', options: ['Feb 13-17'] } },
      { id: 'prop', kind: 'proposal', title: 'Proposal', by: 'planner', status: 'open', at: 3, posts: 1 },
    ],
    posts: [
      { id: 'p1', threadId: 'th1', by: 'researcher', kind: 'finding', text: 'Rooms **$260**', refs: ['web:x'], replyTo: null, status: 'open', at: 1, finding: { kind: 'claim' } },
      { id: 'q1', threadId: 'ask1', by: 'researcher', kind: 'question', text: 'Which week?', refs: [], replyTo: null, status: 'open', at: 2, ask: { type: 'info', options: ['Feb 13-17'] } },
      { id: 'd1', threadId: 'prop', by: 'planner', kind: 'draft', text: '# Plan\n\nDay 1', refs: [], replyTo: null, status: 'proposed', at: 3 },
    ],
  },
};
const calls = [];
const fakeFetch = async (url, opts = {}) => {
  calls.push([opts.method || 'GET', String(url).replace(/^.*\/v1\//, '/v1/'), opts.body ? JSON.parse(opts.body) : null]);
  const u = String(url);
  const json = (data) => ({ ok: true, status: 200, json: async () => data });
  if (/\/v1\/teams\/runs\?/.test(u)) return json({ ok: true, runs: [{ id: 'run_1', team: 'travel', status: 'running', waiting: 1, createdAt: 1 }] });
  if (/\/v1\/teams\/runs\/run_1$/.test(u)) return json({ ok: true, run });
  if (/\/(answer|decide|post|stop)$/.test(u)) return json({ ok: true, run });
  if (/admin\/token/.test(u)) return json({ token: 't' });
  return json({ ok: true });
};
globalThis.fetch = fakeFetch;

const { renderBoard } = await import('../extension/js/settings-board.js');
const root = new El('div');
const dispose = renderBoard(root, { settings: { gatewayUrl: 'http://127.0.0.1:1' } });
await new Promise((r) => setTimeout(r, 30));
const btn = (re, from = root) => from.find((n) => n.tagName === 'BUTTON' && re.test(n.textContent));
assert.ok(root.all((n) => n.className.includes('bth')).length >= 3, 'three threads listed');
assert.ok(root.find((n) => n.className.includes('bgrp') && n.textContent === 'Waiting on you'), 'the waiting ask is pinned');
// The ask is selected first and offers its option.
const opt = btn(/^Feb 13-17$/);
assert.ok(opt, 'the ask\'s option is a button');
opt.click();
await new Promise((r) => setTimeout(r, 30));
const answered = calls.find(([m, u]) => m === 'POST' && u.endsWith('/answer'));
assert.ok(answered, 'answering posts to the gateway');
assert.equal(answered[2].text, 'Feb 13-17');
assert.equal(answered[2].by, 'person');
// Open the proposal; the draft renders as markdown and can be approved.
btn(/^Proposal$/) || root.find((n) => n.className.includes('bth-t') && n.textContent === 'Proposal');
const propRow = root.find((n) => n.className.includes('bth') && n.find((x) => x.textContent === 'Proposal'));
propRow.click();
await new Promise((r) => setTimeout(r, 5));
const md = root.find((n) => n.className.includes('btext'));
assert.match(md.innerHTML, /<h1[^>]*>Plan<\/h1>/, 'a post renders as markdown');
btn(/^Approve$/).click();
await new Promise((r) => setTimeout(r, 30));
const decided = calls.find(([m, u]) => m === 'POST' && u.endsWith('/decide'));
assert.deepEqual([decided[2].postId, decided[2].status], ['d1', 'approved']);

// A DRAFT SURVIVES THE POLL. Half a reply typed, then the store refreshes (Approve above did
// exactly that): the box the person is typing in is left alone — same element, same text.
const box = () => root.find((n) => n.tagName === 'TEXTAREA' && /Reply in this thread/.test(n.attrs.placeholder));
const ta1 = box();
ta1.focus(); ta1.type('half a sentence');
btn(/^Reject$/).click();
await new Promise((r) => setTimeout(r, 30));
assert.equal(box(), ta1, 'a poll does not rebuild the pane while a draft has focus');
assert.equal(ta1.value, 'half a sentence');
// A deliberate redraw (Reply to a post) rebuilds the pane — and the draft comes back into the
// new box, focused.
btn(/^Reply$/).click();
const ta2 = box();
assert.notEqual(ta2, ta1, 'Reply redraws the pane');
assert.equal(ta2.value, 'half a sentence', 'the draft is restored into the new box');
assert.equal(document.activeElement, ta2, 'and keeps focus');
// Posting clears it.
btn(/^Post$/).click();
await new Promise((r) => setTimeout(r, 30));
const posted = calls.find(([m, u]) => m === 'POST' && u.endsWith('/post'));
assert.equal(posted[2].text, 'half a sentence');
assert.equal(posted[2].replyTo, 'd1');
assert.equal(box().value, '', 'posted: the box is empty again');
dispose();
console.log('settings-board: ok');
