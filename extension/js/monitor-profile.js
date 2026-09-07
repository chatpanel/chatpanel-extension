// What a live monitor is allowed to read, and which model answers it.
//
// SPEED IS THE REQUIREMENT HERE, and quality is second — which is the opposite of a chat
// turn, and the reason this file exists. A monitor is a standing question re-answered every
// time the transcript grows; it is read at a glance, beside a call that is still happening. An
// answer that is right but arrives after the moment has passed is a wrong answer.
//
// What it was doing instead: taking the SAME toolset as a full chat turn — web search, the
// history RAG, every MCP server the user has connected, the note and memory writers — plus
// fifteen minutes of transcript, the running summary and every prior finding, and sending all
// of it to whichever model the conversation happened to be pointed at. Every one of those
// tools is a block of schema in the prompt whether or not it is called, and a big local model
// chosen for a coding chat is not the model you want answering "did anyone mention pricing?"
// while people are still talking.
//
// So a monitor gets its own profile: a shorter window, a chosen model, and an explicit list of
// what it may reach. Everything here is a pure function over settings — no DOM, no storage, no
// model — so the policy is testable without a meeting.

/** Sources a monitor can draw on. `transcript` is the only one that is not optional. */
export const MONITOR_SOURCES = Object.freeze({
  transcript: 'The live transcript (the last few minutes)',
  summary: 'The running meeting summary',
  findings: 'What this monitor already found',
  web: 'Web search',
  history: 'Your past chats, meetings & notes',
  mcp: 'Your connected MCP tools',
});

/**
 * Deliberately lean. Transcript + summary + prior findings is what almost every monitor
 * actually needs, and it costs one prompt with no tool schemas at all — which is the
 * difference between an answer during the call and an answer after it.
 */
export const DEFAULT_MONITOR_PROFILE = Object.freeze({
  targetId: '',      // '' = whatever the conversation uses. A fast model belongs here.
  windowMin: 5,      // minutes of transcript. Was 15, which is three times the prompt.
  maxFindings: 6,    // prior findings replayed for context; the rest stay on the card.
  maxMcpTools: 2,    // if MCP is on at all, advertise only the most relevant few.
  sources: Object.freeze({
    transcript: true,
    summary: true,
    findings: true,
    web: false,
    history: false,
    mcp: false,
  }),
});

const num = (v, fallback, min, max) => {
  // null/undefined/'' mean ABSENT, not zero. Number(null) is 0, which is finite, so a plain
  // isFinite check would clamp a missing value to the minimum — turning "not configured" into
  // "the smallest window there is", which is a different setting than the user has.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * The effective profile, from `settings.ui.monitors`.
 *
 * Absent or partial config resolves to the defaults, key by key — a user who set only the
 * model keeps the lean source list, and a user who set only the sources keeps the
 * conversation's model.
 */
export function monitorProfile(settings) {
  const cfg = settings?.ui?.monitors || {};
  const src = cfg.sources || {};
  return {
    targetId: String(cfg.targetId || ''),
    windowMin: num(cfg.windowMin, DEFAULT_MONITOR_PROFILE.windowMin, 1, 60),
    maxFindings: num(cfg.maxFindings, DEFAULT_MONITOR_PROFILE.maxFindings, 0, 40),
    maxMcpTools: num(cfg.maxMcpTools, DEFAULT_MONITOR_PROFILE.maxMcpTools, 0, 20),
    sources: Object.fromEntries(
      Object.keys(MONITOR_SOURCES).map((k) => [
        k,
        // The transcript is what a monitor IS. Switching it off would leave a question with
        // nothing to answer against, so it is not switchable.
        k === 'transcript' ? true : (src[k] === undefined ? DEFAULT_MONITOR_PROFILE.sources[k] : !!src[k]),
      ]),
    ),
  };
}

/** Milliseconds of transcript this profile wants. */
export const monitorWindowMs = (profile) => Math.max(1, profile?.windowMin || 5) * 60_000;

/**
 * Does this profile need ANY tools?
 *
 * The answer is normally no, and that is the whole point: with every source off, the turn
 * carries no tool schemas at all — which is both the fastest prompt and the one a small model
 * handles best. Building a toolset only to discard it would still pay for the MCP handshakes,
 * so callers check this BEFORE assembling one.
 */
export const monitorNeedsTools = (profile) =>
  !!(profile?.sources?.web || profile?.sources?.history || profile?.sources?.mcp);

/**
 * Keep only the tools this profile allows.
 *
 * Matched on the tool NAME rather than on how the toolset was built, so a provider that
 * starts emitting a new tool cannot quietly widen what a monitor can reach. Unknown names are
 * dropped: a monitor is the one turn where the safe default is "less".
 */
export function filterMonitorTools(toolset, profile) {
  const specs = toolset?.specs;
  if (!Array.isArray(specs) || !specs.length) return toolset;
  const s = profile?.sources || {};
  const allow = (name) => {
    const n = String(name || '');
    if (n.startsWith('mcp_')) return !!s.mcp;
    if (/^(web_search|search_web|fetch_url)$/.test(n)) return !!s.web;
    if (/^(history_search|history_get|find_related|smart_search)$/.test(n)) return !!s.history;
    // The live transcript reader is the transcript, which is always on.
    if (/^meeting_live_transcript$/.test(n)) return true;
    return false;
  };
  const kept = specs.filter((spec) => allow(spec?.name));
  return kept.length === specs.length ? toolset : { ...toolset, specs: kept };
}

/**
 * The prior findings worth replaying, newest last.
 *
 * A monitor that has been running for an hour has dozens; sending them all grows the prompt
 * without improving the answer, and the card still shows every one. The recent few are what
 * stop it repeating itself.
 */
export function recentFindings(findings, profile) {
  if (!profile?.sources?.findings) return [];
  const list = Array.isArray(findings) ? findings : [];
  const n = profile?.maxFindings ?? DEFAULT_MONITOR_PROFILE.maxFindings;
  return n > 0 ? list.slice(-n) : [];
}

/**
 * A one-line description of what this profile costs, for the settings screen.
 *
 * "Sources" is an abstraction; "transcript + summary, no tools — fastest" is a decision
 * someone can make. Naming the trade is what makes the control usable.
 */
export function describeMonitorProfile(profile) {
  const on = Object.entries(profile?.sources || {})
    .filter(([k, v]) => v && k !== 'transcript')
    .map(([k]) => k);
  const parts = ['last ' + (profile?.windowMin || 5) + ' min of transcript', ...on];
  const tools = monitorNeedsTools(profile);
  return `${parts.join(' + ')} — ${tools ? 'with tools, slower' : 'no tools, fastest'}`;
}
