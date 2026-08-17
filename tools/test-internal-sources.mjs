// A model was summarising an internal page and the turn went to a public inference host,
// because routing asked what the WORK needed and never asked where the material came from.
// These pin the two halves of the fix: the router prefers something local, and the GATE
// refuses when nothing local is available — including for a manually chosen model, which
// routing never sees.
import assert from 'node:assert/strict';

const mem = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (k == null ? { ...mem } : Object.fromEntries((Array.isArray(k) ? k : [k]).map((x) => [x, mem[x]]))),
    set: async (o) => Object.assign(mem, o),
  } },
  runtime: { id: 'test', onMessage: { addListener() {} } },
};

const { needForTurn, sourceGuardFor, sourcePolicySettings, reachOf, candidatesFrom } =
  await import('../extension/js/model-router.js');

const settings = {
  endpoints: [
    { id: 'ollama', name: 'Local', model: 'qwen3:26b', baseUrl: 'http://127.0.0.1:11434/v1' },
    { id: 'hf', name: 'HuggingFace', model: 'deepseek-ai/DeepSeek-V4-Flash', baseUrl: 'https://router.huggingface.co' },
  ],
};

// ── the defaults protect without configuration ──────────────────────────────
{
  const g = sourceGuardFor(settings, ['http://10.4.2.9/access-groups']);
  assert.ok(g, 'A private-range page is internal with no setup at all.');
  assert.equal(g.reach, 'device');
  assert.match(g.why, /10\.4\.2\.9/, 'and names the source that pinned it');
  assert.equal(sourceGuardFor(settings, ['https://example.com/docs']), null, 'A public page is untouched.');
}

// ── the ceiling reaches the router as a hard constraint ─────────────────────
{
  const need = needForTurn(settings, { request: { messages: [] }, sources: ['http://10.4.2.9/x'] });
  assert.equal(need.reach, 'device', 'The turn may not travel past the device.');
  assert.ok(need.requirementReasons.some((r) => /kept on this device/i.test(r)), 'and says why, in the decision');

  // Reach is never in `negotiable`: relaxation may drop capability, never privacy.
  assert.ok(!need.negotiable.includes('reach'));
  assert.equal(needForTurn(settings, { request: { messages: [] } }).reach, 'any', 'A public turn is unrestricted.');
}

// ── the switch, and the user's own domains ──────────────────────────────────
{
  const off = { ...settings, privacy: { internalGuard: false } };
  assert.equal(sourceGuardFor(off, ['http://10.4.2.9/x']), null, 'Turning it off turns it off.');

  const withDomain = { ...settings, privacy: { internalPatterns: ['acme-corp.example'] } };
  const g = sourceGuardFor(withDomain, ['https://clp.acme-corp.example/home']);
  assert.ok(g, 'A company domain on public DNS is covered once the user adds it.');
  assert.equal(sourceGuardFor(settings, ['https://clp.acme-corp.example/home']), null, 'and only once they do.');

  const ws = sourcePolicySettings({ privacy: { internalCeiling: 'trusted' } });
  assert.equal(ws.ceiling, 'trusted', 'A workspace ceiling is honoured…');
  assert.equal(sourcePolicySettings({ privacy: { internalCeiling: 'nonsense' } }).ceiling, 'device', '…and a bad value fails closed.');
}

// ── endpoints are classified with the same rules, but fail the other way ────
{
  assert.equal(reachOf({ baseUrl: 'http://127.0.0.1:11434/v1' }), 'device');
  assert.equal(reachOf({ baseUrl: 'http://192.168.1.50:8080/v1' }), 'trusted');
  assert.equal(reachOf({ baseUrl: 'https://router.huggingface.co' }), 'any');
  // A DESTINATION we cannot read must count as the furthest reach — the opposite of a
  // source, where an unreadable URL counts as internal. Calling it 'trusted' would admit it
  // to exactly the turns this is protecting.
  assert.equal(reachOf({ baseUrl: 'not a url' }), 'any');
  assert.equal(reachOf({ baseUrl: '' }), 'any');
}

// ── the router picks the local model for an internal source ─────────────────
{
  const { createModelRouter } = await import('../extension/js/events/router.js');
  const router = createModelRouter({ models: candidatesFrom(settings) });
  const need = needForTurn(settings, { request: { messages: [] }, sources: ['http://10.4.2.9/x'] });
  const d = router.route(need);
  assert.equal(d.model?.id, 'ollama', 'The local model answers it.');
  assert.ok(d.rejected.some((r) => r.id === 'hf' && /exceeds/.test(r.why)), 'The public host is eliminated, not merely ranked lower.');

  // And with NO local model there is no answer — a refusal, never a quiet substitution.
  const cloudOnly = { endpoints: [settings.endpoints[1]] };
  const r2 = createModelRouter({ models: candidatesFrom(cloudOnly) })
    .route(needForTurn(cloudOnly, { request: { messages: [] }, sources: ['http://10.4.2.9/x'] }));
  assert.equal(r2.model, null, 'Nothing eligible is a refusal, not a fallback to the cloud.');
}

