// Connector matcher: whole-word title mentions → [[wikilink]] candidates, skipping
// already-linked / self / dismissed / substrings. Pure — portable across modules.
import assert from 'node:assert/strict';
import { connectorMatches, existingLinks } from '../extension/js/cowriter-connect.js';

// 1) basic whole-word match, preserves the mention's original case.
{
  const hits = connectorMatches('We discussed Project Atlas at length today.', [
    { title: 'Project Atlas', url: 'notes.html#1' },
    { title: 'Roadmap', url: 'notes.html#2' },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Project Atlas');
  assert.equal(hits[0].mention, 'Project Atlas');
  assert.equal(hits[0].url, 'notes.html#1');
}

// 2) substring / mid-word mentions are NOT linked (whole-token only).
{
  const hits = connectorMatches('The category is broad.', ['cat']); // "cat" inside "category"
  assert.equal(hits.length, 0, 'substring should not match');
  const ok = connectorMatches('My cat is here.', ['cat'], { minLen: 3 });
  assert.equal(ok.length, 1, 'standalone token matches');
}

// 3) already-linked and self titles are skipped.
{
  const text = 'See [[Roadmap]] and also Roadmap again, plus Meeting Notes.';
  const hits = connectorMatches(text, ['Roadmap', 'Meeting Notes', 'This Note'], {
    selfTitle: 'This Note', linked: existingLinks(text),
  });
  assert.deepEqual(hits.map((h) => h.title), ['Meeting Notes'], 'Roadmap already linked, This Note is self');
}

// 4) dismissed keys are skipped; max caps the count.
{
  const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  const text = 'Alpha Bravo Charlie Delta Echo.';
  assert.equal(connectorMatches(text, titles, { max: 2 }).length, 2, 'max caps results');
  const d = connectorMatches(text, titles, { dismissed: new Set(['link:alpha']) });
  assert.ok(!d.some((h) => h.title === 'Alpha'), 'dismissed title excluded');
}

// 5) dedupes repeated titles and honors minLen.
{
  const hits = connectorMatches('ab ab Alpha Alpha', ['ab', 'Alpha']); // "ab" below default minLen 4
  assert.deepEqual(hits.map((h) => h.title), ['Alpha']);
}

// 6) existingLinks parses [[...]] case-insensitively.
{
  const set = existingLinks('x [[Foo Bar]] y [[baz]]');
  assert.ok(set.has('foo bar') && set.has('baz') && set.size === 2);
}

console.log('cowriter-connect tests passed');
