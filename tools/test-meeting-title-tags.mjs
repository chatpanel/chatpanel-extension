// Renaming, automatic naming, and tags — through the STORE, not the models.
//
// The shared model (normalization, the naming ladder) is tested in chatpanel-events.
// What this covers is the wiring that model has to survive in the extension:
//   • a rename holds while capture keeps flushing the same meeting (the content script
//     is the single writer of the record, and it re-sends the WHOLE thing every time);
//   • an automatic pass never overwrites a title a person typed;
//   • a better source may replace a weaker one, and never the other way round;
//   • tags round-trip through backup, along with WHO named the meeting.
import assert from 'node:assert/strict';

const local = new Map();
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
  storage: { local: area(local), session: area(new Map()), onChanged: { addListener() {} } },
  runtime: { id: 'test', getURL: (p) => p, sendMessage: async () => {} },
};

const M = await import('../extension/js/store-meetings.js');
const { autoTitleMeeting, backfillMeetingTitles } = await import('../extension/js/meeting-autotitle.js');
const { retitleMeetingWithModel, suggestMeetingTitle } = await import('../extension/js/meeting-title.js');
const { setConversationTags, saveConversation, getIndex } = await import('../extension/js/store.js');
const { rankMeetingEntries } = await import('../extension/js/meeting-search.js');
const { rankConversationEntries } = await import('../extension/js/conversation-search.js');

const START = Date.UTC(2026, 8, 2, 17, 0);
const meeting = (over = {}) => ({
  id: 'm1', platform: 'zoom', meetingKey: 'zoom:abc', title: 'Zoom Meeting',
  startedAt: START, endedAt: START + 1800_000, status: 'ended',
  segments: [{ t: START, speaker: 'Alex Rivera', text: 'Let us hold list price through Q3.' }],
  participants: [{ name: 'Alex Rivera' }, { name: 'Jordan Blake' }],
  ...over,
});

// ── a rename survives the next capture flush ──────────────────────────────────
await M.persistMeeting(meeting(), { enforceLimit: false });
await M.setMeetingTitle('m1', 'Q3 pricing call');
assert.equal((await M.getMeeting('m1')).title, 'Q3 pricing call', 'a read must show the user’s title');
assert.equal((await M.getMeetingIndex())[0].title, 'Q3 pricing call', 'the list renders from the index');

// The content script flushes the record again, still carrying the page's title.
await M.persistMeeting(meeting({ segments: [{ t: START, speaker: 'Alex Rivera', text: 'more' }] }), { enforceLimit: false });
assert.equal((await M.getMeeting('m1')).title, 'Q3 pricing call', 'a heartbeat must not revert a rename');
assert.equal((await M.getMeetingIndex())[0].title, 'Q3 pricing call');

// ── an automatic pass never overwrites a person's title ───────────────────────
assert.equal(await autoTitleMeeting('m1'), null, 'the user named it — nothing may rename it');
assert.equal(await retitleMeetingWithModel('m1', { force: true, complete: async () => 'Something Else' }), null,
  'not even an explicit AI rename overwrites a title the user typed');

// ── automatic naming, weakest source first ────────────────────────────────────
local.clear();
await M.persistMeeting(meeting({ id: 'm2', participants: [] }), { enforceLimit: false });
let out = await autoTitleMeeting('m2');
assert.equal(out.source, 'date', 'with nothing to go on, the date still beats "Zoom Meeting"');
assert.notEqual((await M.getMeeting('m2')).title, 'Zoom Meeting');

// Participants arrive → a better source may replace it.
await M.persistMeeting(meeting({ id: 'm2' }), { enforceLimit: false });
out = await autoTitleMeeting('m2');
assert.equal(out.source, 'participants');
assert.equal(out.title, 'Call with Alex, Jordan');

// The scribe's summary lands → better again.
await M.saveMeetingNotes('m2', '# Q3 pricing decision\n\nWe agreed to hold list price.');
out = await autoTitleMeeting('m2');
assert.equal(out.source, 'summary');
assert.equal(out.title, 'Q3 pricing decision');

// …and it does not churn from there: nothing deterministic beats a summary.
assert.equal(await autoTitleMeeting('m2'), null, 'a settled title must not be recomputed on every open');

// ── the model pass may improve on a deterministic title, and only that ────────
out = await retitleMeetingWithModel('m2', { complete: async () => 'Holding List Price Through Q3' });
assert.equal(out.title, 'Holding List Price Through Q3');
assert.equal((await M.getMeetingMeta('m2')).titleSource, 'model');
assert.equal(await autoTitleMeeting('m2'), null, 'the deterministic pass must not undo a model title');

// A model that gives nothing usable leaves the title alone.
await M.setMeetingTitle('m3', 'x'); // no record — nothing to name
assert.equal(await suggestMeetingTitle({ rec: meeting(), notes: '', complete: async () => 'UNKNOWN' }), '');
assert.equal(await suggestMeetingTitle({ rec: meeting(), notes: 'x', complete: async () => { throw new Error('offline'); } }), '',
  'an unreachable model is not an error on a meeting that captured fine');

