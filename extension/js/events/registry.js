// GENERATED — do not edit.
// Source of truth: chatpanel-events/registry.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The capability registry — revertible effects and reactive availability.
//
// This is the runtime half of the capability contract: `requires` / `provides` in a
// declaration (capability.js) only mean something because something binds them here.
//
// WHY THIS AND NOT CORDIS. We need exactly two behaviours — effects that carry their own
// inverse, and dependents that unwind when a capability withdraws and re-arm when it
// returns. That is roughly 15% of Cordis's surface; we need neither its plugin registry,
// its Proxy-based ctx, its config schema, its logger nor HMR. At ~200 lines this costs
// nothing against a first-paint budget that is a release gate, has no CSP surface, and
// ports to every runtime. The concepts port; the framework does not.
//
// THE TWO RULES THAT MATTER, and the bug class each prevents:
//
//   1. LIFO disposal. Inverses run in reverse order of registration, so each one meets
//      the state its own application produced. Anything else hands an inverse a state it
//      was not built for.
//
//   2. Dependents deactivate BEFORE a provider's binding is removed. A component being
//      torn down because its provider is going away is running its own teardown, and
//      that teardown frequently NEEDS the very capability being withdrawn — closing a
//      connection pool means handing connections back to whatever provided them. Remove
//      the binding first and the teardown reaches for something already gone. This is
//      the orphaned-monitor / dangling-observer bug class, structurally.

const STATE = Object.freeze({ INACTIVE: 'inactive', ACTIVE: 'active' });

let nextId = 0;

/**
 * @param onEvent optional hook — `{ event, name, key }`. Kept deliberately independent
 *        of the event schema so the registry has no dependency on the log; the caller
 *        maps these to `capability.activated` / `capability.revoked`.
 */
export function createRegistry({ onEvent = null } = {}) {
  const bindings = new Map();      // key -> { value, providerId }
  const components = new Map();    // id  -> record
  let settling = false;
  let disposed = false;

  const emit = (event, detail) => { if (onEvent) onEvent({ event, ...detail }); };

  function scopeFor(record) {
    return {
      /** Register a revertible effect. The returned disposer runs on deactivation, LIFO. */
      effect(fn) {
        const dispose = fn();
        if (typeof dispose === 'function') record.disposers.push(dispose);
        return () => {
          const i = record.disposers.indexOf(dispose);
          if (i >= 0) { record.disposers.splice(i, 1); dispose(); }
        };
      },

      /** Provide a capability. This is itself an effect, so it unwinds with the component. */
      provide(key, value) {
        if (bindings.has(key)) throw new Error(`registry: '${key}' is already provided`);
        bindings.set(key, { value, providerId: record.id });
        record.provided.add(key);
        emit('provided', { key, name: record.name });
        record.disposers.push(() => withdrawSync(key));
        queueSettle();
      },

      /** Read a required capability. */
      get(key) {
        const b = bindings.get(key);
        return b ? b.value : undefined;
      },

      /** A nested component. Disposes with its parent, because that is an effect too. */
      register(child) {
        const handle = register(child);
        record.disposers.push(() => handle.dispose());
        return handle;
      },

      get name() { return record.name; },
    };
  }

  function satisfied(record) {
    return record.requires.every((k) => bindings.has(k));
  }

  function activate(record) {
    record.state = STATE.ACTIVE;
    try {
      record.apply(scopeFor(record));
    } catch (err) {
      // A failure is recorded on the component and never propagated to its siblings —
      // one broken component must not take the system down. Whatever it managed to
      // register still unwinds.
      record.state = STATE.INACTIVE;
      record.error = err;
      runDisposers(record);
      emit('failed', { name: record.name, error: err });
      return;
    }
    emit('activated', { name: record.name });
  }

  function runDisposers(record) {
    const results = [];
    // LIFO — rule 1.
    while (record.disposers.length > 0) {
      const dispose = record.disposers.pop();
      try { results.push(dispose()); } catch { /* one bad disposer must not strand the rest */ }
    }
    record.provided.clear();
    return results.filter((r) => r && typeof r.then === 'function');
  }

  function deactivate(record) {
    if (record.state !== STATE.ACTIVE) return [];
    record.state = STATE.INACTIVE;
    const pending = runDisposers(record);
    emit('deactivated', { name: record.name });
    return pending;
  }

  /**
   * Rule 2: every ACTIVE dependent stands down BEFORE the binding disappears, so its
   * teardown can still read the capability it is being torn down over.
   */
  function withdrawSync(key) {
    const binding = bindings.get(key);
    if (!binding) return;
    for (const record of components.values()) {
      if (record.state === STATE.ACTIVE && record.requires.includes(key)) deactivate(record);
    }
    bindings.delete(key);
    emit('withdrawn', { key });
    queueSettle();
  }

  /** Fixpoint: activating one component can satisfy another, and so on. */
  function settle() {
    if (settling || disposed) return;
    settling = true;
    try {
      for (let pass = 0; pass < 64; pass++) {
        let moved = false;
        for (const record of components.values()) {
          if (record.error) continue;                       // failed stays failed
          const ok = satisfied(record);
          if (ok && record.state === STATE.INACTIVE) { activate(record); moved = true; }
          else if (!ok && record.state === STATE.ACTIVE) { deactivate(record); moved = true; }
        }
        if (!moved) return;
      }
      throw new Error('registry: settle did not converge in 64 passes');
    } finally {
      settling = false;
    }
  }

  function queueSettle() { if (!settling) settle(); }

  function register({ name, requires = [], apply }) {
    if (typeof apply !== 'function') throw new TypeError('registry: component.apply required');
    const record = {
      id: `c${nextId++}`, name: name || 'anonymous', requires: [...requires], apply,
      state: STATE.INACTIVE, disposers: [], provided: new Set(), error: null,
    };
    components.set(record.id, record);
    queueSettle();
    return {
      get name() { return record.name; },
      get state() { return record.state; },
      get error() { return record.error; },
      async dispose() {
        const pending = deactivate(record);
        components.delete(record.id);
        await Promise.all(pending);
        queueSettle();
      },
    };
  }

  return {
    register,

    /** Provide from outside any component — the root of the graph. */
    provide(key, value) {
      if (bindings.has(key)) throw new Error(`registry: '${key}' is already provided`);
      bindings.set(key, { value, providerId: null });
      emit('provided', { key });
      queueSettle();
      return () => withdrawSync(key);
    },

    get: (key) => (bindings.has(key) ? bindings.get(key).value : undefined),
    has: (key) => bindings.has(key),
    keys: () => [...bindings.keys()].sort(),

    /**
     * What is waiting, and on what. A dependency cycle simply leaves its components
     * permanently inactive — unlike a deadlock that depends on the schedule, this is
     * visible from the declarations alone, so a host can report it at load time.
     */
    pending() {
      return [...components.values()]
        .filter((r) => r.state === STATE.INACTIVE && !r.error)
        .map((r) => ({ name: r.name, waitingFor: r.requires.filter((k) => !bindings.has(k)) }));
    },

    active: () => [...components.values()].filter((r) => r.state === STATE.ACTIVE).map((r) => r.name).sort(),

    async dispose() {
      disposed = true;
      // Reverse registration order — the whole registry is itself one LIFO stack.
      const all = [...components.values()].reverse();
      const pending = all.flatMap((r) => deactivate(r));
      components.clear();
      bindings.clear();
      await Promise.all(pending);
    },
  };
}

export const REGISTRY_STATES = STATE;
