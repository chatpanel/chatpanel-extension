// Monetization gate for ChatPanel — three tiers.
//
//   free  → ONE local agent + ONE model endpoint (the user's pick), active-tab +
//           URL context, local history, built-in skills. One working agent is
//           the viral hook; it costs us nothing (user's own compute).
//   pro   → all your agents & models at once, multi-tab, custom skills, per-agent
//           system prompts, exports (soft-gated client features), AND "bring your
//           own" custom CLI agents. That last one is HARD-gated, not UI: the local
//           bridge verifies a server-signed entitlement token (ECDSA P-256, this
//           file's public key) before it will run a custom command, so it can't be
//           unlocked by editing the open-source client.
//   team  → cloud/server features that run on OUR infra (hard-gated, recurring).
//
// Pro/Team entitlement is verified by the ChatPanel server. Activation happens
// in-app and follows the user's purchase across their devices (with a one-tap
// email restore as a fallback).

const K_LICENSE = 'chatpanel:license'; // local: the active entitlement
const K_INSTALL = 'chatpanel:install'; // local: this device's stable id
const K_CLAIM = 'chatpanel:claim'; //  sync: portable "this account has a sub" token
const K_OPTOUT = 'chatpanel:proOptOut'; // local: user released Pro on THIS device

// License/entitlement server (Cloudflare Worker). Endpoints derived from the base.
const API_BASE = 'https://api.chatpanel.net';
const LICENSE_ENDPOINT = `${API_BASE}/license/verify`; // key path (back-compat)
const ENTITLEMENT_ENDPOINT = `${API_BASE}/entitlement`; // keyless poll
const CLAIM_ENDPOINT = `${API_BASE}/entitlement/claim`; // keyless auto-restore
const RELEASE_ENDPOINT = `${API_BASE}/entitlement/release`; // free this device's seat
const RESTORE_ENDPOINT = `${API_BASE}/restore`; // keyless email magic-link

// Public key used to verify the entitlement token returned by the server.
const ENTITLEMENT_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'CmgKLC4e3xDMvwhbjVqF7jbDe1JhC1KKQi8JN3qVX_4',
  y: 'r40l6fQiyCcJYqW-SvB4VoSyn4F36yhSt82ZAOSo78E',
};

// Where "Upgrade" sends people.
//
// UPGRADE_URL is the "compare plans" overview (the marketing pricing section).
// Both it and checkoutUrl() now point at the site pricing page, so plans, prices,
// coupons and the checkout provider can all change without re-releasing the
// extension — the extension only ever opens a stable URL + passes install_id.
export const UPGRADE_URL = 'https://chatpanel.net/#pricing';

// "Subscribe" opens the SITE pricing page rather than a fixed checkout link, so
// plans, prices, coupons and limited offers all live on the site + Stripe and can
// change WITHOUT re-releasing the extension. We pass this install's id so whichever
// plan the user picks seats THIS device; the extension then polls /entitlement (see
// subscribe()) and flips Pro on automatically. The site forwards install_id onto
// the buy buttons. `plan` is accepted for compatibility but the page is the picker.
export function checkoutUrl(plan = 'pro', installId = '') {
  const u = new URL('https://chatpanel.net/');
  if (installId) u.searchParams.set('install_id', installId);
  u.hash = 'pricing';
  return u.toString();
}

// Plans, lowest → highest. A feature is unlocked when the user's plan rank is
// >= the feature's required rank.
export const PLANS = ['free', 'pro', 'team'];
const RANK = { free: 0, pro: 1, team: 2 };

// Every gated feature maps to the minimum plan that unlocks it. Anything not
// listed is free.
export const FEATURE_TIER = {
  // free (listed for documentation; all resolve to allowed)
  localAgents: 'free',
  byoModels: 'free',
  urlContext: 'free',
  // pro — individual power features
  multiTab: 'pro',
  unlimitedAgents: 'pro',
  customSkills: 'pro',
  customAgents: 'pro', // "bring your own" CLI agent — HARD-gated, verified by the bridge
  advancedAgent: 'pro',
  structuredInsert: 'pro', // native-format insert for canvas apps (Excalidraw, …)
  exportChats: 'pro',
  promptLibrary: 'pro',
  fileAttachments: 'pro',
  liveMeetings: 'pro',
  watch: 'pro',
  // team — server-side / collaboration (enforced once the backend ships)
  cloudSync: 'team',
  sharedLibrary: 'team',
  hostedBridge: 'team',
  sso: 'team',
};

