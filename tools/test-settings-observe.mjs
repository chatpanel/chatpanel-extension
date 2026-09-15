// Settings → Agent Teams → Observe and → Projects (F8 §17.2) render against the same DOM shim as
// the other org cards: the strip's five numbers, the four panels, a run's lanes from a record,
// and a project's rounds — every number from the shared team-observe.js, "—" for nothing.
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.style = ''; this.disabled = false; this.classList = { toggle: (c, on) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) set.add(c); else set.delete(c); this.className = [...set].join(' '); } }; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
  getAttribute(k) { return this.attrs[k]; }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(typeof k === 'string' ? { text: k } : k); }
  appendChild(k) { this.append(k); return k; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  *walk() { yield this; for (const c of this.children) if (c instanceof El) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  all(pred) { return [...this.walk()].filter(pred); }
  querySelector(sel) { return this.find((n) => sel.startsWith('.') && n.className.split(/\s+/).includes(sel.slice(1))); }
  querySelectorAll(sel) { return this.all((n) => (sel.startsWith('.') ? n.className.split(/\s+/).includes(sel.slice(1)) : sel.startsWith('[') && n.attrs[sel.slice(1, -1)] !== undefined)); }
}
globalThis.document = { createElement: (t) => new El(t) };
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {} } } };

// The gateway, faked at fetch: one live run with a task on the record, one engine card, one project.
const now = Date.now();
const run = { id: 'r1', team: 'research', request: 'ORCL — hold or sell?', status: 'running', createdAt: now - 300000, startedAt: now - 300000, lastEventAt: now - 5000, roles: [{ id: 'researcher', agent: 'research-researcher' }], tasks: [{ id: 't1', role: 'researcher', title: 'gather', status: 'running', startedAt: now - 280000 }], usage: { spent: { ms: 280000, tokens: 1200, usd: 0.4 } } };
const project = { id: 'orcl', status: 'active', page: { title: 'ORCL — hold or sell?', goal: 'Decide.', doneWhen: 'a recommendation', budget: { usd: 4 }, gate: { human: { recruit: false, newAgent: true } } }, spend: { usd: 1.6 }, jobs: [{ id: 'gather', title: 'gather-filings', status: 'done', recruited: { agentId: 'research-researcher', fit: 0.82, engine: 'harness:claude' } }, { id: 'write', title: 'write', status: 'open', dependsOn: ['gather'] }], runs: [], decisions: [] };
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (data) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) });
  if (/\/v1\/teams\/runs\/r1$/.test(u)) return json({ ok: true, run });
  if (/\/v1\/teams\/runs\?/.test(u)) return json({ ok: true, runs: [{ ...run, tasks: run.tasks.map((t) => ({ ...t, text: undefined })), waiting: 0, findings: 0 }] });
  if (/\/v1\/engines$/.test(u)) return json({ ok: true, engines: [{ key: 'harness:claude', engine: { kind: 'harness', id: 'claude' }, calls: 3, availability: { rate: 1, byHour: Array.from({ length: 24 }, () => ({ calls: 1, declines: 0 })), decliningNow: false }, latency: { total: { p50: 5000 } } }] });
  if (/\/v1\/projects\/orcl$/.test(u)) return json({ ok: true, project });
  if (/\/v1\/projects\?/.test(u)) return json({ ok: true, projects: [{ id: 'orcl', status: 'active', page: project.page, jobCount: 2, runCount: 0, lastEventAt: now }] });
  if (/\/v1\/agents\//.test(u)) return json({ ok: true, summary: null });
  return json({ ok: true, token: 'x' });
};

const settings = { agentPool: [{ id: 'research-researcher', name: 'Researcher', prompt: 'x', createdBy: 'team:research' }], gatewayUrl: 'http://127.0.0.1:1', gatewayToken: 'tok' };
const observe = await import('../extension/js/settings-observe.js');
const root = new El('div');
let opened = 0;
const dispose = observe.renderObserve(root, { settings, openBoard: () => { opened += 1; } });
await new Promise((r) => setTimeout(r, 60));
const stats = root.all((n) => n.className === 'org-stat');
assert.equal(stats.length, 5, 'the strip has five numbers');
assert.equal(stats[0].find((n) => n.tagName === 'B').textContent, '1', 'one live run');
assert.equal(root.all((n) => n.className === 'org-panel').length, 4, 'inbox · engines · timeline · spend');
assert.ok(root.find((n) => /Run timeline · \/research/.test(n.textContent)), 'the timeline names the live run');
const lanes = root.all((n) => n.className === 'org-lane');
assert.ok(lanes.some((l) => l.find((n) => n.className === 'tl' && n.children.length === 1)), 'the running task has one working segment');
assert.ok(lanes.some((l) => l.find((n) => n.className === 'org-avail')), 'the engine strip is drawn');
assert.ok(root.find((n) => n.className === 'org-spend'), 'spend rows by agent');
assert.ok(root.find((n) => n.className === 'org-spend')?.find((n) => /\$0\.40/.test(n.textContent)), 'the priced run shows its dollars');
dispose();

const projects = await import('../extension/js/settings-projects.js');
const root2 = new El('div');
const dispose2 = projects.renderProjects(root2, { settings });
await new Promise((r) => setTimeout(r, 60));
assert.ok(root2.find((n) => n.attrs['data-project'] === 'orcl'), 'the project is listed');
assert.ok(root2.find((n) => /Round 1/.test(n.textContent)) && root2.find((n) => /Round 2/.test(n.textContent)), 'jobs are grouped into rounds by dependency');
const job = root2.find((n) => n.attrs['data-job'] === 'gather');
assert.ok(job && job.find((n) => n.textContent === 'Researcher'), 'a recruited job names its agent from the roster');
assert.ok(job.find((n) => /fit 82%/.test(n.textContent)), 'and the fit');
assert.ok(root2.find((n) => /newAgent: ask/.test(n.textContent)), 'the gate is drawn as chips');
dispose2();
console.log('settings-observe: ok');
