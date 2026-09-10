// A BACKUP HAS TO CARRY THE KNOWLEDGE LAYER, or the knowledge layer has no backup.
//
// It never did. Through v8 the payload had no `briefs` key at all, so a restore could not
// return a brief — and on the desktop, which READS this layer without deriving it, every
// brief stayed the gateway's flattened index copy however many times the user restored,
// under a banner telling them to restore.
//
// The briefs themselves are derivable, so on their own they would not earn the bytes. What
// travels with them cannot be derived: the PROPOSALS the user accepted and the SUBJECT
// MERGES they made are judgements about the corpus, and writeBriefs re-applies them on every
// rebuild. Losing those means reviewing everything again.
import assert from 'node:assert/strict';

const local = new Map();
const sessionStore = new Map();
const area = (map) => ({
  async get(key) {
    if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
    if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => map.has(k)).map((k) => [k, map.get(k)]));
    return Object.fromEntries(map);
  },
  async set(values) { Object.entries(values).forEach(([k, v]) => map.set(k, v)); },
  async remove(key) { (Array.isArray(key) ? key : [key]).forEach((k) => map.delete(k)); },
});
globalThis.chrome = {
  storage: { local: area(local), session: area(sessionStore), onChanged: { addListener() {} } },
  runtime: { id: 'test', getURL: (p) => p, sendMessage: async () => {} },
};

const briefs = await import('../extension/js/store-briefs.js');
const backup = await import('../extension/js/store-briefs-backup.js');

const brief = (id, name) => ({
  id,
  key: `person:${name.toLowerCase().replace(/\s+/g, '-')}`,
  kind: 'person',
  subject: { name, aliases: [] },
  state: 'active',
  cls: 'R',
  claims: [{ id: `${id}-c1`, text: `${name} leads the platform team.`, refs: [{ kind: 'meeting', id: 'm1' }], state: 'derived' }],
  records: [{ type: 'meeting', title: 'Platform sync' }],
  stats: { records: 1 },
  updatedAt: 1_700_000_000_000,
});

await briefs.writeBriefs([brief('b1', 'Alex Rivera'), brief('b2', 'Jordan Blake')]);
await briefs.putProposal({
  id: 'p1', briefId: 'b1', state: 'accepted', settledAt: 2,
  claims: [{ id: 'p1-c1', text: 'Owns the rollout runbook.', refs: [] }],
});
await briefs.mergeSubjects('A. Rivera', 'Alex Rivera');

// ── the payload carries all of it ───────────────────────────────────────────
const payload = await backup.exportBriefs();
assert.equal(payload.briefs.length, 2, 'both briefs are in the backup');
assert.ok(payload.proposals.p1, 'and the proposal the user accepted');
// Merges are a map of `from → into`, kept one hop deep on purpose.
assert.equal(payload.merges['A. Rivera'], 'Alex Rivera', 'and the subjects they merged');

// ── a restore into an empty profile returns them ────────────────────────────
local.clear();
const restored = await backup.importBriefs(payload, { mode: 'replace' });
assert.equal(restored, 2, 'both briefs came back');
const index = await briefs.getBriefIndex();
assert.equal(index.length, 2);
assert.ok(index.some((e) => e.name === 'Alex Rivera'));
const back = await briefs.getBrief('b1');
assert.equal(back.claims[0].text, 'Alex Rivera leads the platform team.');

// The judgements came back too — this is the half a rebuild cannot invent.
assert.ok((await briefs.getProposals()).p1, 'the accepted proposal survived');
assert.equal((await briefs.getBriefMerges())['A. Rivera'], 'Alex Rivera', 'the merge survived');

// ── merge mode adds without dropping what is already here ───────────────────
await backup.importBriefs({ briefs: [brief('b3', 'Sam Okafor')] }, { mode: 'merge' });
assert.equal((await briefs.getBriefIndex()).length, 3, 'a merge restore keeps the existing two');

// ── an older backup, and a malformed one, are not errors ────────────────────
assert.equal(await backup.importBriefs(null), 0, 'a pre-v9 backup simply has nothing here');
assert.equal(await backup.importBriefs({}), 0);
assert.equal(await backup.importBriefs({ briefs: [{ id: 'nope' }] }), 0, 'a brief with no subject is skipped, not written');
assert.equal((await briefs.getBriefIndex()).length, 3, 'and skipping it changed nothing');

console.log('ok — briefs, accepted proposals and subject merges survive a backup and a restore');
