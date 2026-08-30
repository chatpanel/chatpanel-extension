// GENERATED — do not edit.
// Source of truth: chatpanel-events/skill-sources.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// skill-sources.js — where skills can come from, as a contract instead of a panel.
//
// The instinct when adding "browse a skills hub" is to build the panel the MCP registry
// bar was built as: one file that knows one API. That is how `history-rag.js` came to
// hand-write three loaders, and how adding a fourth meant editing four files. The places
// skills come from are already several — a local bridge, skills.sh, GitHub taps, a site
// publishing /.well-known/skills, and whatever appears next — and they differ only in how
// three functions are implemented.
//
// So a source is a registration. Register one and browsing, searching and installing gain
// it at once, because each consumes the registry rather than a list.
//
// A SOURCE IS A CAPABILITY. `reads` is the declared access statement (P10) and `trust` is
// the level everything it produces inherits — a source cannot promote its own skills, and
// nothing fetched is ever `built-in`.
//
// ISOLATION IS THE POINT. One hub being down, slow, or returning garbage must cost that
// hub's section of the results and nothing else. A registry whose failure mode is "no
// skills anywhere" would be worse than the hardcoded list it replaced.
//
// WHAT IS SHARED IS THE CONTRACT, NOT THE SOURCE. Searching is pure orchestration and
// lives here; the fetch a real source performs needs a platform — the extension's
// `secureFetch`, the bridge's Node http, a mobile client's own stack — and is injected at
// registration, the same split `adapters.js` makes for execution.

import { DATA_SCOPES } from './scopes.js';

export class SkillSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillSourceError'; this.code = code; }
}

/**
 * Trust a source confers on everything it produces. There is no `built-in` here on
 * purpose: only skills compiled into the product are ours, and no registration can claim
 * that. `local` is a source on this machine (the bridge's store); `community` is anything
 * off the network.
 */
export const SOURCE_TRUST = Object.freeze(['local', 'community']);

/**
 * Declare a source.
 *
 * @param id       stable id; also the `origin.source` stamped on everything it yields
 * @param label    human name, for the picker and for provenance
 * @param trust    'local' | 'community' — inherited, never self-assigned per skill
 * @param reads    declared access, e.g. ['net'] for a hub, [] for the local bridge
 * @param list     ({ query, cursor }) -> { items, nextCursor? }. `items` are RECORDS
 *                 (name + description + files), never bodies — level 0 of the ladder
 * @param read     (id) -> a full record including its prompt. Level 1
 * @param readFile (id, path) -> { path, text }. Level 2, optional: a source with no
 *                 packages simply omits it
 * @param available () -> boolean|Promise<boolean>. A source that cannot answer right now
 *                 (bridge down, no network) is ABSENT rather than broken — the difference
 *                 between "nothing here" and an error the user must interpret
 */
export function defineSkillSource({
  id, label, trust = 'community', reads = [], list, read, readFile = null, available = null,
}) {
  if (!id || typeof id !== 'string') throw new SkillSourceError('BAD_SOURCE', 'source.id required');
  if (!SOURCE_TRUST.includes(trust)) {
    throw new SkillSourceError('BAD_SOURCE', `source '${id}': trust must be one of ${SOURCE_TRUST}`);
  }
  if (!Array.isArray(reads) || !reads.every((r) => DATA_SCOPES.includes(r))) {
    throw new SkillSourceError('BAD_SOURCE', `source '${id}': reads must be within ${DATA_SCOPES}`);
  }
  if (typeof list !== 'function') throw new SkillSourceError('BAD_SOURCE', `source '${id}': list() required`);
  if (typeof read !== 'function') throw new SkillSourceError('BAD_SOURCE', `source '${id}': read() required`);
  return Object.freeze({
    id,
    label: label || id,
    trust,
    reads: Object.freeze([...reads]),
    list,
    read,
    readFile: typeof readFile === 'function' ? readFile : null,
    available: typeof available === 'function' ? available : () => true,
  });
}

/** The registry a host binds sources into. Insertion-ordered, so results are stable. */
export function createSkillSourceRegistry() {
  const sources = new Map();
  return {
    /** Register a source. Returns its remover, so registration is revertible (P15). */
    add(source) {
      if (sources.has(source.id)) throw new SkillSourceError('DUPLICATE', `source '${source.id}' already registered`);
      sources.set(source.id, source);
      return () => sources.delete(source.id);
    },

    list() { return [...sources.values()]; },
    get(id) { return sources.get(id) || null; },
    has(id) { return sources.has(id); },

    /**
     * Ask every available source at once.
     *
     * Returns one section PER SOURCE rather than a merged list: a merged list would have
     * to rank across hubs that share no scoring, and it would hide which source an entry
     * came from at exactly the moment that matters. A source that throws yields an
     * `error` section and never rejects the call.
     */
    async search({ query = '', cursor = '', only = null } = {}) {
      const wanted = [...sources.values()].filter((s) => !only || only.includes(s.id));
      return Promise.all(wanted.map(async (source) => {
        try {
          if (!(await source.available())) return { source: source.id, label: source.label, items: [], absent: true };
          const page = (await source.list({ query, cursor })) || {};
          const items = Array.isArray(page.items) ? page.items : [];
          return {
            source: source.id,
            label: source.label,
            trust: source.trust,
            // Provenance is stamped HERE, from the registration — a source that could
            // label its own results could label them as something more trusted.
            items: items.map((skill) => stampOrigin(skill, source)),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        } catch (e) {
          return { source: source.id, label: source.label, items: [], error: String(e?.message || e) };
        }
      }));
    },

    /** One skill, body included, with provenance stamped the same way. */
    async read(sourceId, skillId) {
      const source = sources.get(sourceId);
      if (!source) throw new SkillSourceError('UNKNOWN_SOURCE', `no source '${sourceId}'`);
      const skill = await source.read(skillId);
      return skill ? stampOrigin(skill, source) : null;
    },

    async readFile(sourceId, skillId, path) {
      const source = sources.get(sourceId);
      if (!source) throw new SkillSourceError('UNKNOWN_SOURCE', `no source '${sourceId}'`);
      if (!source.readFile) throw new SkillSourceError('NO_FILES', `source '${sourceId}' has no package files`);
      return source.readFile(skillId, path);
    },
  };
}

/**
 * Stamp where a record came from, overriding whatever it claimed.
 *
 * A skill arriving from a source does not get to say which source it came from, or that
 * it is ours: `builtin` is cleared here, and `trustOf()` then derives `community` from the
 * presence of an origin. The record's own `origin.hash` survives — that is the content
 * identity the scanner and the update check compare against, and only the fetcher knows it.
 */
function stampOrigin(skill, source) {
  if (!skill || typeof skill !== 'object') return skill;
  const claimed = skill.origin && typeof skill.origin === 'object' ? skill.origin : {};
  return {
    ...skill,
    builtin: false,
    origin: {
      ...claimed,
      source: source.id,
      id: String(claimed.id || skill.id || ''),
    },
  };
}
