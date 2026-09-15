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

const org = starterAgents().filter((a) => a.id !== 'tester');
const feature = starterTeams().find((t) => t.name === 'feature');
const settings = { agentPool: [...org, { id: 'my-analyst', name: 'Analyst', prompt: 'x', createdBy: 'person' }], teams: [feature], gatewayUrl: 'http://127.0.0.1:1' };
let changed = null;
const root = new El('div');
mod.renderAgents(root, { settings, onChange: (p) => { changed = p; } });

const cards = root.all((n) => n.attrs['data-agent']);
assert.ok(cards.length >= org.length + 2, `every card, the assistant and the hole: ${cards.length}`);
const hole = root.find((n) => n.attrs['data-kind'] === 'missing');
assert.equal(hole?.attrs['data-agent'], 'tester', 'the tester feature names is a MISSING row');
assert.ok(button(hole, /Add the built-in Tester/), 'with the fix on it');
assert.ok(hole.find((n) => /named by \/feature/.test(n.textContent)), 'and who names it');
const filters = root.all((n) => n.attrs['data-filter']).map((n) => n.textContent);
assert.ok(filters.some((f) => /^Missing 1$/.test(f)), `the filter bar counts the hole: ${filters.join(' | ')}`);
assert.ok(filters.some((f) => /^Built-in 7$/.test(f)), `and the org: ${filters.join(' | ')}`);
assert.ok(filters.some((f) => /^Yours 1$/.test(f)), `and yours: ${filters.join(' | ')}`);
// Where it works: the architect is on /feature.
const arch = root.find((n) => n.attrs['data-agent'] === 'architect');
assert.ok(arch.find((n) => n.tagName === 'A' && n.textContent === '/feature'), 'a card says which teams name it');
// The four numbers are drawn before the gateway answers — as "—", never as zeros.
const nums = arch.find((n) => n.className === 'org-nums');
assert.deepEqual(nums.all((n) => n.tagName === 'B').map((n) => n.textContent), ['—', '—', '—', '—']);
// One colour per agent: the avatar carries it inline, the same function the Teams tab uses.
assert.match(arch.find((n) => /org-av/.test(n.className)).attrs.style, /hsl\(212 /);

// The fix adds exactly the built-in named, stamped.
button(hole, /Add the built-in Tester/).click();
await new Promise((r) => setTimeout(r, 10));
assert.ok(changed && changed.some((a) => a.id === 'tester'), 'the tester joined the pool');
assert.equal(changed.length, settings.agentPool.length + 1);

// Filtering shows only the kind asked for.
const root2 = new El('div');
mod.renderAgents(root2, { settings, onChange: () => {}, filter: 'mine' });
assert.deepEqual(root2.all((n) => n.attrs['data-agent']).map((n) => n.attrs['data-agent']), ['my-analyst']);
console.log('settings-agents: ok');
