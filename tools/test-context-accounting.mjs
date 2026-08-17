// "2233 tokens for 'hello'" was visible in the turn record but unattributable — one number
// for the whole preamble. A cost nobody can attribute is a cost nobody can reduce.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildToolset } from '../extension/js/toolset.js';

const page = { specs: [{ name: 'page', description: 'act on the page', parameters: {} }], system: 'You are connected to the live tab.', execute: async () => '' };
const find = { specs: [{ name: 'find', description: 'search history', parameters: {} }], system: 'You HAVE access to the user own data. '.repeat(6), execute: async () => '' };

const built = buildToolset([page, find]);
assert.ok(built.systemParts, 'The preamble is broken down, not reported as one lump.');
// Named by the dispatcher tool, which is what the reader sees in the tools list.
assert.ok(built.systemParts.page > 0 && built.systemParts.find > 0);
assert.ok(built.systemParts.find > built.systemParts.page, 'The bigger blurb reads as the bigger cost.');
// The parts account for the whole, so nothing hides between them.
const total = Object.values(built.systemParts).reduce((a, b) => a + b, 0);
assert.ok(Math.abs(total - Math.round(built.system.length / 4)) <= 4, 'The breakdown adds up to the total.');

// A group contributing no preamble is not listed as costing nothing — an empty row is noise.
const silent = { specs: [{ name: 'quiet', description: '', parameters: {} }], execute: async () => '' };
assert.ok(!('quiet' in buildToolset([page, silent]).systemParts));

// ── the record is emitted once, at the chokepoint ───────────────────────────
{
  // It was emitted here AND in the sidepanel, so every chat turn logged it twice — and the
  // sidepanel copy only ever saw chat, which is why the accounting moved to the chokepoint
  // that notes and meetings also pass through.
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.equal(sidepanel.includes("logEvent('context.assembled'"), false, 'Only the chokepoint emits it.');
  const providers = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
  assert.equal((providers.match(/context\.assembled/g) || []).length, 1);
}

// ── the preamble does not describe things that are not there ────────────────
{
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  // Canvas drag guidance shipped on every page, including a news site with no canvas.
  // Untrue guidance costs more than the tokens it takes.
  assert.match(sidepanel, /residentSystem \? ' To DRAW or resize on a canvas/);
}

console.log('✓ context accounting: one record, attributed per tool group');

// ── a run knows what it was done FOR ────────────────────────────────────────
{
  const rd = await import('../extension/js/run-details.js');
  const ev = (type, at, turnId, payload = {}) => ({ id: `${type}-${at}`, causes: [], type, at, turnId, payload: { turnId, ...payload } });
  const { runs } = rd.groupRuns([
    ev('turn.started', 1, 'a', { kind: 'chat', sourceId: 'conv-1', surface: 'chat' }),
    ev('turn.ended', 2, 'a', { ms: 5 }),
    ev('turn.started', 3, 'b', { kind: 'suggestion', sourceId: 'conv-1', background: true }),
    ev('turn.ended', 4, 'b', { ms: 5 }),
  ]);
  assert.equal(runs.length, 2);
  // Without this the Activity view has nothing to group on.
  assert.ok(runs.every((r) => r.sourceId === 'conv-1'), 'every run carries its parent');

  const { threadsOf } = await import('../extension/js/events/trajectory.js');
  const threads = threadsOf(runs);
  assert.equal(threads.length, 1, 'a conversation and the autocomplete inside it are one thread');
  assert.equal(threads[0].turns, 2);
  assert.equal(threads[0].surface, 'chat', 'named after the work it exists for, not the background job');
}

console.log('✓ activity: runs carry their parent and group into threads');
