// Settings → Skills → Teams: a person can MAKE a team here, not only approve one a model
// proposed. The card offers the starters, opens the form on "+ New team", and saves through
// the shared `teamFromForm` — so a team made on this page is exactly a team made in the
// desktop or on the chat card. Rendered against a small DOM shim: enough for the calls
// the module makes (createElement / append / addEventListener / querySelector).
import assert from 'node:assert/strict';

// A DOM small enough to read: elements with children, attributes, classes and listeners.
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.style = ''; this.disabled = false; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(typeof k === 'string' ? { text: k } : k); }
  appendChild(k) { this.append(k); return k; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  input(v) { this.value = v; for (const fn of this.listeners.input || []) fn({}); }
  change(v) { this.value = v; for (const fn of this.listeners.change || []) fn({}); }
  check(on) { this.checked = on; for (const fn of this.listeners.change || []) fn({}); }
  *walk() { yield this; for (const c of this.children) if (c instanceof El) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  all(pred) { return [...this.walk()].filter(pred); }
  querySelector(sel) { return this.find((n) => sel.startsWith('.') && n.className.split(/\s+/).includes(sel.slice(1))); }
}
globalThis.document = { createElement: (t) => new El(t) };
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {} } } };

// The module persists through store.saveSettings, which writes to chrome.storage.local —
// the stub above swallows it; what matters here is what reaches onChange.
const mod = await import('../extension/js/settings-teams.js');

const settings = { teams: [], mcpServers: [{ id: 'srv-a' }], gatewayUrl: 'http://127.0.0.1:1' };
let changed = null;
const root = new El('div');
const button = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.textContent));

let pool = null;
const dispose = mod.renderTeams(root, { settings, onChange: (t, p) => { changed = t; pool = p; } });
// The built-in org ships with the product: every starter is a team here, with nothing saved.
assert.ok(!button(root, /starter/), 'no starter to add — they are all present');
for (const n of ['research', 'review', 'feature', 'fix', 'docs', 'release']) assert.ok(root.find((x) => x.attrs['data-team'] === n && x.attrs['data-builtin'] !== undefined), `/${n} is built in`);
assert.ok(root.find((x) => x.attrs['data-team'] === 'feature' && x.attrs['data-builtin'] !== undefined).find((n) => n.attrs['data-health'] === 'ready'), 'a built-in team is ready as shipped — its agents are built in too');
assert.ok(button(root, /New team/), 'the form can be opened');
button(root, /New team/).click();
assert.ok(button(root, /Save team/), 'the form is on the page');
assert.equal(button(root, /New team/).disabled, true, 'one form at a time');

