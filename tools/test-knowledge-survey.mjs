// W0's runner, end to end: a backup file in, a measurement out.
//
// The point of testing the TOOL rather than only the pure passes (chatpanel-events covers
// those) is the seam that can actually rot: the tool builds its records with the extension's
// own conversationSource/meetingSource/noteSource, so if those shapes move — a meta field
// renamed, people no longer attached — the survey would quietly start measuring a corpus the
// product does not have. This is the test that notices.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'chatpanel-survey-'));
const day = 86_400_000;
const now = Date.UTC(2026, 0, 15);

const meetings = Array.from({ length: 6 }, (_, i) => ({
  record: {
    id: `m${i}`,
    title: i === 0 ? 'Atlas kickoff' : `Atlas sync ${i}`,
    startedAt: now - i * day,
    platform: 'meet',
    tags: ['atlas'],
    segments: [
      { speaker: i % 2 ? 'Alex Rivera' : 'Alex', text: 'the migration needs [[Atlas Charter]] signed off' },
      { speaker: 'Jordan Blake', text: 'pricing depends on it' },
    ],
  },
  notes: '## Decisions\n- proceed',
  topics: { items: ['atlas', 'migration'] },
}));

const conversations = Array.from({ length: 4 }, (_, i) => ({
  id: `c${i}`,
  title: `Chat ${i}`,
  updatedAt: now - i * 3600_000,
  tags: ['atlas'],
  messages: [
    { role: 'user', content: 'what did we decide about the atlas migration', at: now - i * 3600_000 },
    { role: 'assistant', content: 'You decided to proceed.' },
  ],
}));

const notes = [
  { id: 'n1', title: 'Atlas Charter draft', body: '# Atlas Charter draft\nsee [[Atlas kickoff]]', tags: ['atlas'], updatedAt: now },
  { id: 'n2', title: 'Marooned', body: 'connected to nothing', tags: [], updatedAt: now },
];

const backup = join(dir, 'backup.json');
writeFileSync(backup, JSON.stringify({ version: 8, conversations, meetings, notes }));

// stderr is piped, not inherited: the last case below asserts a FAILURE, and letting its
// error text land in the CI log makes a passing run look broken.
const run = (...args) => execFileSync(
  process.execPath, [join(root, 'tools/knowledge-survey.mjs'), ...args],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const { report, sweep } = JSON.parse(run(backup, '--json'));

// Every record in the backup reached the survey, under the product's own type names.
assert.equal(report.corpus.records, 12);
assert.deepEqual(report.corpus.byType, { chat: 4, meeting: 6, note: 2 });

// Speakers became a subject, and the bare label folded into the full name rather than
// splitting one person across two pages.
const alex = report.subjects.top.find((s) => s.kind === 'person' && s.name === 'Alex Rivera');
assert.ok(alex, `expected Alex Rivera among the subjects, got ${JSON.stringify(report.subjects.top)}`);
assert.ok(alex.aliases.includes('alex'), 'the bare speaker label should resolve into the full name');
assert.equal(alex.records, 6);

// A link nobody has written a record for is the corpus asking for a page.
assert.equal(report.wantedPages.top[0].target, 'Atlas Charter');
// …and a link that DOES resolve is not.
assert.ok(!report.wantedPages.top.some((w) => w.target === 'Atlas kickoff'));

// The note connected to nothing is the orphan; the tagged one is not.
assert.deepEqual(report.orphans.sample.map((r) => r.id), ['note:n2']);

// A recurring meeting series is not reported as a pile of duplicate titles.
assert.deepEqual(report.duplicateTitles, []);

// The spanning measure ran over the recent user turns the backup carries.
assert.equal(report.questions.considered, 4);
assert.ok(report.questions.fraction > 0, 'questions about a corpus this repetitive should span records');

// The sweep exists so the threshold is chosen; tightening it never admits more subjects.
assert.ok(sweep.length >= 2);
for (let i = 1; i < sweep.length; i += 1) assert.ok(sweep[i].qualifying <= sweep[i - 1].qualifying);

// The text rendering is what a human actually reads.
const text = run(backup);
assert.match(text, /CORPUS/);
assert.match(text, /WANTED PAGES/);
assert.match(text, /Atlas Charter/);

// An encrypted backup without a passphrase fails loudly rather than reporting an empty
// corpus — "0 records" would read as a measurement, and it would be a lie.
writeFileSync(join(dir, 'enc.json'), JSON.stringify({ type: 'chatpanel-backup-encrypted', v: 1 }));
let failed = false;
try { run(join(dir, 'enc.json')); } catch (err) {
  failed = true;
  assert.match(String(err.stderr || ''), /encrypted/);
}
assert.ok(failed, 'an encrypted backup with no passphrase must fail, not survey nothing');

console.log('knowledge survey tests passed');
