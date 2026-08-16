import assert from 'node:assert/strict';

import { matchUrl, matchHost, siteKeyFromUrl, hostFromUrl, SITE_RULES } from '../extension/js/page-match.js';
import {
  PAGE_MODES, PAGE_DECISIONS, DEFAULT_MODE,
  migratePageActions, resolvePageDecision, grantSite, denySite, forgetSite, listSites, shouldArm,
} from '../extension/js/page-policy.js';

// ---------------------------------------------------------------- matching (class R)

assert.equal(matchUrl('https://excalidraw.com/#room=abc').adapterId, 'excalidraw');
assert.equal(matchUrl('https://app.excalidraw.com/board').adapterId, 'excalidraw');
assert.equal(matchUrl('https://app.diagrams.net/?src=about').adapterId, 'drawio');
assert.equal(matchUrl('https://www.tldraw.com/r/xyz').adapterId, 'tldraw');
assert.equal(matchUrl('https://example.com/'), null);

// A suffix rule must not match a lookalike domain.
assert.equal(matchHost('notexcalidraw.com'), null, 'suffix rule matched a lookalike domain');
assert.equal(matchHost('excalidraw.com.evil.example'), null, 'suffix rule matched a spoofed host');

// Non-web schemes are never readable pages.
assert.equal(hostFromUrl('chrome://extensions'), '');
assert.equal(hostFromUrl('file:///tmp/x.html'), '');
assert.equal(hostFromUrl('not a url'), '');
assert.equal(matchUrl('chrome://extensions'), null);

// Matching is deterministic — class R means byte-identical over repeated runs.
const once = JSON.stringify(matchUrl('https://excalidraw.com/'));
for (let i = 0; i < 5000; i++) assert.equal(JSON.stringify(matchUrl('https://excalidraw.com/')), once);

// siteKey is a policy key, never user data: canonical for a rule, exact host otherwise.
assert.equal(siteKeyFromUrl('https://app.excalidraw.com/x?doc=secret'), 'excalidraw.com');
assert.equal(siteKeyFromUrl('https://internal.corp.example/page'), 'internal.corp.example');
assert.ok(!siteKeyFromUrl('https://excalidraw.com/#room=private-id').includes('room'));

// ---------------------------------------------------------------- migration

assert.equal(migratePageActions(true), PAGE_MODES.ALWAYS, 'legacy `true` must not lose behaviour');
assert.equal(migratePageActions(false), PAGE_MODES.OFF);
assert.equal(migratePageActions(undefined), PAGE_MODES.OFF);
assert.equal(migratePageActions('ask'), PAGE_MODES.ASK);
assert.equal(migratePageActions('nonsense'), DEFAULT_MODE);

// A migrated `always` user keeps acting on an unmatched site — no silent regression.
assert.equal(
  resolvePageDecision({ mode: migratePageActions(true), sites: {}, url: 'https://random.example/' }).decision,
  PAGE_DECISIONS.ARM,
);

// ---------------------------------------------------------------- the safety rule

// ASK on a matched site OFFERS; it never arms without a grant.
const offer = resolvePageDecision({ mode: PAGE_MODES.ASK, sites: {}, url: 'https://excalidraw.com/' });
assert.equal(offer.decision, PAGE_DECISIONS.ASK);
assert.equal(offer.reason, 'rule:canvas:excalidraw');
assert.ok(!shouldArm(offer.decision), 'a matched site armed with no grant — authority was expanded');

// ASK on an unmatched site stays silent.
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.ASK, sites: {}, url: 'https://example.com/' }).decision,
  PAGE_DECISIONS.OFF,
);

// The click is the grant.
const granted = grantSite({}, 'excalidraw.com');
const armed = resolvePageDecision({ mode: PAGE_MODES.ASK, sites: granted, url: 'https://excalidraw.com/' });
assert.equal(armed.decision, PAGE_DECISIONS.ARM);
assert.equal(armed.reason, 'user-granted-site');

// MONOTONICITY: a deny outranks every mode, including 'always'.
const denied = denySite({}, 'bank.example');
for (const mode of Object.values(PAGE_MODES)) {
  assert.equal(
    resolvePageDecision({ mode, sites: denied, url: 'https://bank.example/accounts' }).decision,
    PAGE_DECISIONS.DENIED,
    `deny was overridden by mode '${mode}'`,
  );
}
// ...and a deny beats a grant on the same key, whichever was written last.
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.ALWAYS, sites: denySite(grantSite({}, 'x.example'), 'x.example'), url: 'https://x.example/' }).decision,
  PAGE_DECISIONS.DENIED,
);

// OFF means off, even on a granted, matched site.
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.OFF, sites: grantSite({}, 'excalidraw.com'), url: 'https://excalidraw.com/' }).decision,
  PAGE_DECISIONS.OFF,
);

// ALLOWLIST ignores rule matches — curation is the whole point of the mode.
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.ALLOWLIST, sites: {}, url: 'https://excalidraw.com/' }).decision,
  PAGE_DECISIONS.OFF,
);
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.ALLOWLIST, sites: grantSite({}, 'excalidraw.com'), url: 'https://excalidraw.com/' }).decision,
  PAGE_DECISIONS.ARM,
);

// Never armed on a non-readable page under any mode.
for (const mode of Object.values(PAGE_MODES)) {
  assert.ok(!shouldArm(resolvePageDecision({ mode, sites: {}, url: 'chrome://extensions' }).decision));
}

// ---------------------------------------------------------------- site table

let sites = grantSite({}, 'Excalidraw.com');            // case-insensitive
assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites, url: 'https://excalidraw.com/' }).decision, PAGE_DECISIONS.ARM);
sites = denySite(sites, 'bank.example');
assert.deepEqual(listSites(sites), [
  { siteKey: 'bank.example', state: 'denied' },
  { siteKey: 'excalidraw.com', state: 'granted' },
]);
sites = forgetSite(sites, 'excalidraw.com');
assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites, url: 'https://excalidraw.com/' }).decision, PAGE_DECISIONS.ASK);

// Garbage in the stored table is ignored rather than trusted.
assert.deepEqual(listSites({ 'a.example': 'maybe', 'b.example': 'granted' }), [{ siteKey: 'b.example', state: 'granted' }]);

// Every rule resolves consistently through the whole pipeline.
for (const rule of SITE_RULES) {
  const url = `https://${rule.hosts[0]}/`;
  assert.equal(siteKeyFromUrl(url), rule.site, `siteKey mismatch for ${rule.ruleId}`);
  assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites: {}, url }).decision, PAGE_DECISIONS.ASK);
}

console.log('✓ page-match + page-policy');

// ---------------------------------------------------------------- one source of truth
// canvas-adapters delegates its hostname matching here. If the two ever diverge, the
// panel would arm on a site the adapter cannot actually drive (or the reverse).
const { CANVAS_ADAPTERS } = await import('../extension/js/canvas-adapters.js');
for (const rule of SITE_RULES) {
  const adapter = CANVAS_ADAPTERS.find((a) => a.id === rule.adapterId);
  assert.ok(adapter, `no adapter for rule ${rule.ruleId}`);
  for (const host of rule.hosts) {
    assert.ok(adapter.match(host), `${adapter.id} stopped matching ${host}`);
    assert.equal(matchHost(host).adapterId, adapter.id);
  }
  for (const suffix of rule.suffixes) {
    assert.ok(adapter.match(`sub${suffix}`), `${adapter.id} stopped matching sub${suffix}`);
  }
  assert.ok(!adapter.match('example.com'), `${adapter.id} matches an unrelated host`);
}
console.log('✓ canvas-adapters delegates to page-match (one source of truth)');
