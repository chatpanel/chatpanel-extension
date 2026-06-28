import assert from 'node:assert/strict';

globalThis.chrome = {
  runtime: { getURL(path) { return `chrome-extension://abc/${path}`; } },
  storage: { onChanged: { addListener() {} }, local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

const { historyToolProvider } = await import('../extension/js/history-rag.js');

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function meetingSrc({ id, title, daysAgo, platform, people, terms = [], text }) {
  return {
    id: `meeting:${id}`,
    type: 'meeting',
    title,
    date: NOW - daysAgo * DAY,
    url: `chrome-extension://abc/meetings.html#${id}`,
    text: text || `SUMMARY: ${title}.\nTRANSCRIPT: discussion.`,
    contentText: text || `SUMMARY: ${title}.`,
    meta: { id, platform, people, terms },
  };
}

const data = [
  meetingSrc({
    id: 'right', title: 'Alex/Jordan 1:1', daysAgo: 3, platform: 'zoom',
    people: ['Alex Rivera', 'Jordan Blake'], terms: ['atlas', 'rollout'],
    text: 'SUMMARY: Jordan asked Alex to reach out to Priya and Sam for Atlas feedback.\nTRANSCRIPT: ...',
  }),
  meetingSrc({ id: 'old', title: 'Jordan / Alex 1:1 (prior)', daysAgo: 30, platform: 'zoom', people: ['Alex Rivera', 'Jordan Blake'] }),
  meetingSrc({ id: 'scrum', title: 'Platform Scrum', daysAgo: 1, platform: 'zoom', people: ['Jordan Blake', 'Ann Lee', 'Bob Roy', 'Cy Park'] }),
  meetingSrc({ id: 'meet', title: 'Design sync', daysAgo: 2, platform: 'meet', people: ['Dana Fox', 'Eli Ng'] }),
];

const loadSources = async ({ includeMeetings }) => (includeMeetings ? data : []);
const loadMeetingIndex = async () => data.map((s) => ({
  id: s.meta.id, title: s.title, startedAt: s.date, endedAt: s.date, platform: s.meta.platform, status: 'ended', lines: 12,
}));

const pro = historyToolProvider({ includeMeetings: true, loadSources, loadMeetingIndex, now: NOW });
const free = historyToolProvider({ includeMeetings: false, loadSources, loadMeetingIndex, now: NOW });

// Specs are meeting-only: present for Pro, absent for Free.
assert.ok(pro.specs.some((s) => s.name === 'history_list_meetings'));
assert.ok(pro.specs.some((s) => s.name === 'history_get_meeting'));
assert.equal(free.specs.some((s) => s.name === 'history_list_meetings'), false);
assert.equal(free.specs.some((s) => s.name === 'history_get_meeting'), false);

const ids = (txt) => (txt.match(/\[meeting:[a-z0-9_-]+\]/g) || []).map((m) => m.slice(1, -1));

// Recency (cheap index path — no participant/query needed).
const recent = await pro.execute('history_list_meetings', {});
assert.deepEqual(ids(recent), ['meeting:scrum', 'meeting:meet', 'meeting:right', 'meeting:old']);
assert.match(recent, /1d ago/);

// Participant filter (needs people → source path).
const withJordan = await pro.execute('history_list_meetings', { participant: 'jordan' });
assert.deepEqual(ids(withJordan), ['meeting:scrum', 'meeting:right', 'meeting:old'], 'all Jordan meetings, newest first');
assert.match(withJordan, /Alex Rivera, Jordan Blake/);

// "latest 1:1 with Jordan" — participant + oneOnOne drops the 4-person scrum.
const oneOnOnes = await pro.execute('history_list_meetings', { participant: 'jordan', oneOnOne: true, limit: 1 });
assert.deepEqual(ids(oneOnOnes), ['meeting:right'], 'newest 1:1 with Jordan');

// Relative since window (cheap path) — excludes the 30-day-old meeting.
const lastWeek = await pro.execute('history_list_meetings', { since: '7d' });
assert.deepEqual(ids(lastWeek).sort(), ['meeting:meet', 'meeting:right', 'meeting:scrum']);
assert.equal(ids(lastWeek).includes('meeting:old'), false);

// Absolute ISO since.
const since10 = await pro.execute('history_list_meetings', { since: new Date(NOW - 10 * DAY).toISOString() });
assert.equal(ids(since10).includes('meeting:old'), false);

// Platform filter.
const onMeet = await pro.execute('history_list_meetings', { platform: 'meet' });
assert.deepEqual(ids(onMeet), ['meeting:meet']);

// Keyword filter + relevant sort (matches topic terms, drops the rest).
const atlas = await pro.execute('history_list_meetings', { query: 'atlas', sort: 'relevant' });
assert.deepEqual(ids(atlas), ['meeting:right']);

// get_meeting accepts bare id and prefixed source id.
const bare = await pro.execute('history_get_meeting', { id: 'right' });
assert.match(bare, /Source: Alex\/Jordan 1:1/);
assert.match(bare, /reach out to Priya/);
const prefixed = await pro.execute('history_get_meeting', { id: 'meeting:right' });
assert.match(prefixed, /Source: Alex\/Jordan 1:1/);

// Free tier can't read meetings.
const blocked = await free.execute('history_get_meeting', { id: 'right' });
assert.match(blocked, /Pro feature/);
const blockedList = await free.execute('history_list_meetings', { participant: 'jordan' });
assert.match(blockedList, /Pro feature/);

// Empty filters → friendly empty message, not a crash.
const none = await pro.execute('history_list_meetings', { participant: 'nobody-here' });
assert.match(none, /No meetings matched/);

// Explicit /history directive only appears when explicit:true.
assert.doesNotMatch(pro.system, /explicitly invoked/);
assert.match(historyToolProvider({ includeMeetings: true, explicit: true }).system, /explicitly invoked \/history/);
assert.match(pro.system, /history_list_meetings/);

console.log('history list-meetings tests passed');
