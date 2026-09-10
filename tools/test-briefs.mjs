// The derived layer, as the extension actually wires it: storage, the build pass, the
// source registration, and the two rules that keep it cheap.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

// ── an in-memory chrome.storage, and no encryption key so records round-trip plainly ──
const mem = new Map();
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://briefs/${p}`, id: 'briefs-test' },
  storage: {
    onChanged: { addListener() {} },
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries(mem);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (mem.has(k)) out[k] = mem.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) mem.set(k, v); },
      async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) mem.delete(k); },
    },
    session: { async get() { return {}; }, async set() {}, async remove() {} },
  },
};

const store = await import('../extension/js/store-briefs.js');
const build = await import('../extension/js/briefs-build.js');
const { briefSource } = await import('../extension/js/brief-source.js');

const NOW = Date.UTC(2026, 8, 9);
const day = 86_400_000;

const records = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `meeting:m${i}`, type: 'meeting', title: `Atlas review ${i}`, date: NOW - (10 - i) * day,
    text: 'we need [[Atlas Charter]] before the migration',
    meta: { people: i % 2 ? ['Alex Rivera'] : ['Alex'], tags: ['atlas'], terms: ['migration'] },
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `chat:c${i}`, type: 'chat', title: `Chat ${i}`, date: NOW - i * 3600_000,
    text: 'atlas migration questions', meta: { tags: ['atlas'], terms: ['migration'] },
  })),
];
const memories = [
  { id: 'mem1', kind: 'fact', text: 'Alex Rivera owns the Atlas rollback plan.', updatedAt: NOW },
  { id: 'mem2', kind: 'identity', text: 'Alex Rivera is left-handed.', updatedAt: NOW },
];

// ── build ────────────────────────────────────────────────────────────────────
const report = await build.rebuildBriefs(records, { memories, now: NOW });
assert.ok(report.ok, 'the first build should succeed');
assert.ok(report.briefs >= 3, `expected several briefs, got ${report.briefs}`);

const index = await store.getBriefIndex();
assert.equal(index.length, report.briefs);
// The index carries everything a list, ⌘K and the graph need — no body decrypt.
for (const e of index) {
  assert.ok(e.name && e.kind && e.id, 'index rows must be renderable on their own');
  assert.equal(typeof e.claims, 'number');
  assert.ok(Array.isArray(e.terms));
}
// Sorted by evidence, so the list opens on what is best known.
assert.deepEqual([...index].map((e) => e.stats.records), [...index].map((e) => e.stats.records).sort((a, b) => b - a));

const person = index.find((e) => e.kind === 'person');
assert.equal(person.name, 'Alex Rivera');
assert.ok(person.aliases.includes('alex'), 'the bare speaker label should have folded in');

const brief = await store.getBrief(person.id);
assert.ok(brief, 'a body should be stored for every index row');
const stated = brief.claims.filter((c) => c.kind === 'stated');
assert.equal(stated.length, 1, 'the non-ambient memory should be a claim; the identity one should not');
assert.equal(stated[0].refs[0].kind, 'memory');

// ── I-K2: rebuilding is a cache clear, and a shrinking corpus leaves nothing behind ──
const before = await store.getBriefIndex();
// Only the chats: no speakers and no [[links]], so the person and wanted-page subjects
// stop being earned and their bodies must go with them.
const smaller = records.filter((r) => r.type === 'chat');
const second = await build.rebuildBriefs(smaller, { memories, now: NOW + 1000 });
assert.ok(second.removed > 0, 'briefs the smaller corpus no longer earns should be dropped');
const after = await store.getBriefIndex();
assert.ok(after.length < before.length);
for (const gone of before.filter((e) => !after.some((a) => a.id === e.id))) {
  assert.equal(await store.getBrief(gone.id), null, `${gone.id} body was orphaned rather than removed`);
}

// Rebuilding from the FULL corpus restores exactly what was there — that is the invariant.
const third = await build.rebuildBriefs(records, { memories, now: NOW });
assert.equal(third.briefs, report.briefs);
assert.deepEqual((await store.getBriefIndex()).map((e) => e.id).sort(), before.map((e) => e.id).sort());

