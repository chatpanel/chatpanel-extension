// Attachments were flattened into the first message: every attached tab, in full, before the
// model had said anything. "hi" on a long page paid for the whole page, and five attached
// tabs put five documents in the prompt to answer a question about one paragraph of one.
import assert from 'node:assert/strict';

import { deferAttachedSources, withSourceTool } from '../extension/js/providers.js';

const big = (label) => `${label} intro.\n\n` + Array.from({ length: 60 }, (_, i) => `Para ${i}. ${'word '.repeat(40)}`).join('\n\n')
  + '\n\nThe deployment key rotates every 90 days.';
const tools = { specs: [{ name: 'page' }], system: 'page stuff', execute: async () => 'x' };
const withTabs = [{
  role: 'user', content: 'what is the rotation policy?',
  attachments: [
    { kind: 'page', title: 'Runbook', url: 'https://example.com/run', text: big('Runbook') },
    { kind: 'page', title: 'Changelog', url: 'https://example.com/log', text: big('Changelog') },
  ],
}];

// ── the prompt no longer carries the documents ──────────────────────────────
{
  const d = deferAttachedSources(withTabs, tools);
  assert.ok(d, 'Two large tabs are worth deferring.');
  const text = JSON.stringify(d.messages);
  assert.equal(text.includes('deployment key rotates'), false, 'The content is gone from the prompt…');
  assert.match(text, /read with `source`: id page-1/, '…replaced by how to fetch it.');
  assert.match(text, /Runbook/, 'while the title stays — knowing WHAT is attached is what lets a model decide to read it');

  const armed = withSourceTool(tools, d.store);
  assert.ok(armed.specs.some((s) => s.name === 'source'));
  assert.match(armed.system, /page-1 — Runbook/, 'The manifest is in the system prompt…');
  assert.equal(armed.system.includes('deployment key rotates'), false, '…and the manifest is not the content.');
  // The existing toolset is untouched — deferral must not disarm the page tools.
  assert.ok(armed.specs.some((s) => s.name === 'page'));
  assert.match(armed.system, /page stuff/);

  // And the model can actually get the answer, by asking for it.
  const got = JSON.parse(await armed.execute('source', { id: 'page-1', query: 'deployment key rotation' }));
  assert.match(got.text, /deployment key rotates/);
  assert.equal(got.truncated, true, 'and it is told it did not get everything');
}

// ── the two conditions, both necessary ──────────────────────────────────────
{
  // NO TOOLS: deferring content the model cannot then fetch does not save tokens, it deletes
  // the context — silently, which is the worst version of it.
  assert.equal(deferAttachedSources(withTabs, undefined), null);
  assert.equal(deferAttachedSources(withTabs, { specs: [] }), null);

  // TOO SMALL: below the threshold the extra round trip costs more than the text avoids.
  const small = [{ role: 'user', content: 'hi', attachments: [{ kind: 'page', title: 'Note', text: 'Two short lines.' }] }];
  assert.equal(deferAttachedSources(small, tools), null, 'A short selection still travels inline.');

  // Images are not text and cannot be read by `source`.
  const img = [{ role: 'user', content: 'x', attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,AAA' }] }];
  assert.equal(deferAttachedSources(img, tools), null);
}

// ── the manifest and the store must agree ───────────────────────────────────
{
  const d = deferAttachedSources(withTabs, tools);
  const armed = withSourceTool(tools, d.store);
  for (const entry of d.store.entries) {
    assert.ok(armed.system.includes(entry.id), `${entry.id} is offered…`);
    const got = JSON.parse(await armed.execute('source', { id: entry.id }));
    assert.ok(!got.error, `…and ${entry.id} can actually be read`);
  }
  // A model that asks for something that is not there gets the list, not a dead end.
  const miss = JSON.parse(await armed.execute('source', { id: 'page-9' }));
  assert.match(miss.error, /page-1, page-2/);
}

// ── the saving is the point ─────────────────────────────────────────────────
{
  const d = deferAttachedSources(withTabs, tools);
  const armed = withSourceTool(tools, d.store);
  const before = JSON.stringify(withTabs).length;
  const after = JSON.stringify(d.messages).length + armed.system.length;
  assert.ok(after < before / 5, `deferral should cut the prompt by most of it (was ${before}, now ${after})`);
}

console.log('✓ deferred sources: a manifest and a tool, not the documents');