console.log('✓ internal sources: pinned to the device, by reach, with a reason');

// ── the GATE: what stops a manually selected cloud model ────────────────────
//
// Routing alone cannot carry this. `pickRoutedAgent` returns null in every uncertain case
// (null = "leave the choice alone") and only runs under Auto — so a hand-picked cloud model
// never met the router at all. The gate runs on every turn regardless.
{
  const { sourceGate } = await import('../extension/js/providers.js');
  const internal = [{ role: 'user', content: 'summarise this', attachments: [{ kind: 'page', url: 'http://10.4.2.9/access-groups', title: 'Access groups' }] }];
  const cloud = { id: 'hf', name: 'HuggingFace', model: 'deepseek-ai/DeepSeek-V4-Flash', baseUrl: 'https://router.huggingface.co' };
  const local = { id: 'ollama', name: 'Local', model: 'qwen3:26b', baseUrl: 'http://127.0.0.1:11434/v1' };

  const blocked = await sourceGate(cloud, settings, internal);
  assert.equal(blocked?.blocked, true, 'A hand-picked cloud model is refused, not quietly allowed.');
  assert.match(blocked.message, /10\.4\.2\.9/, 'The refusal names the source…');
  assert.match(blocked.message, /Settings → Privacy/, '…and the way out. A refusal nobody can act on gets switched off wholesale.');

  assert.equal(await sourceGate(local, settings, internal), null, 'A local model answers it normally.');

  const publicPage = [{ role: 'user', content: 'x', attachments: [{ kind: 'page', url: 'https://example.com/a' }] }];
  assert.equal(await sourceGate(cloud, settings, publicPage), null, 'A public page is unaffected.');

  // THE WHOLE CONVERSATION IS SCANNED. An internal page attached three turns ago is still in
  // the text being sent now — checking only the newest message would leak it.
  const stale = [...internal, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and now?' }];
  assert.equal((await sourceGate(cloud, settings, stale))?.blocked, true);

  // A source the caller states outright (the active tab, a meeting URL) counts too.
  assert.equal((await sourceGate(cloud, settings, [], ['http://wiki/team']))?.blocked, true);

  // A workspace ceiling admits a LAN model but still not the cloud.
  const ws = { ...settings, privacy: { internalCeiling: 'trusted' } };
  assert.equal(await sourceGate({ baseUrl: 'http://192.168.1.50:8080/v1', name: 'LAN' }, ws, internal), null);
  assert.equal((await sourceGate(cloud, ws, internal))?.blocked, true);
}

console.log('✓ internal sources: the gate refuses rather than substituting or sending');

// ── the built-ins are editable, not a floor ─────────────────────────────────
{
  const { DEFAULT_INTERNAL_PATTERNS } = await import('../extension/js/events/sources.js');

  // Never configured → the built-ins apply, so protection exists before anyone visits the tab.
  assert.deepEqual(sourcePolicySettings({}).patterns, [...DEFAULT_INTERNAL_PATTERNS]);

  // Configured → that IS the list. Someone testing a local dev server against a cloud model
  // must be able to delete `localhost`, and prepending our defaults would make that
  // impossible while looking like it had worked.
  // Both lines have to go: '<intranet>' means any bare hostname, and 'localhost' has no dot,
  // so the two overlap. The settings hint says so, because deleting one line and still being
  // blocked reads as the setting being ignored.
  const noLocalhost = { privacy: { internalPatterns: DEFAULT_INTERNAL_PATTERNS.filter((p) => p !== 'localhost' && p !== '<intranet>') } };
  assert.equal(sourceGuardFor(noLocalhost, ['http://localhost:3000/app']), null, 'localhost can be removed…');
  assert.ok(sourceGuardFor(noLocalhost, ['http://10.4.2.9/x']), '…without giving up the rest.');
  assert.ok(sourceGuardFor({ privacy: { internalPatterns: ['<intranet>'] } }, ['http://localhost:3000']), 'and <intranet> alone still covers it.');
  assert.ok(sourceGuardFor({}, ['http://localhost:3000/app']), 'and it is protected by default.');

  // Configured to nothing is a choice, and must be expressible.
  assert.equal(sourceGuardFor({ privacy: { internalPatterns: [] } }, ['http://10.4.2.9/x']), null);
}

console.log('✓ internal sources: the built-in list is seeded, visible and editable');

// ── every candidate form is a line the user can delete ──────────────────────
{
  const { DEFAULT_INTERNAL_PATTERNS } = await import('../extension/js/events/sources.js');
  const seeded = sourcePolicySettings({}).patterns;
  // Each family of "cannot be public" address is represented explicitly rather than folded
  // into code, so excluding one is a line edit rather than a feature request.
  for (const p of ['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12',
    '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fe80::/10', 'fc00::/7',
    '*.internal', '*.corp', '*.lan', '*.local', '*.home.arpa', '<intranet>']) {
    assert.ok(seeded.includes(p), `${p} should be a visible, removable line`);
  }
  assert.equal(seeded.length, DEFAULT_INTERNAL_PATTERNS.length);
  // Removing one family leaves the others standing — the point of listing them separately.
  const noV6 = { privacy: { internalPatterns: DEFAULT_INTERNAL_PATTERNS.filter((p) => !p.includes(':')) } };
  assert.equal(sourceGuardFor(noV6, ['http://[fd12::1]/x']), null);
  assert.ok(sourceGuardFor(noV6, ['http://10.0.0.1/x']));
}

console.log('✓ internal sources: every candidate is a line, and each can be excluded alone');

// ── excluding ONE pattern, not all or nothing ───────────────────────────────
{
  const { INTERNAL_PATTERN_CATALOG, DEFAULT_INTERNAL_PATTERNS } = await import('../extension/js/events/sources.js');

  // Every built-in is independently switchable. All-or-nothing would force someone testing
  // against localhost to give up the private ranges as well.
  const without = (p) => DEFAULT_INTERNAL_PATTERNS.filter((x) => x !== p);
  const cases = [
    ['10.0.0.0/8', 'http://10.4.2.9/x'],
    ['192.168.0.0/16', 'http://192.168.1.10/x'],
    ['fc00::/7', 'http://[fd12::1]/x'],
    ['*.local', 'http://printer.local/x'],
    ['100.64.0.0/10', 'http://100.70.0.1/x'],
  ];
  for (const [pattern, url] of cases) {
    assert.ok(sourceGuardFor({}, [url]), `${url} is internal by default`);
    assert.equal(sourceGuardFor({ privacy: { internalPatterns: without(pattern) } }, [url]), null,
      `unticking ${pattern} releases exactly ${url}`);
    // …and releasing that one leaves every other rule standing.
    assert.ok(sourceGuardFor({ privacy: { internalPatterns: without(pattern) } }, ['http://172.16.0.1/x'])
      || pattern === '172.16.0.0/12', 'the other rules are untouched');
  }

  // The UI writes chosen built-ins plus the user's own, deduplicated: a domain typed by hand
  // that is already a built-in must not appear twice, where unticking one box would look
  // like it had done nothing.
  const merged = [...new Set([...without('*.corp'), 'acme-corp.example', '*.local'])];
  assert.equal(merged.filter((x) => x === '*.local').length, 1);
  assert.ok(!merged.includes('*.corp'));

  // Every row the UI offers is a rule the classifier actually applies.
  assert.deepEqual(INTERNAL_PATTERN_CATALOG.map((x) => x.pattern), [...DEFAULT_INTERNAL_PATTERNS]);
}

console.log('✓ internal sources: any single pattern can be excluded on its own');

// ── the master switch is not a select-all ───────────────────────────────────
{
  const { DEFAULT_INTERNAL_PATTERNS } = await import('../extension/js/events/sources.js');
  // Turning the guard off does mean none of these rules apply — but it must not CLEAR them.
  // Someone who unticked localhost, switched the guard off for a day and switched it back on
  // should find their exclusion still there; a select-all would have silently restored a rule
  // they deliberately removed.
  const mine = DEFAULT_INTERNAL_PATTERNS.filter((p) => p !== 'localhost' && p !== '<intranet>');
  const off = { privacy: { internalGuard: false, internalPatterns: mine } };
  assert.equal(sourceGuardFor(off, ['http://10.4.2.9/x']), null, 'Off means nothing is pinned…');
  assert.deepEqual(sourcePolicySettings(off).patterns, mine, '…while the exclusions are kept intact.');

  const backOn = { privacy: { internalGuard: true, internalPatterns: mine } };
  assert.ok(sourceGuardFor(backOn, ['http://10.4.2.9/x']), 'Back on restores the rules that were kept…');
  assert.equal(sourceGuardFor(backOn, ['http://localhost:3000/x']), null, '…and not the one that was removed.');
}

console.log('✓ internal sources: the master switch suspends the rules without discarding them');