// ── drift ────────────────────────────────────────────────────────────────────
assert.deepEqual(await build.briefDrift(records), [], 'a fresh build should cite nothing stale');
const edited = records.map((r) => (r.id === 'meeting:m5' ? { ...r, text: 'rewritten entirely' } : r));
const drift = await build.briefDrift(edited);
assert.ok(drift.length, 'an edited record should surface as drift, not be silently re-read');

// ── the source contract ──────────────────────────────────────────────────────
const src = briefSource(person, brief);
assert.equal(src.type, 'brief');
assert.equal(src.id, person.id, 'a brief is addressable by the id agents already get from search');
assert.equal(src.title, 'Alex Rivera', 'the subject IS the title — the graph and ⌘K show titles');
assert.match(src.text, /^BRIEF: Alex Rivera/);
assert.match(src.url, /briefs\.html#/);
assert.ok(src.meta.terms.length, 'terms are what make a brief a hub in the graph rather than a leaf');
assert.equal(briefSource(null, null), null);

// ── staleness ────────────────────────────────────────────────────────────────
await chrome.storage.local.set({ [store.STALE_KEY]: true });
assert.equal(await store.briefsAreStale(), true);
await build.rebuildBriefs(records, { memories, now: NOW });
assert.equal(await store.briefsAreStale(), false, 'a rebuild clears the stale flag');

// ── switched off means nothing is derived ────────────────────────────────────
await store.saveBriefSettings({ enabled: false });
const off = await build.rebuildBriefs(records, { memories, now: NOW });
assert.equal(off.ok, false);
assert.equal(off.reason, 'disabled');
await store.saveBriefSettings({ enabled: true });

// ── the two structural rules, asserted on the source rather than remembered ──
const storeSrc = read('extension/js/store-briefs.js');
// Match an IMPORT of it, not the comment that explains why there isn't one.
assert.ok(!/^\s*import[^\n]*knowledge-derive\.js/m.test(storeSrc),
  'store-briefs.js is on the service worker graph; derivation must stay in briefs-build.js');
const ragSrc = read('extension/js/history-rag.js');
// Line-anchored, so the prose explaining the ordering is not mistaken for the calls.
const callAt = (re) => ragSrc.search(re);
assert.ok(callAt(/^registerBriefSource\(\);/m) > 0, 'history-rag must register the brief source');
assert.ok(callAt(/^registerBriefSource\(\);/m) < callAt(/^declarePlugins\(/m),
  'briefs must register before the plugin manifest is declared, or the user cannot switch them off');

// Warm sync must ask before forwarding briefs to local agents.
const warmSrc = read('extension/js/warm-sync.js');
assert.match(warmSrc, /includeBriefs/);
assert.match(warmSrc, /shareWithAgents/);

// The brief loader must never read briefs — last run's synthesis becoming this run's
// evidence would make the citations lead nowhere real.
const pageSrc = read('extension/briefs.js');
assert.match(pageSrc, /includeBriefs:\s*false/);

console.log('briefs tests passed');

// ── identity: one person, however the corpus spelled them ────────────────────
// Fictional placeholders only — never a real person's name, in code or in a fixture.
{
  const NOW2 = Date.UTC(2026, 8, 10);
  const varied = Array.from({ length: 6 }, (_, i) => ({
    id: `meeting:v${i}`,
    type: 'meeting',
    title: `Sync ${i}`,
    date: NOW2 - i * day,
    text: 'atlas migration status',
    meta: {
      // The same human, as four different clients wrote them, plus the platform's label
      // for whoever is holding the microphone.
      people: [['Jordan Blake', 'Jordan Blake (ACME)', 'Jordan Blake - Host', 'You', 'Jordan', 'J. Blake'][i]],
      terms: ['migration'],
    },
  }));

  await store.saveBriefSettings({ selfName: 'Jordan Blake' });
  await build.rebuildBriefs(varied, { now: NOW2 });
  const people = (await store.getBriefIndex()).filter((e) => e.kind === 'person');
  assert.equal(people.length, 1, `six spellings of one person should be one subject, got ${JSON.stringify(people.map((p) => p.name))}`);
  assert.equal(people[0].name, 'Jordan Blake');
  assert.equal(people[0].stats.records, 5, 'the qualifiers, the bare first name and "You" all fold in');

  // "J. Blake" is the one the alias rule refuses to decide, so it is PROPOSED.
  const suggested = await build.suggestBriefMerges(varied);
  const pair = suggested.find((m) => m.dropName === 'J. Blake');
  assert.ok(pair, `expected an initials suggestion, got ${JSON.stringify(suggested)}`);
  assert.equal(pair.keepName, 'Jordan Blake');

  // Answering it is stored, and applied by the NEXT rebuild rather than edited into the last.
  await store.mergeSubjects(pair.dropName, pair.keepName);
  assert.deepEqual(await store.getBriefMerges(), { 'J. Blake': 'Jordan Blake' });
  await build.rebuildBriefs(varied, { now: NOW2 });
  const after = (await store.getBriefIndex()).filter((e) => e.kind === 'person');
  assert.equal(after.length, 1);
  assert.equal(after[0].stats.records, 6, 'the merged spelling now counts toward the subject');

  // A confirmed pair stops being asked about.
  assert.ok(!(await build.suggestBriefMerges(varied)).some((m) => m.dropName === 'J. Blake'));

  // And it is as easy to take back as it was to make.
  await store.unmergeSubject('J. Blake');
  assert.deepEqual(await store.getBriefMerges(), {});

  // With no self name, "You" is a pronoun and stays out — every meeting has one.
  await store.saveBriefSettings({ selfName: '' });
  await build.rebuildBriefs(varied, { now: NOW2 });
  assert.ok(!(await store.getBriefIndex()).some((e) => /^you$/i.test(e.name)), '"You" must never be a subject');

  // …unless the user told ChatPanel their name, which is already a reviewed, durable fact.
  assert.equal(build.selfNameFrom([{ kind: 'identity', text: 'Call me Jordan Blake.' }]), 'Jordan Blake');
  assert.equal(build.selfNameFrom([{ kind: 'fact', text: 'Call me Jordan Blake.' }]), '', 'only an identity memory names the user');
  assert.equal(build.selfNameFrom([]), '');
}

// ── redaction placeholders never become subjects or links ────────────────────
{
  const redacted = Array.from({ length: 5 }, (_, i) => ({
    id: `chat:r${i}`, type: 'chat', title: `Chat ${i}`, date: Date.UTC(2026, 8, 10),
    text: '[[PERSON_1]] asked [[PERSON_2]] about [[LOCATION_1]] and [[Q3_2026]]',
    meta: { terms: ['migration'] },
  }));
  await build.rebuildBriefs(redacted, { now: Date.UTC(2026, 8, 10) });
  const idx = await store.getBriefIndex();
  assert.ok(!idx.some((e) => /^(PERSON|LOCATION|ORG|EMAIL|PHONE)_\d+$/.test(e.name)),
    `a placeholder became a subject: ${JSON.stringify(idx.map((e) => e.name))}`);
  // A real link that merely looks token-shaped is still a wanted page.
  assert.ok(idx.some((e) => e.name === 'Q3_2026'), 'matching by TYPE keeps [[Q3_2026]] a real link');
}

console.log('briefs identity tests passed');

// ── the two views that froze the page ────────────────────────────────────────
// A dashboard that hangs the tab is worse than one that shows less, so both of these are
// structural assertions: the graph must cap before drawing, and the maintenance report must
// yield between passes rather than computing the whole thing in one synchronous stretch.
{
  const page = read('extension/briefs.js');

  const graph = page.slice(page.indexOf('async function renderGraph()'), page.indexOf('async function renderMaint()'));
  assert.match(graph, /GRAPH_NODE_CAP/, 'the subject graph must cap its nodes');
  assert.ok(graph.indexOf('slice(0, GRAPH_NODE_CAP)') < graph.indexOf('drawGraph('),
    'the cap has to be applied BEFORE drawing — a force sim over a few hundred clustered nodes hangs the tab');
  assert.match(graph, /GRAPH_LINKS_PER_NODE/, 'and cap edges per node; a dense mesh is both slow and unreadable');
  assert.match(graph, /more are in the list on the left/, 'and say what it is not showing');

  const maint = page.slice(page.indexOf('async function renderMaint('), page.indexOf('function wireMaintActions('));
  assert.match(maint, /await YIELD\(\)/, 'the maintenance passes must yield to the event loop');
  assert.match(maint, /_maintSeq/, 'and stop when the user switches away, rather than racing');
  assert.ok((maint.match(/await add\(group\(/g) || []).length >= 6,
    'each pass should paint its own section, so the first answer arrives before the last is computed');
}

// The shared renderer must defend itself: a caller that forgets to cap should get a
// truncated picture, never a hung tab. The Briefs graph shipped without a cap and froze.
{
  const gv = read('extension/js/graph-view.js');
  assert.match(gv, /export const MAX_GRAPH_NODES/, 'drawGraph needs its own ceiling');
  const draw = gv.slice(gv.indexOf('export function drawGraph('), gv.indexOf('export function drawGraph(') + 2500);
  assert.match(draw, /nodes\.length > MAX_GRAPH_NODES/, 'and must apply it at the top of drawGraph');
}

// Recomputing the whole report every time the tab is re-entered made it feel broken: you
// left, came back, and waited again for an answer that had not changed.
{
  const page = read('extension/briefs.js');
  const maint = page.slice(page.indexOf('async function renderMaint('), page.indexOf('async function corpusVersion('));
  assert.match(maint, /_maintCache/, 'the maintenance report must be cached');
  assert.match(maint, /MAINT_TTL_MS/, 'with a TTL, so a corpus that changed underneath is not served forever');
  assert.match(maint, /_maintCache\.version === version/, 'and keyed on a corpus version, so a rebuild invalidates it honestly');
  assert.ok(maint.indexOf('_maintCache && _maintCache.version') < maint.indexOf('loadCorpus()'),
    'the cache has to be checked BEFORE the corpus is read, or it saves nothing');

  assert.match(page, /MERGE_PAGE/, 'suggestions must paginate — nobody answers forty merge questions in a row');
  assert.match(page, /b-more-merges/, 'and there must be a way to see the rest');
  const wire = page.slice(page.indexOf('function wireMaintActions('));
  assert.match(wire, /renderMaint\(\{ force: true \}\)/,
    'answering a suggestion changes the input, so THAT must recompute rather than serve the cache');

  // Paging is a view change. The first version said so in a comment and then nulled the cache
  // and forced a recompute on the next line — every "show more" re-decrypted the corpus.
  const pager = wire.slice(wire.indexOf("querySelector('#b-more-merges')"), wire.indexOf('[data-yes]'));
  assert.ok(!/_maintCache = null/.test(pager), '"show more" must not drop the cache');
  assert.match(pager, /_maintCache\.sections\[0\] = mergeSectionHtml\(_maintCache\.suggestions\)/,
    '"show more" must redraw the merge section from cached suggestions');

  // …and the label must carry progress. "Show 8 more of 40" read the same on every click.
  const section = page.slice(page.indexOf('function mergeSectionHtml('), page.indexOf('function mergedNamesHtml('));
  assert.match(section, /Showing \$\{shown\.length\} of \$\{suggestions\.length\}/, 'the pager must say how many are shown of how many');

  // …and "how many" must be a real count, not the ranker's default cap of 40.
  const buildSrc = read('extension/js/briefs-build.js');
  assert.match(buildSrc, /suggestMerges\(subjects, \{ limit: \d{3,} \}\)/,
    'the maintenance surface must ask for a real total, or "of N" is always the default cap');

  const rebuild = page.slice(page.indexOf('async function rebuild('), page.indexOf('async function explainEmpty('));
  assert.match(rebuild, /_maintCache = null/, 'a rebuild moves the corpus; the report is no longer a description of it');
}

console.log('briefs surface guards passed');
