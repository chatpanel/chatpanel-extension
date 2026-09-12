// "Is the bridge running?" — one fetch, and nothing else.
//
// WHY IT IS ITS OWN FILE. This lived in providers.js, which is the model layer: 122 KB that
// drags the turn harness, the PII detector and the source contracts behind it — 382 KB across
// 25 modules. The side panel is careful to keep all of that off its first paint, and then
// undid the whole thing in init(), because refreshBridge() reached for `checkBridge` and the
// only way to get it was to load the model layer:
//
//     sidepanel static        769 KB / 40 modules   ← what the budget test measured
//     + providers at boot     939 KB / 49 modules   ← what actually loaded, every open
//
// 382 KB of turn machinery, fetched, parsed and instantiated on every panel open, to read one
// JSON object from localhost. On a low-spec Windows machine that is the difference between a
// panel that appears and a panel that hangs — which is exactly how it was reported.
//
// THE TIMEOUT is the other half. The old call was a bare fetch() with no signal. A refused
// connection answers instantly, but a DROPPED one does not: Windows security software and
// corporate filters routinely discard loopback SYNs rather than rejecting them, and the OS
// then retries for ~21 seconds before giving up. For all that time the panel's agent header
// sat unresolved behind a promise that looked like it was working. A bridge on this machine
// answers in milliseconds; anything that has not answered in two seconds is not going to.

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4319';

// Loopback is fast or it is absent. Long enough to survive a cold bridge process still
// binding its port, short enough that a dropped packet cannot hold up the UI.
export const HEALTH_TIMEOUT_MS = 2_000;

const baseOf = (url) => String(url || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');

/**
 * Ask the bridge what it is and what it has.
 *
 * Never throws and never hangs: a refusal, a timeout, a bad status and a body that is not
 * JSON are all just `{ ok: false, reason }`. Callers render a status line from this, and a
 * status line that can throw is a panel that can go blank.
 *
 * @param fetchImpl injected so the timeout behaviour is testable without a socket
 */
export async function checkBridge(bridgeUrl, { timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl = null } = {}) {
  const base = baseOf(bridgeUrl);
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, reason: 'no fetch in this context' };
  // AbortSignal.timeout is Chrome 103+/Firefox 100+, below both engines' floors here, but a
  // worker or a test double may not have it — fall back rather than throwing at the caller.
  let signal;
  try { signal = AbortSignal.timeout?.(timeoutMs); } catch { signal = undefined; }
  try {
    const res = await doFetch(`${base}/health`, { method: 'GET', ...(signal ? { signal } : {}) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    // `skills` is additive — an older bridge omits it entirely, which is exactly how a
    // newer client learns not to call endpoints that are not there (no lockstep).
    return {
      ok: true, agents: json.agents || [], version: json.version, update: json.update || null,
      skills: json.skills || null,
      workspace: json.workspace || '',
      // Who started the process (bridge 0.11.12+): 'desktop' when ChatPanel Desktop registered
      // it as a login service. Absent → '' — the install commands then apply.
      managedBy: typeof json.managedBy === 'string' ? json.managedBy : '',
    };
  } catch (e) {
    // A timeout arrives as an AbortError, and "signal is aborted without reason" tells the
    // user nothing about what to do. Name it as the thing it is.
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timedOut ? `no response in ${timeoutMs / 1000}s` : (e?.message || String(e)) };
  }
}