// Human-readable feature lists for the upgrade UI.
export const PRO_FEATURES = {
  multiTab: 'Attach several tabs at once',
  unlimitedAgents: 'Unlimited custom agents',
  customSkills: 'Create & edit your own skills',
  advancedAgent: 'Per-agent system prompts & working directories',
  structuredInsert: 'Native diagram insert for canvas apps (Excalidraw) — no pixel-drawing',
  exportChats: 'Export conversations as Markdown',
  liveMeetings: 'Live meeting scribe — capture & summarize Zoom, Google Meet, Teams & Webex',
  watch: 'Watch a page & act on changes — the agent reacts as the page updates',
};
export const TEAM_FEATURES = {
  cloudSync: 'Sync chats across your devices',
  sharedLibrary: 'Shared team agents & skills',
  hostedBridge: 'Hosted agents — no local bridge to run',
  sso: 'SSO & admin controls',
};

// Free-tier ceilings. Free gives one usable API endpoint AND one usable local
// CLI agent — the user picks which. Everything else stays visible but locked.
export const FREE_LIMITS = {
  apiEndpoints: 1, // usable API/BYO endpoints on Free
  bridgeAgents: 1, // usable local CLI agents (Claude Code / Codex / Gemini) on Free
  customAgents: 1, // saved custom agent configs before Pro is required
  attachmentsPerMessage: 1,
  mcpServers: 1, // usable MCP tool servers on Free — Pro is unlimited
};

export async function getLicense() {
  const got = await chrome.storage.local.get(K_LICENSE);
  return got[K_LICENSE] || { plan: 'free', key: '', status: 'inactive' };
}

// The raw server-signed entitlement token, for handing to the local bridge (which
// verifies it offline to gate Pro-only features like custom CLI agents). Empty
// string when not entitled or the token has expired.
export async function getEntitlementToken() {
  const lic = await getLicense();
  if (!lic || !lic.token) return '';
  if (lic.tokenExp && Date.now() > lic.tokenExp) return '';
  return lic.token;
}

async function setLicense(lic) {
  await chrome.storage.local.set({ [K_LICENSE]: lic });
  return lic;
}

// The effective plan, accounting for expiry.
export function planOf(license) {
  if (!license || !PLANS.includes(license.plan)) return 'free';
  if (license.expiresAt && Date.now() > license.expiresAt) return 'free';
  return license.plan;
}

export function planLabel(license) {
  return { free: 'Free', pro: 'Pro', team: 'Team' }[planOf(license)];
}

// Backwards-compatible helpers.
export function isPro(license) {
  return RANK[planOf(license)] >= RANK.pro; // pro OR team
}
export function isTeam(license) {
  return planOf(license) === 'team';
}

// Gate a feature. `count` lets callers express "this would be my Nth agent".
export function can(license, feature, count = 0) {
  const plan = planOf(license);
  // Free allows a limited number of custom agents before requiring Pro.
  if (feature === 'unlimitedAgents' && RANK[plan] < RANK.pro) {
    return count < FREE_LIMITS.customAgents;
  }
  const need = FEATURE_TIER[feature] || 'free';
  return RANK[plan] >= RANK[need];
}

// Which endpoint / bridge agent a Free user has designated as their single
// usable one. Falls back to the first of each — and self-heals if the saved id
// no longer exists (e.g. they deleted that agent) so something is always usable.
export function freeEndpointId(settings) {
  const eps = settings.endpoints || [];
  const saved = settings.freeEndpointId;
  if (saved && eps.some((e) => e.id === saved)) return saved;
  return eps[0]?.id || null;
}
export function freeAgentId(settings) {
  // Custom "bring your own" agents are Pro-only, so they can never be the single
  // free agent slot — only built-in bridge CLIs are eligible.
  const bridge = (settings.agents || []).filter((a) => a.kind === 'bridge' && a.bridgeAgent !== 'custom');
  const saved = settings.freeAgentId;
  if (saved && bridge.some((a) => a.id === saved)) return saved;
  return bridge[0]?.id || null;
}

// Can the current plan actually *use* this target (endpoint or bridge agent)?
// Pro unlocks everything; Free unlocks only the two designated free slots.
// `target` is an endpoint object or a bridge agent object.
export function canUseAgent(license, settings, target) {
  if (!target) return false;
  if (isPro(license)) return true;
  // Custom "bring your own" CLI agents are Pro-only (hard-gated by the bridge);
  // never usable on Free even if designated as the free slot.
  if (target.kind === 'bridge' && target.bridgeAgent === 'custom') return false;
  if (target.kind === 'bridge') return target.id === freeAgentId(settings);
  return target.id === freeEndpointId(settings);
}

// The plan a feature needs (for "✨ Pro" vs "✨ Team" upsell labels).
export function tierFor(feature) {
  return FEATURE_TIER[feature] || 'free';
}

// --------------------------------------------------------------------------
// Device identity + signed-token verification (keyless flow)
// --------------------------------------------------------------------------

