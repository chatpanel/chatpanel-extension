import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEETING_PLATFORMS, meetingMatches, platformFor, matchPattern } from '../extension/js/meeting-platforms.js';

// THE BUG THIS PREVENTS. The URL list lives in manifest.json's content_scripts and again in
// background.js. If they drift, capture silently stops working on a platform — and the
// symptom a user reports is "the meeting was not recorded", which points nowhere near a
// duplicated array. Same class as the retired search engine that kept appearing in
// settings, with a worse failure.
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const cs = manifest.content_scripts.find((c) => c.js?.some((f) => f.includes('meeting-core')));
assert.ok(cs, 'no meeting content script found in the manifest');
assert.deepEqual([...cs.matches].sort(), [...meetingMatches()].sort(),
  'manifest content_scripts and the declaration disagree — capture will break on whichever platform is missing');

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
assert.match(background, /meetingMatches\(\)/,
  'background.js still keeps its own copy of the meeting URL list');

// Every declared adapter file exists, so a platform cannot be declared without the code
// that implements it.
for (const p of MEETING_PLATFORMS) {
  const js = cs.js.find((f) => f.includes(`adapter-${p.id}`));
  assert.ok(js, `platform "${p.id}" is declared but its adapter is not loaded`);
}

// ── matching ────────────────────────────────────────────────────────────────
assert.equal(platformFor('https://meet.google.com/abc-defg-hij')?.id, 'meet');
assert.equal(platformFor('https://acme.zoom.us/wc/12345/join')?.id, 'zoom');
assert.equal(platformFor('https://teams.microsoft.com/_#/conversations')?.id, 'teams');
assert.equal(platformFor('https://acme.webex.com/meet/x')?.id, 'webex');
assert.equal(platformFor('https://example.com/meet'), null);

// A subdomain wildcard must not match the bare host's SUFFIX in another domain — the
// classic mistake that turns a match pattern into an open door.
assert.equal(matchPattern('https://*.zoom.us/wc/*', 'https://evil-zoom.us/wc/x'), false);
assert.equal(matchPattern('https://*.zoom.us/wc/*', 'https://a.zoom.us/wc/x'), true);
// A path prefix is a prefix, not a substring.
assert.equal(matchPattern('https://*.zoom.us/wc/*', 'https://a.zoom.us/other/wc/x'), false);
// http is never a match: these adapters run on https only.
assert.equal(matchPattern('https://meet.google.com/*', 'http://meet.google.com/x'), false);

console.log('✓ meeting platforms: one list, manifest agrees, patterns match safely');
