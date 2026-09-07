// Which model to try, in what order — one answer, for every feature that needs one.
//
// WHY THIS EXISTS. Four features independently decided which model to run on, and every one
// of them got it wrong in its own way:
//   • suggestions      ordered its own list (correctly, and privately)
//   • autocomplete     picked one and gave up — fixed once, in its own copy
//   • the Notes swarm  appointed by MODEL TIER, ignoring what the user had selected in the
//                      panel entirely, so a user whose only working agent was Codex had to
//                      DISABLE their API cards to stop it choosing them
//   • the meeting scribe took the active target and never rotated
// and none of them asked the question that decides all four: can this thing actually answer
// right now? Shipping `claude-code` as a built-in means every install has a Claude Code entry
// whether or not Claude Code is on the machine — so "first in the list" and "will work" are
// routinely different targets, and the user is the one who finds out.
//
// THE RULE, and it is the user's: never default to what we ship. Default to what the user
// CHOSE, then to what is known to work, and only then to what merely exists. A CLI that is
// not installed is the last thing to try, not the first.
//
// Pure and dependency-injected — licence gating, target resolution and bridge health all
// arrive as arguments — so it runs in Node, the panel, the notes page and a worker alike, and
// so a test can pose "Codex installed, Claude not, one API card with no key" without a
// browser. Belongs in @chatpanel/events once a second client needs it; kept here for now
// because js/events/ is generated (tools/sync-events.mjs) and cannot be hand-edited.

/** Identity of a candidate. Same model in the same place is the same candidate. */
export const targetKey = (t) => `${t?.kind || ''}:${t?.id || ''}:${t?.model || ''}:${t?.baseUrl || ''}`;

/**
 * Is this target reachable right now?
 *
 * Three-valued ON PURPOSE. `true` and `false` are what the bridge's /health actually told us;
 * `undefined` is "nobody asked yet", and that is NOT the same as broken — the bridge may
 * simply not have been polled. An unknown target sorts between the two, so a fresh panel that
 * has not polled yet still offers CLI agents, and a polled one puts the installed ones first.
 *
 * @param bridgeAgents the `agents` array from the bridge's /health, or null when unpolled
 */
export function reachability(target, bridgeAgents) {
  if (!target) return false;
  if (target.kind !== 'bridge') return undefined; // an endpoint's health is only knowable by calling it
  if (!Array.isArray(bridgeAgents)) return undefined; // never polled — do not hold it against them
  // A "bring your own" CLI is not in /health (the bridge cannot enumerate user-defined
  // commands), so it is unknown rather than missing — it is validated when it runs.
  if (target.bridgeAgent === 'custom') return undefined;
  const found = bridgeAgents.find((a) => a.id === target.bridgeAgent);
  if (!found) return false;
  return found.available !== false;
}

const RANK = { true: 0, undefined: 1, false: 2 };
const reachRank = (r) => RANK[String(r)] ?? 1;

/**
 * Every target worth trying, best first.
 *
 * The order, and the reason for each step:
 *   1. `prefer`      — a feature's own explicit setting (the autocomplete model, a swarm role
 *                      override). An explicit choice always leads, even if it is cooling off.
 *   2. the ACTIVE target — what the user picked in the panel. This is the step the Notes
 *                      swarm was missing, and its absence is the whole bug: a model chosen in
 *                      one part of the product must not be silently overruled in another.
 *   3. other endpoints — an API the user configured and gave a model to. Cheap and remote.
 *   4. bridge agents  — a CLI is real cost and latency (a process is spawned to write four
 *                      short strings), so it is the answer only when nothing cheaper works.
 * Within 3 and 4, REACHABLE beats unknown beats known-missing.
 *
 * Dropped entirely: disabled targets (switched off deliberately), targets this plan cannot
 * use, and endpoints with no model chosen — an endpoint with no model cannot answer, and
 * offering it just moves the failure later.
 *
 * @param settings        the settings object
 * @param prefer          an explicit target id for this feature ('' = none)
 * @param license         passed straight to canUseAgent
 * @param canUseAgent     (license, settings, target) => boolean — from js/license.js
 * @param bridgeAgents    /health's `agents`, or null if the bridge has not been polled
 * @param includeBridge   false for features that must never spawn a CLI
 * @returns unresolved targets, best first, de-duplicated. Callers resolveTarget() them.
 */
