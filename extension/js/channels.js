// CHANNELS — reach your own agents from a messaging app, configured from Settings.
//
// The capability, not the screen: connect a bot, enroll a phone, see who is enrolled, stop.
// The settings page calls these; a first-run flow or the side panel could call the same six
// functions without a second implementation of "what does connected mean".
//
// WHERE THE WORK HAPPENS. Nothing here polls Telegram — a browser extension is the wrong place
// for a loop that must run while the browser is closed, and an MV3 service worker is suspended
// within seconds. The bridge hosts the adapter (it is the always-on local process a ChatPanel
// user already has) and exposes /channels; this module is a thin, honest client of that.
//
// The bot token goes ONE way: into the bridge, which verifies it with Telegram and writes it
// 0600. It is never stored in extension storage, never echoed back by /channels, and never
// logged — so a compromised profile does not hand over the bot.

// Every entry point takes a CONNECTION: either a bare URL string (what the panel has always
// passed) or `{ url, token }` when the user has supplied a bridge token by hand.
const connUrl = (conn) => (typeof conn === 'string' ? conn : conn?.url) || 'http://127.0.0.1:4319';
const connToken = (conn) => (typeof conn === 'string' ? '' : String(conn?.token || '').trim());
const base = (conn) => connUrl(conn).replace(/\/+$/, '');

// The first bridge on which channels actually WORK from the panel — which is NOT the release
// that added the route. 0.11.0 served /channels but as a privileged GET, and the panel can
// never satisfy that (see call() below), so it answered every settings page with "forbidden".
// A floor is the oldest bridge that works, not the oldest that has the code.
//
// It has to be a number, too: "too old" on its own is unactionable, because the bridge ships
// on its own version line and reaches a machine by two different routes (npm package vs
// standalone binary), so the user cannot tell whether an update would help or whether they
// already ran one. Name the floor, and name what they are on. Bump this ONLY when a channels
// change genuinely requires a newer bridge — it is a compatibility floor, not a "latest"
// marker (the Tesla rule: an older bridge is allowed to keep working).
export const MIN_BRIDGE_VERSION = '0.11.1';

/**
 * One request. Two failures are worth telling apart and both are common:
 *  • the bridge is not running at all — the user has nothing to fix in this screen;
 *  • the bridge is running but PREDATES channels (404) — an older bridge is not broken, it
 *    just cannot do this yet, and saying "update it" is the whole of the fix. The Tesla rule
 *    cuts both ways: a new panel must degrade against an old bridge instead of erroring.
 */
async function call(conn, path, { method = 'GET', body } = {}) {
  // A GET from this panel reaches the bridge ANONYMOUS, and no header we add here changes
  // that. The extension holds `<all_urls>`, so its fetches bypass CORS entirely — no preflight
  // ever fires — and the Fetch spec attaches `Origin` only to requests whose method is not GET
  // or HEAD. Hence the asymmetry: every POST below is recognised by the bridge, and the status
  // GET is not. The fix belongs on the bridge (GET /channels must not be a privileged route,
  // and is not from v0.11.1), NOT in a cleverer request here.
  const headers = body ? { 'content-type': 'application/json' } : {};
  // The fallback for the one case Origin genuinely cannot cover: a bridge on another machine.
  // Sent only when the user has actually entered a token.
  const token = connToken(conn);
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${base(conn)}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('The ChatPanel bridge isn’t running — start it, then try again.');
    err.code = 'no-bridge';
    throw err;
  }
  if (res.status === 404) {
    const err = new Error(`This bridge is too old for channels — it needs v${MIN_BRIDGE_VERSION} or newer (Settings → Agents → Bridge).`);
    err.code = 'unsupported';
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 403 here is not a broken server, it is a bridge too old to recognise the panel on a GET
    // — the same "update it" story as the 404, so channelStatus() tells it the same way.
    if (res.status === 403) {
      const err = new Error('The bridge refused this request.');
      err.code = 'forbidden';
      throw err;
    }
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.code = 'refused';
    throw err;
  }
  return json;
}

/** a.b.c → sortable tuple. Anything unparseable sorts lowest, so an unknown version reads as
 *  "too old" rather than silently passing a floor it was never checked against. */
