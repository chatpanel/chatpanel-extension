// GENERATED — do not edit.
// Source of truth: chatpanel-events/event.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The event envelope — durable facts only.
//
// ORDER WITHOUT CLOCKS. `at` is wall time and is ADVISORY: it is shown to humans and
// never consulted for ordering. `(host, seq)` plus `causes` are the authority, because
// once two hosts append concurrently a timestamp is not an order (see order.js).
//
// EPHEMERAL STREAMS ARE NOT THIS TYPE. Market ticks, live captions and DOM mutations
// live in an in-memory ring buffer with no id, no seq and no persistence; only the
// windowed aggregate that entered a model request or crossed the device boundary is
// promoted to an Event. That is structural rather than a rule to remember: durably
// logging a caption stream is ~3 MB per meeting, ~5.5 GB/year, and there is no Event
// type that would accept one.
//
// METADATA ONLY. Payloads carry Refs and counts, never content. `privacy.redacted`
// carries how many of each entity type were redacted and never the values — a log of
// what was redacted must not itself contain the redacted data.

import { isRef } from './ref.js';

export const CURRENT_VERSION = 1;

/** The seven families of v1. Adding is cheap; removing is not. */
export const EVENT_TYPES = Object.freeze({
  turn: ['started', 'ended'],
  // What the model was SHOWN and what it SAID. Deliberately arriving as refs, not text —
  // see the note on the validators below.
  assistant: ['prompted', 'message', 'reasoning'],
  context: ['assembled', 'attached', 'expanded'],
  capability: ['offered', 'granted', 'denied', 'activated', 'revoked', 'invoked', 'resulted'],
  privacy: ['redacted', 'egress'],
  policy: ['changed', 'guard_denied'],
  data: ['created', 'updated', 'deleted'],
  automation: ['fired', 'suppressed'],
});

export const ALL_TYPES = Object.freeze(
  Object.entries(EVENT_TYPES).flatMap(([fam, kinds]) => kinds.map((k) => `${fam}.${k}`)),
);

// 'channel' is a message arriving from a paired external surface — Telegram, WhatsApp — that
// drives a turn the same way a person pressing send does. It is turn-independent for the same
// reason 'schedule' and 'agent' are: nobody is sitting in the panel when it fires, so consent
// and reach have to be settled at pairing time, not at the keystroke. The actor.id carries the
// surface and the sender, e.g. 'telegram:8412…'. See chatpanel-channels for the invoker.
export const ACTOR_KINDS = Object.freeze(['user', 'rule', 'schedule', 'model', 'agent', 'channel']);
export const SCOPE_KINDS = Object.freeze(['global', 'site', 'tab', 'session', 'agent']);
export const CLASSES = Object.freeze(['R', 'M', 'L', 'C', 'A', 'X', 'H']);
export const EFFECTS = Object.freeze(['pure', 'idempotent', 'replay-safe', 'non-replayable']);
export const EGRESS = Object.freeze(['none', 'redacted', 'delegated']);

export class EventError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'EventError';
    this.code = code;
    this.detail = detail;
  }
}

const str = (v) => typeof v === 'string' && v.length > 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => Array.isArray(v);

function actorOk(a) { return !!a && ACTOR_KINDS.includes(a.kind) && str(a.id); }
function scopeOk(s) { return !!s && SCOPE_KINDS.includes(s.kind) && str(s.id); }