// A stable per-install id, created once and kept in local storage. Losing it
// (reinstall / wiped storage) just means re-restoring on this device — the
// subscription is keyed by the purchase, never by the device.
export async function getInstallId() {
  const got = await chrome.storage.local.get(K_INSTALL);
  if (got[K_INSTALL]) return got[K_INSTALL];
  const raw = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = raw.replace(/[^A-Za-z0-9-]/g, '');
  await chrome.storage.local.set({ [K_INSTALL]: id });
  return id;
}

const b64urlToBytes = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

let _pubKeyPromise = null;
function entitlementKey() {
  if (!_pubKeyPromise) {
    _pubKeyPromise = crypto.subtle.importKey(
      'jwk',
      ENTITLEMENT_PUBLIC_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }
  return _pubKeyPromise;
}

// Verify a server entitlement token and return its payload, or null. We check the
// signature, that it's bound to THIS install, and that it hasn't expired.
async function verifyEntitlement(token, installId) {
  if (!token || token.indexOf('.') < 0) return null;
  const [head, sig] = token.split('.');
  const enc = new TextEncoder();
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await entitlementKey(),
      b64urlToBytes(sig),
      enc.encode(head),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(b64urlToBytes(head)));
  } catch {
    return null;
  }
  if (p.typ !== 'ent' || p.install_id !== installId) return null;
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}

// Persist a verified entitlement as the active license, and stash the portable
// claim in SYNC storage so the user's other Chrome devices self-restore.
async function applyEntitlement(result, installId) {
  const payload = await verifyEntitlement(result.token, installId);
  if (!payload) return null;
  if (result.claim) {
    try { await chrome.storage.sync.set({ [K_CLAIM]: result.claim }); } catch { /* sync may be off */ }
  }
  return setLicense({
    plan: PLANS.includes(payload.plan) ? payload.plan : 'pro',
    status: 'active',
    source: 'entitlement',
    sub: payload.sub || null,
    token: result.token,
    tokenExp: payload.exp || null,
    expiresAt: result.expiresAt || null,
    validatedAt: Date.now(),
  });
}

// Poll the server for an entitlement seated to this install. Returns the license
// on success, or null. Used after checkout and on revalidation.
export async function fetchEntitlement() {
  const installId = await getInstallId();
  let result;
  try {
    const res = await fetch(`${ENTITLEMENT_ENDPOINT}?install_id=${encodeURIComponent(installId)}`);
    if (!res.ok) return null;
    result = await res.json();
  } catch {
    return null;
  }
  if (!result.valid || !result.token) return null;
  return applyEntitlement(result, installId);
}

// Did the user explicitly release Pro on THIS device ("Deactivate")? If so, we
// suppress automatic re-restore (sync claim) until they opt back in via an
// explicit Subscribe/Restore.
export async function isOptedOut() {
  const got = await chrome.storage.local.get(K_OPTOUT);
  return !!got[K_OPTOUT];
}
async function clearOptOut() {
  await chrome.storage.local.remove(K_OPTOUT);
}

// Trade a portable claim token (from sync storage) for an entitlement on THIS
// device. This is how a second machine on the same Chrome profile auto-upgrades.
export async function claimFromSync() {
  if (await isOptedOut()) return null; // respect a deliberate device release
  let claim;
  try {
    const got = await chrome.storage.sync.get(K_CLAIM);
    claim = got[K_CLAIM];
  } catch {
    return null;
  }
  if (!claim) return null;
  const installId = await getInstallId();
  let result;
  try {
    const res = await fetch(CLAIM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim, install_id: installId }),
    });
    if (!res.ok) return null;
    result = await res.json();
  } catch {
    return null;
  }
  if (!result.valid || !result.token) return null;
  return applyEntitlement(result, installId);
}

// --------------------------------------------------------------------------
// Subscribe / restore (user-initiated)
// --------------------------------------------------------------------------

// Open checkout for `plan`, then poll until the webhook seats this device and the
// entitlement is live. `onActivated(license)` fires when Pro flips on. Returns a
// stop() function; polling also self-stops after ~5 minutes.
export async function subscribe(plan = 'pro', { onActivated, openTab } = {}) {
  await clearOptOut(); // explicit intent to have Pro on this device
  const installId = await getInstallId();
  const url = checkoutUrl(plan, installId);
  if (openTab) openTab(url);
  else if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url });
  else window.open(url, '_blank');

  let stopped = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  (async () => {
    // Poll a little faster at first, then back off.
    let delay = 3000;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      if (stopped) break;
      const lic = await fetchEntitlement();
      if (lic && isPro(lic)) {
        onActivated?.(lic);
        return;
      }
      delay = Math.min(delay + 1000, 8000);
    }
  })();
  return () => { stopped = true; };
}

