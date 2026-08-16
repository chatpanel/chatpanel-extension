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

// Three distinct cases. Collapsing any two of them is a bug.
assert.equal(migratePageActions(true), PAGE_MODES.ALWAYS, 'legacy `true` must not lose behaviour');
assert.equal(migratePageActions(false), PAGE_MODES.OFF, 'an explicit opt-out must be honoured');
assert.equal(migratePageActions(undefined), PAGE_MODES.ASK, 'a new install must default to ask, or the feature is undiscoverable');
assert.equal(migratePageActions(null), PAGE_MODES.ASK);

// The default arms NOTHING — it only lets a recognised app offer. That is what makes it
// safe to default on.
assert.equal(resolvePageDecision({ mode: undefined, sites: {}, url: 'https://excalidraw.com/' }).decision, PAGE_DECISIONS.ASK);
assert.equal(resolvePageDecision({ mode: undefined, sites: {}, url: 'https://mail.example/' }).decision, PAGE_DECISIONS.OFF);
for (const url of ['https://excalidraw.com/', 'https://mail.example/', 'https://bank.example/']) {
  assert.ok(!shouldArm(resolvePageDecision({ mode: undefined, sites: {}, url }).decision), `default mode armed ${url}`);
}
// An explicit opt-out sees no offer at all, not even on a recognised app.
assert.equal(resolvePageDecision({ mode: false, sites: {}, url: 'https://excalidraw.com/' }).decision, PAGE_DECISIONS.OFF);
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
  const host = rule.hosts[0];
  const url = `https://${host}/`;
  // A multi-tenant rule keys grants per host; a single-tenant one uses its canonical site.
  const expected = rule.grantScope === 'host' ? host : rule.site;
  assert.equal(siteKeyFromUrl(url), expected, `siteKey mismatch for ${rule.ruleId}`);
  assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites: {}, url }).decision, PAGE_DECISIONS.ASK);
}

console.log('✓ page-match + page-policy');

// ---------------------------------------------------------------- one source of truth
// canvas-adapters delegates its hostname matching here. If the two ever diverge, the
// panel would arm on a site the adapter cannot actually drive (or the reverse).
const { CANVAS_ADAPTERS } = await import('../extension/js/canvas-adapters.js');
for (const rule of SITE_RULES) {
  // Only rules that CLAIM a structured path need an adapter behind them.
  if (!rule.adapterId) continue;
  const adapter = CANVAS_ADAPTERS.find((a) => a.id === rule.adapterId);
  assert.ok(adapter, `rule ${rule.ruleId} names a missing adapter`);
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

// ---------------------------------------------------------------- the offer journey
// The exact sequence a user lives through, asserted end to end: land on Excalidraw with
// the feature never enabled, click once, and it is on there and nowhere else.
let s = { pageActions: undefined, pageSites: {} };
const at = (url) => resolvePageDecision({ mode: s.pageActions, sites: s.pageSites, url });

// 1. Fresh install, never configured: Excalidraw OFFERS. Nothing is armed.
assert.equal(at('https://excalidraw.com/').decision, PAGE_DECISIONS.ASK);
assert.ok(!shouldArm(at('https://excalidraw.com/').decision));

// 2. The user clicks the offer once. That grants THIS site — never every tab.
s = { pageActions: PAGE_MODES.ASK, pageSites: grantSite(s.pageSites, at('https://excalidraw.com/').siteKey) };
assert.equal(at('https://excalidraw.com/').decision, PAGE_DECISIONS.ARM);

// 3. It is NOT on anywhere else — including another app ChatPanel knows.
assert.equal(at('https://mail.example/inbox').decision, PAGE_DECISIONS.OFF);
assert.equal(at('https://www.tldraw.com/').decision, PAGE_DECISIONS.ASK, 'another known app should offer, not arm');

// 4. Returning to Excalidraw later stays armed — the answer is remembered.
assert.equal(at('https://app.excalidraw.com/board/2').decision, PAGE_DECISIONS.ARM);

// 5. Clicking again on an armed, granted site withdraws it here and only here.
s = { ...s, pageSites: forgetSite(s.pageSites, 'excalidraw.com') };
assert.equal(at('https://excalidraw.com/').decision, PAGE_DECISIONS.ASK);

// 6. A legacy "on everywhere" user is untouched by any of this.
assert.equal(resolvePageDecision({ mode: migratePageActions(true), sites: {}, url: 'https://anything.example/' }).decision, PAGE_DECISIONS.ARM);

console.log('✓ offer journey (cold start → one click → armed here only)');

// ---------------------------------------------------------------- onboarding new apps
// A rule does NOT require an adapter. Generic page actions work everywhere; an adapter is
// just a faster route where one exists, so recognising an app is cheap.
const withAdapter = SITE_RULES.filter((r) => r.adapterId);
const recognisedOnly = SITE_RULES.filter((r) => !r.adapterId);
assert.ok(withAdapter.length >= 3 && recognisedOnly.length >= 3, 'both rule shapes must exist');
for (const r of recognisedOnly) assert.equal(matchUrl(`https://${r.hosts[0]}/`).adapterId, null);

// MULTI-TENANT ISOLATION. One organisation's grant must never span another's.
const contoso = siteKeyFromUrl('https://contoso.sharepoint.com/sites/x');
const fabrikam = siteKeyFromUrl('https://fabrikam.sharepoint.com/sites/y');
assert.notEqual(contoso, fabrikam, 'two tenants collapsed to one grant key');
assert.equal(contoso, 'contoso.sharepoint.com');
const tenantGrant = grantSite({}, contoso);
assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites: tenantGrant, url: 'https://contoso.sharepoint.com/a' }).decision, PAGE_DECISIONS.ARM);
assert.equal(
  resolvePageDecision({ mode: PAGE_MODES.ASK, sites: tenantGrant, url: 'https://fabrikam.sharepoint.com/a' }).decision,
  PAGE_DECISIONS.ASK,
  'a grant on one tenant leaked to another',
);
// Same for Notion workspace subdomains.
assert.notEqual(siteKeyFromUrl('https://a.notion.site/p'), siteKeyFromUrl('https://b.notion.site/p'));
// ...while a single-tenant app still shares one key across its subdomains.
assert.equal(siteKeyFromUrl('https://app.excalidraw.com/b'), siteKeyFromUrl('https://excalidraw.com/'));

// An unrecognised app is still onboardable by hand — the button grants that one host.
const custom = siteKeyFromUrl('https://wiki.internal.example/page');
assert.equal(custom, 'wiki.internal.example');
assert.equal(resolvePageDecision({ mode: PAGE_MODES.ASK, sites: grantSite({}, custom), url: 'https://wiki.internal.example/x' }).decision, PAGE_DECISIONS.ARM);

console.log('✓ onboarding: rules without adapters, per-tenant grants, manual sites');
