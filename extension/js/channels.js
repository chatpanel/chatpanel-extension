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

const base = (bridgeUrl) => (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/+$/, '');

/**
 * One request. Two failures are worth telling apart and both are common:
 *  • the bridge is not running at all — the user has nothing to fix in this screen;
 *  • the bridge is running but PREDATES channels (404) — an older bridge is not broken, it
 *    just cannot do this yet, and saying "update it" is the whole of the fix. The Tesla rule
 *    cuts both ways: a new panel must degrade against an old bridge instead of erroring.
 */
async function call(bridgeUrl, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${base(bridgeUrl)}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('The ChatPanel bridge isn’t running — start it, then try again.');
    err.code = 'no-bridge';
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('This bridge is too old for channels — update it (Settings → API → Bridge).');
    err.code = 'unsupported';
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.code = 'refused';
    throw err;
  }
  return json;
}

/**
 * What the screen renders. Returns `{ supported: false, reason }` rather than throwing for the
 * two "nothing you typed is wrong" cases, so a settings page can show a calm sentence instead
 * of an error where a status badge should be.
 */
export async function channelStatus(bridgeUrl) {
  try {
    return { supported: true, ...(await call(bridgeUrl, '/channels')) };
  } catch (e) {
    if (e.code === 'no-bridge' || e.code === 'unsupported') return { supported: false, reason: e.message, code: e.code };
    throw e;
  }
}

/** Verify a BotFather token and start polling. Throws with a sentence the user can act on. */
export function connectChannel(bridgeUrl, { token, agent, privacy, tier } = {}) {
  return call(bridgeUrl, '/channels/connect', { method: 'POST', body: { token, agent, privacy, tier } });
}

/** A one-time enrollment code + the t.me link that redeems it in a single tap. */
export function pairPhone(bridgeUrl) {
  return call(bridgeUrl, '/channels/pair', { method: 'POST', body: {} });
}

/** Revoke one phone. It stops being able to drive anything on its very next message. */
export function unpairPhone(bridgeUrl, actorId) {
  return call(bridgeUrl, '/channels/unpair', { method: 'POST', body: { actorId } });
}

/** Which agent answers, and how much of what you type is restored in the reply. */
export function updateChannel(bridgeUrl, patch) {
  return call(bridgeUrl, '/channels/settings', { method: 'POST', body: patch });
}

/** Stop polling. `forget` also deletes the stored bot token and every pairing. */
export function disconnectChannel(bridgeUrl, { forget = false } = {}) {
  return call(bridgeUrl, '/channels/disconnect', { method: 'POST', body: { forget } });
}

/** "telegram:12345" → "12345", for display. The prefix is the platform, not part of the id. */
export const chatIdOf = (actorId) => String(actorId || '').split(':').slice(1).join(':') || actorId || '';