// Ask the server to email a magic link that restores Pro on THIS device. Used
// when there's no Chrome sync (new browser, wiped storage, different profile).
// Always resolves ok — we never reveal whether the email has a subscription.
export async function restoreByEmail(email) {
  await clearOptOut(); // explicit intent to restore Pro on this device
  const installId = await getInstallId();
  try {
    await fetch(RESTORE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: (email || '').trim(), install_id: installId }),
    });
  } catch {
    /* swallow — the UI just says "check your email" */
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// License keys (back-compat) — manual / Team keys pasted by the user.
// --------------------------------------------------------------------------

export async function activate(key) {
  const trimmed = (key || '').trim();
  if (!trimmed) throw new Error('Enter a license key.');

  let result;
  if (LICENSE_ENDPOINT) {
    const res = await fetch(LICENSE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: trimmed }),
    });
    if (!res.ok) throw new Error(`Verification failed (HTTP ${res.status}).`);
    result = await res.json();
    if (!result.valid) throw new Error(result.error || 'That key is not valid.');
  } else {
    const m = /^CP-(PRO|TEAM)-[A-Z0-9]{6,}$/i.exec(trimmed);
    if (!m) throw new Error('Invalid key format. Expected CP-PRO-… or CP-TEAM-….');
    result = { valid: true, plan: m[1].toLowerCase() };
  }

  const plan = PLANS.includes(result.plan) ? result.plan : 'pro';
  return setLicense({
    plan,
    key: trimmed,
    status: 'active',
    source: 'key',
    expiresAt: result.expiresAt || null,
    validatedAt: Date.now(),
  });
}

export async function deactivate() {
  // Actually surrender THIS device's seat server-side (frees a cap slot) instead
  // of clearing local state only — otherwise the next /entitlement poll would
  // see the live seat and re-grant Pro. We also set a local opt-out so automatic
  // sync-restore won't immediately re-add this device. The SHARED sync claim is
  // left intact so the user's OTHER devices keep working. Subscribe/Restore clear
  // the opt-out when the user deliberately re-enables Pro here.
  try {
    const installId = await getInstallId();
    await fetch(RELEASE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: installId }),
    });
  } catch {
    /* best-effort; the opt-out below still stops local re-grant */
  }
  await chrome.storage.local.set({ [K_OPTOUT]: true });
  return setLicense({ plan: 'free', key: '', status: 'inactive' });
}

// --------------------------------------------------------------------------
// Periodic re-validation. Runs daily + on startup (see background.js).
//
// Fail-OPEN: a server/network error keeps the current plan (don't punish an
// offline user); only an explicit negative downgrades. Handles three cases:
//   • keyless (token)  → re-poll /entitlement; refresh token or drop to Free.
//   • key   (key)      → re-validate the key with the server.
//   • free             → opportunistically claim from sync (a sub bought on
//                        another device of the same Chrome profile shows up here).
// --------------------------------------------------------------------------
const REVALIDATE_EVERY_MS = 24 * 60 * 60 * 1000; // once a day

export async function revalidate({ force = false } = {}) {
  const lic = await getLicense();
  const throttled = !force && lic.validatedAt && Date.now() - lic.validatedAt < REVALIDATE_EVERY_MS;

  // Keyless entitlement.
  if (lic.source === 'entitlement' || lic.token) {
    if (throttled) return lic;
    const refreshed = await fetchEntitlement();
    if (refreshed) return refreshed;
    // Couldn't confirm. If the token itself is still valid (just offline), keep
    // Pro; only drop to Free once the signed token has actually expired.
    const installId = await getInstallId();
    const stillValid = await verifyEntitlement(lic.token, installId);
    if (stillValid) return lic;
    return setLicense({ plan: 'free', status: 'lapsed', source: 'entitlement', validatedAt: Date.now() });
  }

  // License key.
  if (lic.key && LICENSE_ENDPOINT && (planOf(lic) !== 'free' || lic.status === 'lapsed')) {
    if (throttled) return lic;
    let result;
    try {
      const res = await fetch(LICENSE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: lic.key, mode: 'validate' }),
      });
      if (!res.ok) return lic;
      result = await res.json();
    } catch {
      return lic;
    }
    if (!result.valid) {
      return setLicense({ ...lic, plan: 'free', status: 'lapsed', validatedAt: Date.now() });
    }
    return setLicense({
      ...lic,
      plan: PLANS.includes(result.plan) ? result.plan : 'pro',
      status: 'active',
      expiresAt: result.expiresAt || null,
      validatedAt: Date.now(),
    });
  }

  // Free with no key/token: maybe a sub exists for this Chrome profile.
  return (await claimFromSync()) || lic;
}
