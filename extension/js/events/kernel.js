// GENERATED — do not edit.
// Source of truth: chatpanel-events/kernel.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The plugin kernel — the part that cannot itself be a plugin.
//
// Everything in ChatPanel is a plugin: the loop, tools, skills, storage, renderers, UI
// slots, sources, model providers, presets, redaction POLICY. This file is what makes
// that safe to say.
//
// "Security is a mandatory plugin" is only meaningful if something that is NOT a plugin
// enforces the mandate — otherwise mandatory is a config value, and a config value is
// disableable. So the kernel SHRINKS rather than grows. It does three things, none of
// them extensible, and deliberately nothing else:
//
//   1. load plugins (delegated to the registry — revertible effects, reactive availability);
//   2. refuse to run when a required plugin is absent or failed;
//   3. enforce guard monotonicity — a guard may reduce permission, never widen it.
//
// POLICY VS MECHANISM. Redaction policy (what counts as sensitive, which dial the user
// picked, whether an org gets visibility) is a plugin. The redaction mechanism and the
// egress guard are not. That is what lets privacy be a real on/off dial without ever
// creating a path where bytes leave unguarded: security is not a dial, privacy is.
//
// NO DEPENDENCY ON THE EVENT LOG, matching registry.js — `onEvent` is a plain hook the
// host maps to schema events if it wants them. That keeps the kernel runnable in the
// extension, the gateway and the bridge unchanged.

import { createRegistry } from './registry.js';

export class KernelError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.detail = detail;
  }
}

/** The default non-negotiables. A host may require more; it may not require fewer. */
export const REQUIRED_PLUGINS = Object.freeze(['security']);

/**
 * A decision is a permission, not a boolean: `allow` plus the scopes it covers.
 * Kept deliberately small — anything richer invites a lattice we cannot check.
 */
export const ALLOW_ALL = Object.freeze({ allow: true, scopes: null, reasons: [] });

const asScopeSet = (s) => (s == null ? null : new Set(s));

/**
 * The MEET of two decisions — the heart of the monotonicity guarantee.
 *
 * A guard cannot widen because widening is never constructed, not because we inspect the
 * result and complain. Detect-and-reject would leave a window in which the widened value
 * existed and could be read by whatever ran next; a meet has no such window.
 *
 * `scopes: null` means "unscoped / all", so it is the top of the lattice and intersecting
 * with it is identity — that keeps a guard that does not care about scopes from
 * accidentally narrowing to nothing.
 */
export function meetDecisions(a, b) {
  const as = asScopeSet(a.scopes);
  const bs = asScopeSet(b.scopes);
  let scopes = null;
  if (as && bs) scopes = [...as].filter((s) => bs.has(s));
  else if (as) scopes = [...as];
  else if (bs) scopes = [...bs];
  return {
    allow: !!a.allow && !!b.allow,
    scopes,
    reasons: [...(a.reasons || []), ...(b.reasons || [])],
  };
}

/** True when `out` asked for more than `input` allowed — a misbehaving or hostile plugin. */
function widened(input, out) {
  if (!input.allow && out.allow) return true;
  const is = asScopeSet(input.scopes);
  const os = asScopeSet(out.scopes);
  if (!is) return false;              // input was unscoped: nothing to widen past
  if (!os) return true;               // guard tried to drop scoping entirely
  return [...os].some((s) => !is.has(s));
}

/**
 * @param required plugin ids that must be active before `start()` resolves. Callers may
 *        add to REQUIRED_PLUGINS; they cannot remove from it.
 * @param onEvent `{ event, ...detail }` — 'plugin:activated' | 'plugin:failed' |
 *        'guard:widened' | 'started' | 'stopped'.
 */
