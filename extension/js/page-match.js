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
 *
 *   site      — the canonical, stable key a grant is remembered under
 *   hosts     — exact hostname matches
 *   suffixes  — subdomain matches (leading dot required, so 'notexcalidraw.com' cannot match)
 *   kind      — what the offer says: 'canvas' draws, 'sheet'/'doc' edit, 'app' is generic
 *   grantScope— 'site' (default) remembers the answer under the canonical `site`;
 *               'host' remembers it under the EXACT hostname. Multi-tenant suffixes MUST
 *               use 'host': contoso.sharepoint.com and fabrikam.sharepoint.com are
 *               different organisations, and one grant must never span both.
 *   adapterId — OPTIONAL. Present only where ChatPanel has a STRUCTURED path
 *               (canvas-adapters.js: one `structured_insert` instead of dozens of mouse
 *               strokes). Its absence is not a lesser rule — generic page actions work
 *               everywhere; the adapter is just a faster route where we have one.
 *
 * ONBOARDING A NEW APP is therefore three separate things, in increasing cost:
 *   1. nothing at all — the user clicks the button on any page and grants that one site;
 *   2. a rule here — the app is recognised, so it OFFERS instead of waiting to be found;
 *   3. a rule plus an adapter — as above, and the agent gets a native representation.
 * Most apps only ever need (2), and (1) already works for everything else today.
 */
export const SITE_RULES = Object.freeze([
  // --- structured path available (canvas-adapters.js) ---
  {
    ruleId: 'canvas:excalidraw',
    adapterId: 'excalidraw',
    kind: 'canvas',
    label: 'Excalidraw',
    site: 'excalidraw.com',
    hosts: ['excalidraw.com'],
    suffixes: ['.excalidraw.com'],
  },
  {
    ruleId: 'canvas:drawio',
    adapterId: 'drawio',
    kind: 'canvas',
    label: 'draw.io',
    site: 'diagrams.net',
    hosts: ['app.diagrams.net', 'draw.io', 'www.draw.io'],
    suffixes: ['.diagrams.net'],
  },
  {
    ruleId: 'canvas:tldraw',
    adapterId: 'tldraw',
    kind: 'canvas',
    label: 'tldraw',
    site: 'tldraw.com',
    hosts: ['tldraw.com', 'www.tldraw.com'],
    suffixes: ['.tldraw.com'],
  },

  // --- recognised, no structured path: generic page actions are worth offering ---
  {
    ruleId: 'canvas:figma',
    kind: 'canvas',
    label: 'Figma',
    site: 'figma.com',
    hosts: ['figma.com', 'www.figma.com'],
    suffixes: ['.figma.com'],
  },
  {
    ruleId: 'canvas:miro',
    kind: 'canvas',
    label: 'Miro',
    site: 'miro.com',
    hosts: ['miro.com', 'www.miro.com'],
    suffixes: ['.miro.com'],
  },
  {
    ruleId: 'canvas:canva',
    kind: 'canvas',
    label: 'Canva',
    site: 'canva.com',
    hosts: ['canva.com', 'www.canva.com'],
    suffixes: ['.canva.com'],
  },
  {
    ruleId: 'sheet:google',
    kind: 'sheet',
    label: 'Google Docs & Sheets',
    site: 'docs.google.com',
    hosts: ['docs.google.com', 'sheets.google.com'],
    suffixes: [],
  },
  {
    ruleId: 'sheet:microsoft365',
    grantScope: 'host',
    kind: 'sheet',
    label: 'Microsoft 365',
    site: 'microsoft365.com',
    hosts: ['www.office.com', 'office.com', 'www.microsoft365.com', 'microsoft365.com'],
    suffixes: ['.sharepoint.com', '.officeapps.live.com', '.office.com'],
  },
  {
    ruleId: 'doc:notion',
    grantScope: 'host',
    kind: 'doc',
    label: 'Notion',
    site: 'notion.so',
    hosts: ['notion.so', 'www.notion.so'],
    suffixes: ['.notion.so', '.notion.site'],
  },
].map(Object.freeze));

/** What the offer should call the action, per rule kind. */
export const KIND_VERB = Object.freeze({
  canvas: 'draw and edit',
  sheet: 'read and edit',
  doc: 'read and edit',
  app: 'act',
});

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
  if (!rule) return host;
  // A multi-tenant rule remembers the answer per HOST. Allowing one grant to span every
  // tenant behind a shared suffix would hand an agent one company's documents because a
  // user allowed it on another's.
  return rule.grantScope === 'host' ? host : rule.site;
}

/** Full match result for a URL, or null. Pure and allocation-light — safe on every tab event. */
export function matchUrl(url) {
  const host = hostFromUrl(url);
  if (!host) return null;
  const rule = matchHost(host);
  if (!rule) return null;
  return {
    ruleId: rule.ruleId,
    adapterId: rule.adapterId || null,   // null = recognised, but no structured path
    kind: rule.kind || 'app',
    label: rule.label,
    siteKey: rule.grantScope === 'host' ? host : rule.site,
    host,
  };
}
