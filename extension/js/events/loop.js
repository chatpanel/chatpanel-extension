// GENERATED — do not edit.
// Source of truth: chatpanel-events/loop.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The loop contract — turn lifetime belongs to the kernel, not to the loop.
//
// We already run four loops: chat, meeting scribe, watch, and the notes swarm. They were
// never expressed once; each surface grew its own, and the shared parts were copied. On
// 2026-08-16 that produced a real bug — `streamChat` opened a turn, one exit path
// returned above the close, and every finished note reported itself as still running.
//
// The fix that day was to route both exits through one helper. The fix here is that
// there is nothing to route: a loop's `run` receives a context with NO way to open or
// close a turn. The runner opens before calling it and closes in `finally`, so "forgot to
// close on one path" is not a mistake a loop author is able to make. That is the
// difference between a bug fixed and a bug class removed.
//
// The runner takes `now`/`newId` rather than reading a clock, matching event.js: this
// package stays pure so the identical code runs in the extension, gateway and bridge, and
// so replay is reproducible (order.js never consults wall time; I6 asserts it).

export const LOOP_KINDS = Object.freeze(['chat', 'note', 'meeting', 'watch', 'assist', 'suggestion', 'topics', 'other']);

export class LoopError extends Error {
  constructor(code, message) { super(message); this.name = 'LoopError'; this.code = code; }
}

/**
 * Declare a loop. A declaration is inert — it names a kind and supplies `run`; the runner
 * supplies everything about when a turn exists.
 */
export function defineLoop({ id, kind = 'other', run, background = false }) {
  if (!id) throw new LoopError('BAD_LOOP', 'loop.id required');
  if (typeof run !== 'function') throw new LoopError('BAD_LOOP', `loop '${id}': run required`);
  return Object.freeze({ id, kind, run, background: !!background });
}

/**
 * @param emit    `(type, payload)` — the host maps these to the event schema. Kept as a
 *                plain hook so this module has no dependency on the log, matching registry.js.
 * @param decide  optional `(guard, request) => decision` — normally `kernel.decide`. A
 *                security plugin can refuse a turn before any model call happens, which is
 *                the whole reason guards exist below the loop rather than inside it.
 */
export function createTurnRunner({ now = () => 0, newId, emit = () => {}, decide = null } = {}) {
  if (typeof newId !== 'function') throw new LoopError('BAD_RUNNER', 'newId required — the runner must not invent identity');

  /**
   * Run one turn of `loop`. Returns whatever `run` returned.
   *
   * `request.turnId` lets a caller supply identity it already has (the side panel's
   * assistant-message id), so the turn record and the tool events that reference it group
   * into ONE run rather than two — the mismatch that split runs in Activity.
   */
  async function run(loop, request = {}) {
    if (!loop || typeof loop.run !== 'function') throw new LoopError('BAD_LOOP', 'runner.run needs a loop with run()');

    const turnId = request.turnId || newId();
    const kind = request.kind || loop.kind || 'other';

    // Ask BEFORE opening a turn: a denied turn should leave no trace of having started,
    // and a guard that only ran after the model call would be documentation, not a guard.
    if (decide) {
      const d = decide('turn.start', { turnId, kind, loopId: loop.id, ...request });
      if (d && d.allow === false) {
        emit('policy.denied', { turnId, kind, loopId: loop.id, reasons: d.reasons || [] });
        throw new LoopError('DENIED', `turn denied: ${(d.reasons || []).join('; ') || 'policy'}`);
      }
    }

    // The turn began when the USER acted, not when the model call did. Everything between
    // — assembling tools, connecting to MCP servers — is time they waited, and a duration
    // that excludes it says 2.6s about a message that took 48. Callers that know the real
    // moment pass it; the rest fall back to now.
    const startedAt = Number.isFinite(request.startedAt) ? request.startedAt : now();
    let closed = false;
    // Facts the loop learns while running — token usage, the model that actually served
    // it — belong on the turn record. The loop may CONTRIBUTE them; it still cannot
    // decide when the turn ends. Handing over the payload is not the same as handing over
    // the lifetime, and only the second one was ever the problem.
    let reported = {};
    // The ONE place a turn closes. Idempotent because a retry path or a double-catch must
    // not be able to write two endings for one turn — a log that can say a turn ended
    // twice cannot be replayed.
    const close = (reason, produced) => {
      if (closed) return;
      closed = true;
      emit('turn.ended', { ...reported, turnId, reason, stepped: !!produced, ms: now() - startedAt, kind });
    };

    emit('turn.started', {
      turnId, kind, loopId: loop.id,
      agentId: request.agentId || null,
      // WHICH THREAD THIS BELONGS TO. A run on its own is not the unit anyone reasons about —
      // a conversation is, and a meeting or a note can hold many runs (live monitors,
      // summaries, a swarm of agents). Without both halves the log is 1,205 unrelated rows.
      surface: request.surface || null,
      sourceId: request.sourceId || null,
      background: request.background ?? loop.background,
    });

    let produced = false;
    try {
      // NOTE what this context does NOT contain: no close, no end, no turn handle. A loop
      // cannot leave its own turn open because it was never given the ability to close it.
      const result = await loop.run({
        turnId,
        kind,
        signal: request.signal,
        request,
        /** Report that something reached the user — this is a fact about the turn, not control over it. */
        produced: () => { produced = true; },
        /**
         * Contribute facts to the turn record (tokens, model, cost). Merged into
         * `turn.ended`, and never able to overwrite the fields the runner owns — a loop
         * that could rewrite its own turnId or reason would be holding lifetime again by
         * another name.
         */
        report: (fields) => { if (fields && typeof fields === 'object') reported = { ...reported, ...fields }; },
        /** Loops emit their own domain events; lifetime is still not theirs. */
        emit: (type, payload) => emit(type, { turnId, ...payload }),
      });
      if (result !== undefined && result !== null && result !== '') produced = true;
      close(request.signal?.aborted ? 'aborted' : 'ok', produced);
      return result;
    } catch (err) {
      // An abort is not a failure: the user asking it to stop and the loop breaking are
      // different facts, and collapsing them makes the log useless for the question people
      // actually ask ("did it fail, or did I stop it?").
      close(request.signal?.aborted ? 'aborted' : 'error', produced);
      throw err;
    }
  }

  return { run };
}
