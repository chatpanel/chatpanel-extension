// PAGE-CAPABILITY POLICY — what "Act on page" is allowed to do, and where.
//
// Today this is one global boolean: off, or armed on EVERY readable tab. That forces a
// bad trade — a user on an Excalidraw board never discovers the feature, and a user who
// turns it on has it live on their bank and their email too. The only safe answer for a
// cautious user is to leave the best feature in the product switched off.
//
// So: a mode plus a per-site memory.
//
// THE RULE THAT MAKES IT SHIPPABLE — auto-activation may NARROW authority, never expand
// it. A rule matching a site produces an OFFER, never a silent grant; the user's click
// is the grant. A deny is sticky and beats every mode. And activation only makes the
// capability AVAILABLE — it executes nothing, so the per-action confirmation gate is
// untouched.
//
// MIGRATION IS BEHAVIOUR-PRESERVING. `true` becomes 'always', which still means every
// readable tab. Narrowing is offered as 'allowlist' and chosen, never imposed: an
// existing user who relies on act-on-page on some unmatched site must not silently lose
// it. New users get 'ask', which is where the safety win actually comes from.

import { matchUrl, siteKeyFromUrl } from './page-match.js';

export const PAGE_MODES = Object.freeze({
  OFF: 'off',              // never
  ASK: 'ask',              // offer on a matched site; remember the answer   (default for new users)
  ALLOWLIST: 'allowlist',  // only sites the user granted
  ALWAYS: 'always',        // every readable tab                             (legacy `true`)
});

export const PAGE_DECISIONS = Object.freeze({
  OFF: 'off',        // do nothing, say nothing
  ASK: 'ask',        // show the inline offer
  ARM: 'arm',        // make the capability available
  DENIED: 'denied',  // the user said no here; stay silent
});

export const SITE_STATES = Object.freeze({ GRANTED: 'granted', DENIED: 'denied' });

export const DEFAULT_MODE = PAGE_MODES.ASK;

/** Legacy boolean -> mode. `true` keeps meaning "every readable tab" — no regression. */
export function migratePageActions(value) {
  if (value === true) return PAGE_MODES.ALWAYS;
  if (value === false || value == null) return PAGE_MODES.OFF;
  const v = String(value).toLowerCase();
  return Object.values(PAGE_MODES).includes(v) ? v : DEFAULT_MODE;
}

export function normalizeSites(sites) {
  const out = {};
  if (!sites || typeof sites !== 'object') return out;
  for (const [k, v] of Object.entries(sites)) {
    const s = String(v).toLowerCase();
    if (s === SITE_STATES.GRANTED || s === SITE_STATES.DENIED) out[String(k).toLowerCase()] = s;
  }
  return out;
}

/**
 * The whole decision, as one pure function of (mode, sites, url).
 *
 * Returns { decision, siteKey, ruleId?, adapterId?, label?, reason } — `reason` is
 * carried so the event log can record WHY something armed, which is the difference
 * between an auditable policy and a mysterious one.
 */
export function resolvePageDecision({ mode, sites, url } = {}) {
  const m = migratePageActions(mode);
  const table = normalizeSites(sites);
  const siteKey = siteKeyFromUrl(url);
  const match = matchUrl(url);
  const base = { siteKey, ruleId: match?.ruleId, adapterId: match?.adapterId, label: match?.label };

  if (!siteKey) return { ...base, decision: PAGE_DECISIONS.OFF, reason: 'not-a-readable-page' };

  // A deny is sticky and outranks every mode, including 'always'. The most restrictive
  // answer anywhere in the chain wins — the same monotonic rule the policy kernel uses.
  if (table[siteKey] === SITE_STATES.DENIED) {
    return { ...base, decision: PAGE_DECISIONS.DENIED, reason: 'user-denied-site' };
  }
  if (m === PAGE_MODES.OFF) return { ...base, decision: PAGE_DECISIONS.OFF, reason: 'mode-off' };

  const granted = table[siteKey] === SITE_STATES.GRANTED;
  if (granted) return { ...base, decision: PAGE_DECISIONS.ARM, reason: 'user-granted-site' };

  if (m === PAGE_MODES.ALWAYS) return { ...base, decision: PAGE_DECISIONS.ARM, reason: 'mode-always' };
  if (m === PAGE_MODES.ALLOWLIST) return { ...base, decision: PAGE_DECISIONS.OFF, reason: 'not-on-allowlist' };

  // ASK: a rule matching produces an OFFER, never a grant. Silent activation without a
  // grant would expand authority beyond what the user set, so it is not done.
  return match
    ? { ...base, decision: PAGE_DECISIONS.ASK, reason: `rule:${match.ruleId}` }
    : { ...base, decision: PAGE_DECISIONS.OFF, reason: 'no-rule-match' };
}

/** Immutable updates — the caller persists the result. */
export function grantSite(sites, siteKey) {
  return { ...normalizeSites(sites), [String(siteKey).toLowerCase()]: SITE_STATES.GRANTED };
}
export function denySite(sites, siteKey) {
  return { ...normalizeSites(sites), [String(siteKey).toLowerCase()]: SITE_STATES.DENIED };
}
export function forgetSite(sites, siteKey) {
  const next = normalizeSites(sites);
  delete next[String(siteKey).toLowerCase()];
  return next;
}
export function listSites(sites) {
  return Object.entries(normalizeSites(sites))
    .map(([siteKey, state]) => ({ siteKey, state }))
    .sort((a, b) => a.siteKey.localeCompare(b.siteKey));
}

/** True when the capability should be available. The single check a caller needs. */
export function shouldArm(decision) {
  return decision === PAGE_DECISIONS.ARM;
}
