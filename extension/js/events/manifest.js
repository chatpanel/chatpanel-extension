// GENERATED — do not edit.
// Source of truth: chatpanel-events/manifest.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What is installed, and what the user has switched off.
//
// Four registries now exist — adapters, tool groups, search engines, sources — and each is
// small and correct on its own. What none of them can answer is the question a user asks:
// "what is running, and can I turn that off?" Answering it in four places would be the
// duplication that already bit us with the engine list, one level up.
//
// So the KERNEL owns the manifest and the registries consult it. This is admission control,
// not a rewrite: a registry keeps its own shape and simply refuses to offer something the
// user has disabled. It is also the seam that makes user-contributed plugins possible —
// once a plugin can arrive from outside, "is this allowed to run" must be asked somewhere
// that is not the plugin itself.
//
// Persistence is INJECTED. Where the toggles live is a platform question (chrome.storage,
// a file, a database) and the manifest has no business knowing.

export class ManifestError extends Error {
  constructor(code, message) { super(message); this.name = 'ManifestError'; this.code = code; }
}

/** Where a plugin came from. `user` is the one that must never skip a guard. */
export const SOURCES = Object.freeze(['built-in', 'user']);

/**
 * @param required ids that cannot be disabled, whatever the stored state says. Security is
 *        the canonical member: a mandatory plugin the user can switch off is not mandatory,
 *        it is a default.
 * @param disabled the user's stored choices — ids they have turned OFF. Stored as the
 *        exception rather than the full state on purpose: a plugin added in a later release
 *        is then enabled by default without a migration, because absence means "not
 *        disabled" rather than "unknown".
 */
export function createManifest({ required = ['security'], disabled = [], onChange = null } = {}) {
  const entries = new Map();
  const off = new Set(disabled);
  const req = new Set(required);

  const notify = () => { if (onChange) onChange([...off].sort()); };

  return {
    /**
     * Declare something installed. Idempotent, so a registry can register on every build
     * without accumulating duplicates.
     */
    register({ id, kind, label, source = 'built-in', description = '' }) {
      if (!id) throw new ManifestError('BAD_ENTRY', 'plugin id required');
      if (!SOURCES.includes(source)) throw new ManifestError('BAD_ENTRY', `plugin '${id}': unknown source '${source}'`);
      entries.set(id, { id, kind: kind || 'plugin', label: label || id, source, description });
      return () => entries.delete(id);
    },

    /**
     * The question every registry asks. Unknown ids are ENABLED: a registry may consult the
     * manifest before anything has registered, and defaulting to off would make a plugin
     * silently vanish because of a load-order accident.
     */
    isEnabled(id) {
      if (req.has(id)) return true;
      return !off.has(id);
    },

    /** Turn something on or off. Required plugins refuse rather than reporting success. */
    setEnabled(id, enabled) {
      if (req.has(id) && !enabled) {
        throw new ManifestError('REQUIRED', `'${id}' is required and cannot be disabled`);
      }
      const was = !off.has(id);
      if (enabled) off.delete(id); else off.add(id);
      if (was !== !!enabled) notify();
      return this.isEnabled(id);
    },

    /** Everything installed, with its current state — what a settings page renders. */
    list() {
      return [...entries.values()]
        .map((e) => ({ ...e, enabled: this.isEnabled(e.id), required: req.has(e.id) }))
        .sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind.localeCompare(b.kind)));
    },

    /** Only the ids that are OFF — the shape that persists (see the note above). */
    disabledIds: () => [...off].sort(),

    /** Filter a registry's candidates. The one call a registry needs to make. */
    filter(items, idOf = (x) => x?.id) {
      return (items || []).filter((x) => this.isEnabled(idOf(x)));
    },
  };
}
