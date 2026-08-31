// One spoken request must produce ONE job — across caption growth, across the same sentence
// arriving under a new segment id, and across the side panel being closed and reopened.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// DURABLE. Everything that deduped a command used to be in memory — the rule engine's set,
// the watermark, this page — so a reopened panel refired the last lines said, and deleting
// the duplicates just made room for more.
assert.match(src, /chrome\.storage\.local\.get\(VOICE_ACTED_KEY\)/, 'the acted-on record is read from disk');
assert.match(src, /chrome\.storage\.local\.set\(\{ \[VOICE_ACTED_KEY\]/, 'and written back');
assert.match(src, /VOICE_ACTED_MAX/, 'and capped, so a long meeting cannot grow it forever');

// SEMANTIC. Per-utterance identity is not enough: captions split one sentence across segments
// and re-emit it, so the same request returns under a new id.
assert.match(src, /const voiceGist = /, 'a request has an identity beyond its caption');
assert.match(src, /VOICE_REPEAT_MS/, 'and repeats within a window are suppressed');

// The guard is actually applied before dispatch, not merely defined.
assert.match(src, /const fresh = commands\.filter\(\(c\) => voiceIsFresh\(acted, c, nowTs\)\)/, 'filtered before dispatch');
assert.match(src, /if \(!fresh\.length\) return;/, 'and nothing dispatches when all are repeats');
assert.match(src, /await rememberVoiceActed\(fresh, nowTs\)/, 'recorded BEFORE dispatch, so a slow action cannot double-fire');

// Behaviour of the guard itself, exercised directly.
const voiceGist = (c) => `gist:${c.meetingId}:${c.intent}:${c.ms ?? c.when ?? ''}`;
const isFresh = (acted, c, now, win = 120000) => {
  if (acted.has(c.key)) return false;
  const at = acted.get(voiceGist(c));
  return !(at && now - at < win);
};
const acted = new Map();
const cmd = (key) => ({ key, meetingId: 'm', intent: 'voice:timer', ms: 30000 });

const first = cmd('voice:m:s:1:voice:timer:30000');
assert.equal(isFresh(acted, first, 1000), true, 'the first request runs');
acted.set(first.key, 1000); acted.set(voiceGist(first), 1000);

// The same sentence again under a NEW segment id — what "one per caption message" looked like.
assert.equal(isFresh(acted, cmd('voice:m:s:2:voice:timer:30000'), 5000), false, 'a repeat under a new id does not');
assert.equal(isFresh(acted, first, 9000), false, 'and neither does the identical utterance');
// Long enough later, the user meant it.
assert.equal(isFresh(acted, cmd('voice:m:s:9:voice:timer:30000'), 1000 + 130000), true, 'a genuinely new request later does run');
// A different request is never blocked by an unrelated one.
assert.equal(isFresh(acted, { key: 'k', meetingId: 'm', intent: 'voice:timer', ms: 60000 }, 5000), true);

console.log('ok — one spoken request is one job, across captions, ids, and panel reloads');
