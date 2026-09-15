// Settings → Agents is the ROSTER (F8 §17): every pool card with its kind, colour, where it
// works and the four numbers of its record; a MISSING agent a team names is a row with the
// fix; the filter bar counts them. Rendered against the same DOM shim as the Teams test.
import assert from 'node:assert/strict';

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.style = ''; this.disabled = false; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
  append(...kids) { for (const k of kids) if (k != null) this.children.push(typeof k === 'string' ? { text: k } : k); }
  appendChild(k) { this.append(k); return k; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  check(on) { this.checked = on; for (const fn of this.listeners.change || []) fn({}); }
  *walk() { yield this; for (const c of this.children) if (c instanceof El) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  all(pred) { return [...this.walk()].filter(pred); }
  querySelector(sel) { return this.find((n) => sel.startsWith('.') && n.className.split(/\s+/).includes(sel.slice(1))); }
}
globalThis.document = { createElement: (t) => new El(t) };
globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}), set: async () => {} } } };
globalThis.fetch = async () => { throw new Error('no gateway in this test'); };

const mod = await import('../extension/js/settings-agents.js');
const { starterAgents } = await import('../extension/js/events/agent.js');
const { starterTeams } = await import('../extension/js/events/team.js');
const button = (r, re) => r.find((n) => n.tagName === 'BUTTON' && re.test(n.textContent));

// The built-in org ships with the product: with NOTHING saved the roster holds every starter
// (and the roles of the built-in teams), each ready; a team a person saved naming an agent
// nobody has is the one MISSING row.
const settings = { agentPool: [{ id: 'my-analyst', name: 'Analyst', prompt: 'x', createdBy: 'person' }], teams: [{ name: 'custom', roles: [{ id: 'x', agent: 'someone-gone' }], budget: { ms: 1000 } }], skills: [{ command: 'summarize', name: 'Summarize' }], mcpServers: [{ id: 'jira', name: 'Jira' }], gatewayUrl: 'http://127.0.0.1:1' };
let changed = null;
const root = new El('div');
mod.renderAgents(root, { settings, onChange: (p) => { changed = p; } });

const cards = root.all((n) => n.attrs['data-agent']);
assert.ok(cards.length >= starterAgents().length + 4 + 2, `every built-in, the team roles, the assistant, mine and the hole: ${cards.length}`);
for (const id of ['architect', 'tester', 'research-researcher', 'review-checker']) assert.equal(root.find((n) => n.attrs['data-agent'] === id)?.attrs['data-kind'], 'builtin', `${id} is built in`);
assert.ok(!button(root, /engineering org|starter/), 'nothing to add — the org is here');
const hole = root.find((n) => n.attrs['data-kind'] === 'missing');
assert.equal(hole?.attrs['data-agent'], 'someone-gone', 'the agent the saved team names is the MISSING row');
assert.ok(hole.find((n) => /named by \/custom/.test(n.textContent)), 'and who names it');
const filters = root.all((n) => n.attrs['data-filter']).map((n) => n.textContent);
assert.ok(filters.some((f) => /^Missing 1$/.test(f)), `the filter bar counts the hole: ${filters.join(' | ')}`);
assert.ok(filters.some((f) => /^Yours 1$/.test(f)), `and yours: ${filters.join(' | ')}`);
// Where it works: the architect is on the built-in /feature and /docs.
const arch = root.find((n) => n.attrs['data-agent'] === 'architect');
assert.ok(arch.find((n) => n.tagName === 'A' && n.textContent === '/feature'), 'a card says which teams name it');
// The four numbers are drawn before the gateway answers — as "—", never as zeros.
const nums = arch.find((n) => n.className === 'org-nums');
assert.deepEqual(nums.all((n) => n.tagName === 'B').map((n) => n.textContent), ['—', '—', '—', '—']);
// One colour per agent: the avatar carries it inline, the same function the Teams tab uses.
assert.match(arch.find((n) => /org-av/.test(n.className)).attrs.style, /hsl\(212 /);
// A built-in is switched off as a saved copy, never deleted; the copy can be reset.
assert.ok(!button(arch, /Delete/), 'no Delete on a built-in');
arch.find((n) => n.tagName === 'INPUT' && n.attrs.title === 'Enabled').check(false);
await new Promise((r) => setTimeout(r, 10));
assert.ok(changed.some((a) => a.id === 'architect' && a.enabled === false && !a.builtin), 'the switched-off built-in is a saved copy of ours');
const root1 = new El('div');
mod.renderAgents(root1, { settings: { ...settings, agentPool: changed }, onChange: (p) => { changed = p; } });
const arch1 = root1.find((n) => n.attrs['data-agent'] === 'architect');
assert.ok(button(arch1, /Reset to built-in/), 'an edited built-in can go back to what shipped');
// Editing: grants and skills are choices from what exists.
button(arch1, /Edit/).click();
const grantBoxes = root1.all((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox' && n.attrs.value);
assert.ok(grantBoxes.some((b) => b.attrs.value === 'mcp:jira'), 'the connected server is a grant choice');
assert.ok(grantBoxes.some((b) => b.attrs.value === 'summarize'), 'a skill you have is a skill choice');
assert.ok(grantBoxes.find((b) => b.attrs.value === 'data').checked && grantBoxes.find((b) => b.attrs.value === 'history').checked, 'the card\'s grants are checked');
assert.ok(!root1.find((n) => /^grants:|^skills:/.test(n.attrs.placeholder || '')), 'no free-text grants or skills field');

// Filtering shows only the kind asked for.
const root2 = new El('div');
mod.renderAgents(root2, { settings, onChange: () => {}, filter: 'mine' });
assert.deepEqual(root2.all((n) => n.attrs['data-agent']).map((n) => n.attrs['data-agent']), ['my-analyst']);
console.log('settings-agents: ok');

// Every card says how to invoke it — as its own /command (team-org.js soloTeam), which the
// side panel's slash menu and the team tool both offer.
const root3 = new El('div');
mod.renderAgents(root3, { settings, onChange: () => {} });
const inv = root3.find((n) => n.attrs['data-invoke'] === 'architect');
assert.ok(inv && inv.find((n) => n.textContent === '/architect <request>'), 'the card names its command');
const { teamsWithSolos } = await import('../extension/js/events/team-org.js');
assert.ok(teamsWithSolos(settings.teams, settings.agentPool).some((t) => t.name === 'architect' && t.origin?.agent === 'architect'), 'and the chat can run it');
console.log('settings-agents: invoke ok');