const verTuple = (v) => String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
function olderThan(a, b) {
  const [x, y] = [verTuple(a), verTuple(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

/**
 * What the screen renders. Returns `{ supported: false, reason }` rather than throwing for the
 * two "nothing you typed is wrong" cases, so a settings page can show a calm sentence instead
 * of an error where a status badge should be.
 */
export async function channelStatus(conn) {
  try {
    return { supported: true, ...(await call(conn, '/channels')) };
  } catch (e) {
    if (e.code === 'no-bridge') return { supported: false, reason: e.message, code: e.code };
    if (e.code === 'unsupported' || e.code === 'forbidden') {
      // Name the version it IS, not only the one it needs. /health is unprivileged and carries
      // the same number the Bridge card shows, so the sentence can be checked against reality
      // instead of taken on faith. One request, only on a path that has already failed.
      const running = await bridgeVersion(conn);
      const stale = !running || olderThan(running, MIN_BRIDGE_VERSION);
      const where = 'Settings → Agents → Bridge';
      return {
        supported: false,
        code: e.code,
        running,
        required: MIN_BRIDGE_VERSION,
        reason: stale
          ? `${running ? `This bridge is v${running}, and channels` : 'Channels'} need v${MIN_BRIDGE_VERSION} or newer. Update it under ${where}.`
          // Version is fine but it still refused: the bridge cannot see who is calling, which
          // is what the token is for (typically a bridge on another machine).
          : `The bridge refused this request. Paste its token under ${where} → Bridge token.`,
      };
    }
    throw e;
  }
}

/** The running bridge's version, or '' if it cannot be read. Never throws — the caller is
 *  already on a failure path and a second failure there must not replace a useful sentence. */
async function bridgeVersion(conn) {
  try {
    const res = await fetch(`${base(conn)}/health`);
    if (!res.ok) return '';
    return String((await res.json())?.version || '');
  } catch {
    return '';
  }
}

/**
 * Every target a channel can answer from: the CLI agents this bridge runs, plus — when a
 * gateway is configured — the destinations it routes to (API providers, and the same agents
 * through its own bridge backend).
 *
 * Two sources rather than one because they are two different machines' worth of truth: the
 * bridge knows what is installed here, the gateway knows what the user configured there. A
 * missing gateway is not an error — it is the normal case for someone who has only installed
 * the bridge, and the picker simply shows agents.
 */
// How the gateway labels the models it reaches through the bridge. They are agents, and they
// belong in the agents group whatever the bridge itself managed to report.
const BRIDGE_OWNER = 'chatpanel-bridge';

export async function channelTargets({ bridgeAgents = [], gatewayUrl = '', destinations = [] } = {}) {
  const agents = bridgeAgents
    .filter((a) => a.available)
    .map((a) => ({ kind: 'agent', id: a.id, label: a.label || a.id }));
  if (!gatewayUrl) return { agents, providers: [], models: [], gateway: false };
  try {
    // The gateway's /v1 data plane is open to local callers by design, so there is no token
    // to hold here. Short timeout: a gateway that is not running must cost the settings page
    // a moment, not a spinner.
    const res = await fetch(`${String(gatewayUrl).replace(/\/+$/, '')}/v1/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { agents, providers: [], models: [], gateway: false };
    const body = await res.json().catch(() => ({}));
    const all = (body?.data || []).filter((m) => m?.id);
    const agentIds = new Set(agents.map((a) => a.id));

    // ONE ENTRY PER PROVIDER, FIRST. Publishing an endpoint makes the gateway list every model
    // that provider offers — 624 of them here — and a flat list of 624 is not a picker, it is
    // a haystack with the answer already in it: the model the user actually configured. So the
    // provider's own choice is promoted to the top, and the rest stays available underneath.
    //
    // The configured destinations are authoritative when the caller can read them (the
    // settings page holds the gateway's admin token). Without them, fall back to the first
    // model each provider reported — aggregateModels lists configured models before probed
    // ones, so this is right in practice and merely unlucky rather than wrong if it is not.
    const firstByOwner = new Map();
    for (const m of all) {
      const owner = m.owned_by || '';
      if (owner && !agentIds.has(m.id) && !firstByOwner.has(owner)) firstByOwner.set(owner, m.id);
    }
    // A gateway-reachable agent the bridge did not report (it was still starting, or is not
    // running at all) still belongs at the top rather than vanishing from the picker.
    for (const m of all) {
      if (m.owned_by === BRIDGE_OWNER && !agentIds.has(m.id)) {
        agents.push({ kind: 'agent', id: m.id, label: m.id });
        agentIds.add(m.id);
      }
    }
    const configured = destinations.filter((d) => d && d.type === 'api' && d.id);
    const providers = (configured.length
      ? configured.map((d) => ({ id: (d.models || []).find(Boolean) || firstByOwner.get(d.id), owner: d.id }))
      : [...firstByOwner.entries()].map(([owner, id]) => ({ id, owner })))
      .filter((p) => p.id)
      .map((p) => ({ kind: 'model', id: p.id, label: `${p.owner} — ${p.id}` }));

    const promoted = new Set(providers.map((p) => p.id));
    const models = all
      // An agent the gateway also exposes is already in the list under its own name; showing
      // it twice makes the user choose between two spellings of one thing. Filtered by OWNER
      // as well as by id, because the id match only works when the bridge answered in time —
      // and when it had not, every agent reappeared at the bottom as "codex (chatpanel-bridge)"
      // while the Agents group sat empty and hidden.
      .filter((m) => !agentIds.has(m.id) && !promoted.has(m.id) && m.owned_by !== BRIDGE_OWNER)
      .map((m) => ({ kind: 'model', id: m.id, label: m.owned_by ? `${m.id}  (${m.owned_by})` : m.id }));
    return { agents, providers, models, gateway: true };
  } catch {
    return { agents, providers: [], models: [], gateway: false };
  }
}

/** Verify a BotFather token and start polling. Throws with a sentence the user can act on. */
export function connectChannel(conn, { token, agent, privacy, tier } = {}) {
  return call(conn, '/channels/connect', { method: 'POST', body: { token, agent, privacy, tier } });
}

/** A one-time enrollment code + the t.me link that redeems it in a single tap. */
export function pairPhone(conn) {
  return call(conn, '/channels/pair', { method: 'POST', body: {} });
}

/** Revoke one phone. It stops being able to drive anything on its very next message. */
export function unpairPhone(conn, actorId) {
  return call(conn, '/channels/unpair', { method: 'POST', body: { actorId } });
}

/** Which agent answers, and how much of what you type is restored in the reply. */
export function updateChannel(conn, patch) {
  return call(conn, '/channels/settings', { method: 'POST', body: patch });
}

/** Stop polling. `forget` also deletes the stored bot token and every pairing. */
export function disconnectChannel(conn, { forget = false } = {}) {
  return call(conn, '/channels/disconnect', { method: 'POST', body: { forget } });
}

/** "telegram:12345" → "12345", for display. The prefix is the platform, not part of the id. */
export const chatIdOf = (actorId) => String(actorId || '').split(':').slice(1).join(':') || actorId || '';
