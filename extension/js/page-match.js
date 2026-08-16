// DETERMINISTIC SITE MATCHING — class R: pure, synchronous, no DOM, no network, no
// model. Given a URL, decide whether a known app is running there.
//
// This module owns the rule table and `canvas-adapters.js` consumes it, deliberately
// inverting the obvious dependency: the LIGHT module holds the data, the HEAVY one
// (1200+ lines of scene serialization, CDP key chords, icon shorthand) imports it. If it
// were the other way round, matching a hostname would drag the whole automation graph
// onto the panel's first paint — and first paint is a release gate, not a goal.
//
// Matching only says "a structured path exists here". Whether anything is ARMED is
// policy, and lives in page-policy.js.

/**
 * A rule is data, not code, so it can be reasoned about without running it.
 *   site     — the canonical, stable key a grant is remembered under
 *   hosts    — exact hostname matches
 *   suffixes — subdomain matches (leading dot required, so 'notexcalidraw.com' cannot match)
 */
export const SITE_RULES = Object.freeze([
  {
    ruleId: 'canvas:excalidraw',
    adapterId: 'excalidraw',
    label: 'Excalidraw',
    site: 'excalidraw.com',
    hosts: ['excalidraw.com'],
    suffixes: ['.excalidraw.com'],
  },
  {
    ruleId: 'canvas:drawio',
    adapterId: 'drawio',
    label: 'draw.io',
    site: 'diagrams.net',
    hosts: ['app.diagrams.net', 'draw.io', 'www.draw.io'],
    suffixes: ['.diagrams.net'],
  },
  {
    ruleId: 'canvas:tldraw',
    adapterId: 'tldraw',
    label: 'tldraw',
    site: 'tldraw.com',
    hosts: ['tldraw.com', 'www.tldraw.com'],
    suffixes: ['.tldraw.com'],
  },
].map(Object.freeze));

export function hostMatchesRule(rule, host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return rule.hosts.includes(h) || rule.suffixes.some((s) => h.endsWith(s));
}

/** The rule for a hostname, or null. First match wins; rules are disjoint by construction. */
export function matchHost(host) {
  return SITE_RULES.find((r) => hostMatchesRule(r, host)) || null;
}

/** Hostname for a URL, or '' when it is not a readable web page (chrome://, file://, …). */
export function hostFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The key a grant is remembered under. NEVER the full URL — a URL is user data, a site
 * grant is policy, and only the second belongs in a durable record.
 *
 * A matched rule contributes its canonical `site`. Everything else falls back to the
 * EXACT hostname rather than guessing an eTLD+1: guessing wrong would widen a grant, and
 * a grant must never be broader than what the user actually agreed to.
 */
export function siteKeyFromUrl(url) {
  const host = hostFromUrl(url);
  if (!host) return '';
  const rule = matchHost(host);
  return rule ? rule.site : host;
}

/** Full match result for a URL, or null. Pure and allocation-light — safe on every tab event. */
export function matchUrl(url) {
  const host = hostFromUrl(url);
  if (!host) return null;
  const rule = matchHost(host);
  if (!rule) return null;
  return { ruleId: rule.ruleId, adapterId: rule.adapterId, label: rule.label, siteKey: rule.site, host };
}
