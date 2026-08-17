// The extension's binding of the shared turn runner.
//
// Turn lifetime lives in @chatpanel/events (`loop.js`): a loop is handed a context with
// no way to close its own turn, so the runner opens before and closes in `finally`. This
// module supplies the three host-specific things that package deliberately refuses to
// invent — a clock, an id source, and where events go.
//
// LOADED ON DEMAND, never at first paint: providers.js is on the static graph, so this is
// reached through `await import()` from inside `streamChat`, which is already async. The
// module graph resolves once and is cached, so the first turn pays and no other does.

let runnerPromise = null;

/**
 * The shared runner, built once. Returns null if the module cannot be loaded — a caller
 * must still be able to run the turn. An observability layer that can take chat down is
 * worse than no observability layer.
 */
export function getTurnRunner() {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      const [{ createTurnRunner }, log] = await Promise.all([
        import('./events/loop.js'),
        import('./event-log.js'),
      ]);
      return createTurnRunner({
        now: () => Date.now(),
        newId: () => `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
        // Fire-and-forget: the log is a description of the turn, never a participant in it.
        emit: (type, payload) => { try { log.emitAsync(type, payload); } catch { /* never break a turn */ } },
      });
    })().catch(() => null);
  }
  return runnerPromise;
}

/**
 * Run `fn` as a turn. Falls back to running it directly — unwrapped, unrecorded — when the
 * runner is unavailable, because the alternative is that a logging failure becomes a chat
 * failure. The turn is then absent from the log rather than wrong in it, which is the
 * honest degradation: a missing run is visibly missing, a half-written one is not.
 */
export async function runAsTurn(spec, request, fn) {
  const runner = await getTurnRunner();
  if (!runner) return fn({ turnId: request?.turnId || null, emit: () => {}, produced: () => {} });
  return runner.run({ id: spec.id, kind: spec.kind, background: spec.background, run: fn }, request);
}