// ── a naming fix reaches titles that are already stored ──────────────────────
// A meeting named under version 1 of the rules must be re-derived once, and then left
// alone — otherwise a fix only ever reaches meetings recorded after it shipped.
{
  local.clear();
  await M.persistMeeting(meeting({ id: 'old' }), { enforceLimit: false });
  await M.setMeetingTitle('old', 'stale name', { source: 'topics' }); // no rules stamp = v1
  const first = await autoTitleMeeting('old');
  assert.ok(first, 're-derived under the current rules');
  assert.equal((await M.getMeetingMeta('old')).titleRules > 0, true, 'and stamped with the version');
  assert.equal(await autoTitleMeeting('old'), null, 'then settled — no churn on every open');
}

// ── a real title from the page is left alone ──────────────────────────────────
local.clear();
await M.persistMeeting(meeting({ id: 'm4', title: 'Atlas / Platform sync' }), { enforceLimit: false });
assert.equal(await autoTitleMeeting('m4'), null);
assert.equal((await M.getMeeting('m4')).title, 'Atlas / Platform sync');

// ── the back catalogue ────────────────────────────────────────────────────────
local.clear();
await M.persistMeeting(meeting({ id: 'a' }), { enforceLimit: false });
await M.persistMeeting(meeting({ id: 'b', status: 'live', endedAt: 0 }), { enforceLimit: false });
const renamedIds = [];
const n = await backfillMeetingTitles(await M.getMeetingIndex(), { onRenamed: (id) => renamedIds.push(id) });
assert.equal(n, 1, 'only the ended meeting is named');
assert.deepEqual(renamedIds, ['a'], 'a live meeting is still its tab’s to name');

// ── tags ──────────────────────────────────────────────────────────────────────
local.clear();
await M.persistMeeting(meeting(), { enforceLimit: false });
const stored = await M.setMeetingTags('m1', ['Design Review', '#design-review', ' Q3 ']);
assert.deepEqual(stored, ['design-review', 'q3'], 'tags are normalized and deduped on write');
assert.deepEqual((await M.getMeeting('m1')).tags, ['design-review', 'q3'], 'a read carries them');
assert.deepEqual((await M.getMeetingIndex())[0].tags, ['design-review', 'q3'], 'so does the index the list renders');

// A flush from the content script must not drop them either.
await M.persistMeeting(meeting(), { enforceLimit: false });
assert.deepEqual((await M.getMeetingIndex())[0].tags, ['design-review', 'q3']);

// ── tags filter a list, and `tag:` in the search box is the same thing ────────
const entries = [
  { id: 'm1', title: 'One', tags: ['design-review', 'q3'], startedAt: 2 },
  { id: 'm2', title: 'Two', tags: ['q3'], startedAt: 1 },
  { id: 'm3', title: 'Three', tags: [], startedAt: 3 },
];
assert.deepEqual(rankMeetingEntries(entries, 'tag:q3').map((e) => e.id), ['m1', 'm2']);
assert.deepEqual(rankMeetingEntries(entries, '#q3 -tag:design-review').map((e) => e.id), ['m2']);
assert.deepEqual(rankMeetingEntries(entries, '').map((e) => e.id), ['m3', 'm1', 'm2'], 'no tag terms → unchanged');

// ── chats: the same vocabulary, the same filter ───────────────────────────────
local.clear();
await saveConversation({ id: 'c1', title: 'Pricing chat', messages: [{ role: 'user', content: 'hello' }] });
const chatTags = await setConversationTags('c1', ['Design Review']);
assert.deepEqual(chatTags, ['design-review'], 'one vocabulary — a chat tag normalizes like a meeting tag');
assert.deepEqual((await getIndex())[0].tags, ['design-review'], 'the index carries them so a list can filter');
assert.deepEqual(await setConversationTags('c1', ['design-review']), ['design-review']);

const chats = [
  { id: 'c1', title: 'One', tags: ['design-review'], updatedAt: 2 },
  { id: 'c2', title: 'Two', tags: [], updatedAt: 3 },
];
assert.deepEqual(rankConversationEntries(chats, 'tag:design-review').map((e) => e.id), ['c1']);
assert.deepEqual(rankConversationEntries(chats, 'C# generics').map((e) => e.id), [],
  'a # inside a word is text, not a tag');

// ── backup carries the labelling, provenance included ─────────────────────────
local.clear();
await M.persistMeeting(meeting(), { enforceLimit: false });
await M.setMeetingTitle('m1', 'Q3 pricing call');
await M.setMeetingTags('m1', ['q3']);
const payload = await M.exportMeetings();
assert.equal(payload[0].meta.titleSource, 'user', 'the backup records that a person named it');

local.clear();
await M.importMeetings(payload, { mode: 'replace' });
assert.equal((await M.getMeeting('m1')).title, 'Q3 pricing call', 'a restore gives back the user’s title');
assert.deepEqual((await M.getMeeting('m1')).tags, ['q3']);
assert.equal(await autoTitleMeeting('m1'), null, 'and a restored user title is still off-limits');

console.log('✓ meeting rename, automatic naming and tags');
