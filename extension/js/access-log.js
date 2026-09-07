// What left this device, on the record.
//
// The extension had no answer to that question. The gateway did — /v1/observability/access —
// but the gateway is optional, and the one call that sends RAW, pre-redaction text off the
// machine happens whether or not it is running: entity detection. You cannot redact before
// you have detected, so the detector sees the request first, and `detection.url` may be any
// public http(s) host, not only loopback. It was SSRF-guarded and invisible.
//
// So the fact of it is recorded here, and shown in the SAME table as the gateway's rows
// (Privacy & Gateway → "what leaves this device"). One list, because a user asking "what left
// my machine" should not have to know which component happened to make the call.
//
// WHAT THIS MAY NEVER CONTAIN. The text that was sent, the entities that came back, or the
// detector URL's query string — a detector URL can carry an API key. A record of what was
// redacted must not itself contain the redacted data, so the shared `makeAccessEvent` is what
// builds a row and `note` is only ever counts. That is not a convention here; it is the whole
// reason the log is safe to keep.
//
// The ring is the shared one from @chatpanel/events; only the persistence is local.

import { createAccessLog, makeAccessEvent } from './events/observability.js';

const KEY = 'chatpanel.accessLog.v1';
// Small on purpose. This is a "did that just happen, and to whom" log, not an audit archive —
// and it lives in chrome.storage.local next to the user's actual history, which is the thing
// that must have the room.
const MAX = 200;

const ring = createAccessLog(MAX);
let loaded = null;

/** Read the persisted rows once per page. Never throws — a broken log must not break a page. */
async function ready() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const got = await chrome.storage.local.get(KEY);
      for (const e of got?.[KEY]?.items || []) ring.push(e);
    } catch { /* first run, or storage unavailable */ }
  })();
  return loaded;
}

// Writes are coalesced: a redacting turn can produce several detector calls in a burst, and
// one storage write per row is a write per keystroke in the worst case.
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try { await chrome.storage.local.set({ [KEY]: { v: 1, items: ring.snapshot().slice(0, MAX).reverse() } }); }
    catch { /* out of quota, or no storage — the in-memory ring still serves this page */ }
  }, 1000);
}

/**
 * Record one thing leaving the device.
 *
 * @param client  who did it, in the user's terms ('redaction', 'suggestions'…).
 * @param tool    what it was, short and specific ('detect:openai@ner.example.com').
 * @param ok/ms/error  the outcome. `note` is derived from counts and never from content.
 */
export async function recordAccess({ client, tool, ok = true, ms = null, error = '', counts = null } = {}) {
  try {
    await ready();
    const evt = makeAccessEvent({ ts: Date.now(), client, tool, ok, ms, error });
    // makeAccessEvent runs `args` through redactAccessArgs; we never hand it args at all, so
    // the note is built here from counts only — numbers cannot leak what they counted.
    if (counts) {
      evt.note = Object.entries(counts)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => `${v} ${k}`)
        .join(' · ');
    }
    ring.push(evt);
    scheduleFlush();
    return evt;
  } catch { return null; }
}

/**
 * The egress hook shape @chatpanel/pii's detectEntities expects. Never throws.
 *
 * Defensive about its own argument, not out of habit: pii calls this inside the detection
 * path, and a TypeError here would surface as a failed detection — the logger becoming the
 * reason text goes unredacted. Exactly backwards.
 */
export function detectorEgressHook(client = 'redaction') {
  return (e) => {
    try {
      const r = e || {};
      recordAccess({
        client,
        // The HOST, never the URL — the query string can hold a key. 'local' when the
        // detector is in-process and nothing actually left.
        tool: `detect:${r.backend || 'unknown'}@${r.host || 'local'}`,
        ok: r.ok !== false,
        ms: r.ms,
        error: r.error,
        counts: { entities: r.entities, chars: r.chars },
      });
    } catch { /* observability must never be the reason detection fails */ }
  };
}

/** Newest first, for the settings table. */
export async function accessRows(limit = MAX) {
  await ready();
  return ring.snapshot(limit);
}

export async function clearAccessLog() {
  ring.clear();
  try { await chrome.storage.local.remove(KEY); } catch { /* nothing to remove */ }
}