// Per-type payload requirements. Deliberately light — enough that a malformed event
// cannot enter an append-only log, not a full schema language.
const PAYLOAD = {
  'turn.started': (p) => str(p.turnId),
  'turn.ended': (p) => str(p.turnId),

  // ── assistant ─────────────────────────────────────────────────────────────
  // "Model-visible means logged" was true of the toolset and false of the conversation:
  // the log could say a turn happened and what it cost, but never what was asked or
  // answered. That is the half a trajectory view needs, and the half replay cannot be
  // checked without.
  //
  // CONTENT IS NEVER IN THE EVENT. Each of these carries a Ref — a content hash — and the
  // bytes live in the blob store. Three reasons, in order of how much they matter:
  //   1. The log stays metadata, so exporting or replicating it does not export the user's
  //      conversations by accident. That property is the whole reason an event log is safe
  //      to keep at all.
  //   2. Deletion stays honest: an append-only log cannot unsay a message, but a blob can
  //      be crypto-shredded and the ref then resolves to verified-but-unavailable. Inlined
  //      text would make "delete my data" a lie the schema enforces forever.
  //   3. Repeated content (the same system prompt on every turn) is stored once.
  'assistant.prompted': (p) => str(p.turnId) && isRef(p.ref),
  'assistant.message': (p) => str(p.turnId) && isRef(p.ref),
  'assistant.reasoning': (p) => str(p.turnId) && isRef(p.ref),

  'context.assembled': (p) => num(p.budget) && num(p.used) && !!p.parts && typeof p.parts === 'object'
    && arr(p.resident) && p.resident.every(isRef) && num(p.reachableCount),
  'context.attached': (p) => isRef(p.ref),
  'context.expanded': (p) => isRef(p.ref) && num(p.tokens),

  'capability.offered': (p) => str(p.capability) && str(p.reason),
  'capability.granted': (p) => str(p.capability) && actorOk(p.actor),
  'capability.denied': (p) => str(p.capability) && actorOk(p.actor),
  'capability.activated': (p) => str(p.capability) && CLASSES.includes(p.classUsed),
  'capability.revoked': (p) => str(p.capability) && str(p.cause),
  // I3 is enforced here structurally: a non-pure invocation without a key is not a
  // valid event, so it cannot reach the log at all.
  'capability.invoked': (p) => str(p.capability) && actorOk(p.actor) && scopeOk(p.scope)
    && EFFECTS.includes(p.effects) && (p.effects === 'pure' || str(p.idempotencyKey)),
  'capability.resulted': (p) => str(p.capability) && typeof p.ok === 'boolean'
    && CLASSES.includes(p.classUsed) && !!p.cost && num(p.cost.ms),

  // counts only — never values
  'privacy.redacted': (p) => !!p.counts && typeof p.counts === 'object'
    && Object.values(p.counts).every(num),
  'privacy.egress': (p) => str(p.host) && typeof p.redacted === 'boolean'
    && typeof p.controlled === 'boolean',

  'policy.changed': (p) => str(p.dial) && actorOk(p.actor) && 'from' in p && 'to' in p,
  'policy.guard_denied': (p) => str(p.capability) && str(p.reason),

  'data.created': (p) => isRef(p.ref),
  'data.updated': (p) => isRef(p.ref),
  'data.deleted': (p) => isRef(p.ref) && typeof p.shredded === 'boolean',

  'automation.fired': (p) => str(p.ruleId) && CLASSES.includes(p.classUsed),
  'automation.suppressed': (p) => str(p.ruleId) && str(p.reason),
};

/** Validate a durable event. Throws EventError; never mutates. */
export function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new EventError('SHAPE', 'event must be an object');
  if (e.v !== CURRENT_VERSION) throw new EventError('VERSION', `expected v=${CURRENT_VERSION}, got ${e.v} — upcast first`, e.v);
  if (!str(e.id)) throw new EventError('SHAPE', 'id required');
  if (!str(e.host)) throw new EventError('SHAPE', 'host required');
  if (!Number.isInteger(e.seq) || e.seq < 0) throw new EventError('SHAPE', 'seq must be a non-negative integer');
  if (!arr(e.causes) || !e.causes.every(str)) throw new EventError('SHAPE', 'causes must be string[]');
  if (!num(e.at)) throw new EventError('SHAPE', 'at required (advisory wall clock)');
  if (!ALL_TYPES.includes(e.type)) throw new EventError('TYPE', `unknown type ${e.type}`, e.type);
  if (!e.payload || typeof e.payload !== 'object') throw new EventError('SHAPE', 'payload required');
  const check = PAYLOAD[e.type];
  if (check && !check(e.payload)) throw new EventError('PAYLOAD', `payload invalid for ${e.type}`, e.type);
  return e;
}

export function isValidEvent(e) {
  try { validateEvent(e); return true; } catch { return false; }
}

/**
 * A per-host append cursor. Owns `seq` — the only monotonic thing in the system — so
 * callers cannot skip or reuse one.
 *
 * `now` and `newId` are injected so tests are deterministic and so the package holds no
 * ambient dependency on a clock or a crypto implementation.
 */
export function createAppender({ host, seq = 0, now = () => Date.now(), newId }) {
  if (!str(host)) throw new EventError('SHAPE', 'host required');
  const genId = newId || (() => globalThis.crypto.randomUUID());
  let n = seq;
  return {
    get host() { return host; },
    get seq() { return n; },
    /** Build + validate the next event for this host. Does not persist — the caller stores it. */
    append(type, payload, causes = []) {
      const e = Object.freeze({
        v: CURRENT_VERSION,
        id: genId(),
        host,
        seq: n++,
        causes: Object.freeze([...causes]),
        at: now(),
        type,
        payload,
      });
      return validateEvent(e);
    },
  };
}