export function orderTargets(settings, {
  prefer = '',
  license = null,
  canUseAgent = () => true,
  bridgeAgents = null,
  includeBridge = true,
} = {}) {
  const eps = settings?.endpoints || [];
  const ags = settings?.agents || [];
  const byId = (id) => eps.find((e) => e.id === id) || ags.find((a) => a.id === id) || null;

  const admissible = (t) => {
    if (!t) return false;
    if (t.enabled === false) return false;
    if (t.kind === 'bridge' && !includeBridge) return false;
    if (t.kind !== 'bridge' && !t.model) return false; // cannot answer without a model
    return canUseAgent(license, settings, t);
  };

  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!admissible(t)) return;
    const key = targetKey(t);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  add(byId(prefer));
  add(byId(settings?.activeAgentId));

  const rest = (list) => list
    .filter(admissible)
    .map((t, i) => ({ t, i, r: reachRank(reachability(t, bridgeAgents)) }))
    // Stable within a rank: a tie must not reshuffle between calls for no visible reason.
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);

  for (const t of rest(eps)) add(t);
  if (includeBridge) for (const t of rest(ags.filter((a) => a.kind === 'bridge'))) add(t);
  return out;
}

/** The single best target, or null when nothing configured can answer. */
export function bestTarget(settings, opts = {}) {
  return orderTargets(settings, opts)[0] || null;
}

/**
 * Why there is nothing to run on — worded for the person reading it, not the developer.
 *
 * "No model configured" is wrong and unhelpful when the truth is "you have three, and the
 * one you picked is a CLI that is not installed". Each branch names the next thing to do.
 */
export function noTargetReason(settings, { license = null, canUseAgent = () => true, bridgeAgents = null } = {}) {
  const eps = settings?.endpoints || [];
  const ags = settings?.agents || [];
  if (!eps.length && !ags.length) return 'No model set up yet — add an endpoint or agent in Settings.';
  const anyUsable = [...eps, ...ags].some((t) => canUseAgent(license, settings, t));
  if (!anyUsable) return 'Your plan has no model unlocked — pick your free model in Settings, or upgrade.';
  if (eps.some((e) => e.enabled !== false && !e.model)) {
    return 'Pick a model for your endpoint in Settings (API tab → Load models).';
  }
  const bridges = ags.filter((a) => a.kind === 'bridge' && a.enabled !== false);
  if (bridges.length && bridges.every((a) => reachability(a, bridgeAgents) === false)) {
    return 'The local agents you have set up were not found on this machine — install one, or add an API endpoint in Settings.';
  }
  return 'No usable model right now — check Settings.';
}

/**
 * Turn ON the local agents that are actually here, and OFF the ones that are not.
 *
 * WHY THE THIRD STATE. ChatPanel ships nine bridge CLIs as built-ins, and a machine
 * typically has one. Shipping them all switched ON meant the picker advertised eight agents
 * that could not answer, and every "first in the list" fallback in the product landed on
 * `claude-code` — the first built-in — on machines with no Claude Code. Shipping them all
 * switched OFF is worse: nothing would ever turn them on.
 *
 * So a built-in carries `autoEnable: true`, meaning "no human has an opinion about me yet —
 * follow the bridge". The moment the user flips the switch in Settings that marker is
 * cleared and their decision is permanent: an agent someone deliberately turned off must
 * never come back because a CLI reappeared on PATH, and one they deliberately turned on must
 * never vanish because the bridge was slow that morning.
 *
 * ONLY CALL THIS WITH A REAL ANSWER FROM /health. Passing the empty/absent list you get from
 * an unreachable bridge would read as "nothing is installed" and switch off every agent the
 * user has — which is why `bridgeAgents` must be an array and callers gate on bridge.ok.
 *
 * @returns { changed, agents } — `agents` is a new array; `changed` is false when nothing
 *          moved, so the caller can skip a settings write (and the storage event behind it).
 */
export function reconcileAutoEnable(agents, bridgeAgents) {
  const list = Array.isArray(agents) ? agents : [];
  if (!Array.isArray(bridgeAgents)) return { changed: false, agents: list };
  let changed = false;
  const next = list.map((a) => {
    if (!a || a.autoEnable !== true) return a;          // the user has decided — leave it
    if (a.kind !== 'bridge') return a;
    // A "bring your own" CLI is a user-defined command the bridge cannot enumerate, so
    // /health can never confirm it. Absence of evidence is not evidence of absence.
    if (a.bridgeAgent === 'custom') return a;
    const on = reachability(a, bridgeAgents) === true;
    if ((a.enabled !== false) === on) return a;
    changed = true;
    return { ...a, enabled: on };
  });
  return { changed, agents: changed ? next : list };
}