// Fill it: name, one role with grants as text, a budget.
root.find((n) => n.attrs.placeholder?.startsWith('name')).input('Mine');
root.find((n) => n.attrs.placeholder === 'role id').input('worker');
// Grants are choices, not a free field: check two boxes.
const boxes = root.all((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox' && n.attrs.value);
assert.ok(boxes.some((b) => b.attrs.value === 'mcp:srv-a'), 'the connected server is a choice by name');
assert.ok(!root.find((n) => n.attrs.placeholder?.startsWith('none')), 'no free-text grants field');
boxes.find((b) => b.attrs.value === 'web').check(true);
boxes.find((b) => b.attrs.value === 'mcp:srv-a').check(true);
root.find((n) => n.tagName === 'TEXTAREA').input('Do the thing.');
button(root, /Save team/).click();
await new Promise((r) => setTimeout(r, 10));
assert.ok(changed, 'saving reaches onChange');
assert.equal(changed[0].name, 'mine', 'the name is lowercased to an identifier');
// F8 §17.1: the inline role became a pool card, and the team points at it — nothing that
// runs is invisible on the Agents tab.
assert.equal(changed[0].roles[0].agent, 'mine-worker', 'the role stands for its card');
assert.equal(changed[0].roles[0].grants, undefined, 'grants live on the card');
assert.ok(Array.isArray(pool) && pool.length === 1, 'the pool was written in the same save');
assert.equal(pool[0].id, 'mine-worker');
assert.deepEqual(pool[0].grants, ['web', 'mcp:srv-a']);
assert.equal(pool[0].prompt, 'Do the thing.');
assert.equal(pool[0].createdBy, 'team:mine');
assert.equal(changed[0].budget.tokens, 20000, 'the blank team\'s budget stands');
assert.ok(changed[0].createdAt);

// A team that cannot be saved says why, and saves nothing.
changed = null;
const root2 = new El('div');
const dispose2 = mod.renderTeams(root2, { settings: { ...settings, teams: [{ name: 'mine', roles: [{ id: 'a', prompt: 'p', grants: ['none'] }], budget: { tokens: 1 } }] }, onChange: (t) => { changed = t; } });
button(root2, /New team/).click();
root2.find((n) => n.attrs.placeholder?.startsWith('name')).input('mine');
button(root2, /Save team/).click();
await new Promise((r) => setTimeout(r, 10));
assert.equal(changed, null, 'a duplicate name or an empty prompt does not save');
const errs = root2.all((n) => n.tagName === 'LI').map((n) => n.textContent);
assert.ok(errs.some((e) => /prompt/.test(e)), `errors name the field: ${errs.join(' | ')}`);
assert.ok(button(root2, /Edit/), 'a saved team can be edited');
// A built-in switched off is saved as a copy of ours — the section stays small; it can be reset.
changed = null;
const feat = root2.find((x) => x.attrs['data-team'] === 'feature');
feat.find((n) => n.tagName === 'INPUT' && n.attrs.title === 'Enabled').check(false);
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(changed.map((t) => t.name), ['mine', 'feature'], 'the switched-off built-in joined the saved section');
assert.equal(changed.find((t) => t.name === 'feature').enabled, false);
const root2b = new El('div');
const dispose2b = mod.renderTeams(root2b, { settings: { ...settings, teams: changed }, onChange: (t) => { changed = t; } });
const feat2 = root2b.find((x) => x.attrs['data-team'] === 'feature');
assert.ok(feat2 && feat2.attrs['data-builtin'] === undefined, 'a saved copy is the person\'s now');
assert.ok(button(feat2, /Reset to built-in/), 'and can go back to what shipped');
assert.ok(!button(feat2, /Delete/), 'a built-in is never deleted');
button(feat2, /Reset to built-in/).click();
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(changed.map((t) => t.name), ['mine']);

// A starter brings its agents; a team whose role names an agent not in the pool is a HOLE,
// drawn on the card with the fix, and the shape is drawn from the roles.
// A hole is still a state: a saved team naming an agent nobody has.
changed = null; pool = null;
const root4 = new El('div');
const dispose4 = mod.renderTeams(root4, { settings: { ...settings, teams: [{ name: 'custom', roles: [{ id: 'x', agent: 'someone-gone' }], budget: { ms: 1000 } }] }, onChange: () => {} });
const holeNode = root4.find((n) => n.attrs['data-role'] === 'x');
assert.ok(holeNode && /hole/.test(holeNode.className), 'the missing agent is drawn as a hole in the shape');
assert.ok(root4.find((n) => n.attrs['data-health'] === 'hole'), 'the card says the team is not ready');
const cols = root.all((n) => n.className === 'org-col');
assert.ok(cols.length >= 4, `columns by dependency, the judge, and you: ${cols.length}`);
const dispose3 = () => {}; const dispose5 = () => {};

// A team saved before roles were cards offers to promote them, and the promotion writes both sections.
changed = null; pool = null;
const root6 = new El('div');
const dispose6 = mod.renderTeams(root6, { settings: { ...settings, teams: [{ name: 'old', roles: [{ id: 'a', prompt: 'Do a.', grants: ['web'] }], budget: { tokens: 5 } }] }, onChange: (t, p) => { changed = t; pool = p; } });
assert.ok(root6.find((n) => n.attrs['data-health'] === 'inline'), 'an inline role is named');
button(root6, /Make it cards/).click();
await new Promise((r) => setTimeout(r, 10));
assert.equal(changed[0].roles[0].agent, 'old-a');
assert.equal(pool[0].id, 'old-a');

dispose(); dispose2(); dispose2b(); dispose3(); dispose4(); dispose5(); dispose6(); // each card polls the gateway until disposed
console.log('settings-teams: ok');