export function createKernel({ required = [], onEvent = null } = {}) {
  const requiredIds = [...new Set([...REQUIRED_PLUGINS, ...required])];
  const registry = createRegistry({
    onEvent: (d) => emit(`registry:${d.event}`, d),
  });

  const declared = new Map();   // id -> declaration
  const handles = new Map();    // id -> registry handle
  const guards = new Map();     // name -> [{ pluginId, fn }]
  let started = false;

  const emit = (event, detail = {}) => { if (onEvent) onEvent({ event, ...detail }); };

  /**
   * Declare a plugin. Declaration is NOT activation: manifests are static so the kernel
   * can answer "what is installed" without executing anything, and `activate` is where a
   * host does its `await import()`. A kernel that had to load every plugin to know what
   * it had would put the whole graph on first paint, and first paint is a release gate.
   */
  function define(plugin) {
    const { id, requires = [], activate, load } = plugin || {};
    if (!id || typeof id !== 'string') throw new KernelError('BAD_PLUGIN', 'plugin.id required');
    if (typeof activate !== 'function' && typeof load !== 'function') {
      throw new KernelError('BAD_PLUGIN', `plugin '${id}': activate or load required`);
    }
    if (declared.has(id)) throw new KernelError('DUPLICATE', `plugin '${id}' is already defined`);
    declared.set(id, { ...plugin, requires: [...requires] });
    return () => remove(id);
  }

  function remove(id) {
    if (requiredIds.includes(id)) {
      // Not a permission check that could be satisfied — there is no argument that makes
      // removing the security plugin acceptable, so it is not expressible.
      throw new KernelError('REQUIRED', `plugin '${id}' is required and cannot be removed`);
    }
    declared.delete(id);
    const h = handles.get(id);
    handles.delete(id);
    for (const [name, list] of guards) {
      const kept = list.filter((g) => g.pluginId !== id);
      if (kept.length) guards.set(name, kept); else guards.delete(name);
    }
    return h ? h.dispose() : Promise.resolve();
  }

  /** The scope a plugin's `activate` receives — the registry's, plus guard registration. */
  function scopeFor(id, inner) {
    return {
      ...inner,
      /**
       * Register a guard. It receives `(request, decision)` and returns a decision; the
       * kernel meets its answer with what came in, so it can only ever narrow.
       */
      guard(name, fn) {
        if (typeof fn !== 'function') throw new KernelError('BAD_GUARD', `guard '${name}' must be a function`);
        const list = guards.get(name) || [];
        list.push({ pluginId: id, fn });
        guards.set(name, list);
        return () => {
          const cur = (guards.get(name) || []).filter((g) => g.fn !== fn);
          if (cur.length) guards.set(name, cur); else guards.delete(name);
        };
      },
    };
  }

  /**
   * Run every guard for `name` and return the narrowest decision any of them permits.
   * Order-independent by construction: meet is associative and commutative, so guards
   * cannot race each other into a different answer — which is what lets them be plugins.
   */
  function decide(name, request, initial = ALLOW_ALL) {
    let decision = { allow: !!initial.allow, scopes: initial.scopes ?? null, reasons: [...(initial.reasons || [])] };
    for (const { pluginId, fn } of guards.get(name) || []) {
      let out;
      try {
        out = fn(request, decision);
      } catch (err) {
        // A guard that throws is a guard that did not permit. Fail closed: the
        // alternative is that crashing a guard becomes a way to bypass it.
        decision = meetDecisions(decision, { allow: false, scopes: null, reasons: [`${pluginId}: guard threw (${err.message})`] });
        continue;
      }
      if (out == null) continue;                       // abstained
      if (out === true) continue;                      // permitted, unchanged
      if (out === false) out = { allow: false, scopes: null, reasons: [`${pluginId}: denied`] };
      const norm = { allow: out.allow !== false, scopes: out.scopes ?? null, reasons: out.reasons || [] };
      if (widened(decision, norm)) emit('guard:widened', { guard: name, pluginId });
      decision = meetDecisions(decision, norm);
    }
    return decision;
  }

  /**
   * Activate everything declared, then verify the required set is genuinely ACTIVE —
   * not merely declared. A required plugin that failed to activate is the same problem
   * as one that was never installed, and the kernel must not be the component that
   * papers over the difference.
   */
  async function start() {
    if (started) return kernel;
    const missing = requiredIds.filter((id) => !declared.has(id));
    if (missing.length) {
      throw new KernelError('MISSING_REQUIRED', `kernel will not start: required plugin(s) not defined: ${missing.join(', ')}`, missing);
    }
    // Required plugins first, so a dependent that reaches for security during its own
    // activation finds it — the same ordering rule the registry applies to teardown.
    const ordered = [...declared.values()].sort(
      (a, b) => (requiredIds.includes(b.id) ? 1 : 0) - (requiredIds.includes(a.id) ? 1 : 0),
    );
    // Resolve `load` BEFORE registering. Registry activation is synchronous — an effect
    // registered after activation returned would not be in the disposer stack, so the
    // inverse would not run. Awaiting the import here is what keeps a manifest static
    // (the kernel knows what is installed without executing it) while the module itself
    // still only costs anything when it activates.
    for (const p of ordered) {
      if (handles.has(p.id)) continue;
      let activate = p.activate;
      if (!activate) {
        try {
          const mod = await p.load();
          activate = mod?.activate || mod?.default;
        } catch (err) {
          throw new KernelError('LOAD_FAILED', `plugin '${p.id}' failed to load: ${err.message}`, p.id);
        }
        if (typeof activate !== 'function') {
          throw new KernelError('BAD_PLUGIN', `plugin '${p.id}': loaded module exports no activate`, p.id);
        }
      }
      handles.set(p.id, registry.register({
        name: p.id,
        requires: p.requires,
        apply: (inner) => activate(scopeFor(p.id, inner)),
      }));
    }
    const notActive = requiredIds.filter((id) => handles.get(id)?.state !== 'active');
    if (notActive.length) {
      const detail = notActive.map((id) => ({ id, error: handles.get(id)?.error?.message || 'inactive', waitingFor: registry.pending().find((p) => p.name === id)?.waitingFor || [] }));
      await registry.dispose();
      throw new KernelError('REQUIRED_INACTIVE', `kernel will not start: required plugin(s) not active: ${notActive.join(', ')}`, detail);
    }
    started = true;
    emit('started', { plugins: registry.active() });
    return kernel;
  }

  const kernel = {
    define,
    remove,
    decide,
    start,
    get started() { return started; },
    /** What is installed, whether or not it activated — a manifest question. */
    list: () => [...declared.keys()].sort(),
    active: () => registry.active(),
    pending: () => registry.pending(),
    required: () => [...requiredIds],
    guards: () => [...guards.keys()].sort(),
    registry,
    async stop() {
      started = false;
      await registry.dispose();
      emit('stopped', {});
    },
  };
  return kernel;
}
