// GENERATED — do not edit.
// Source of truth: chatpanel-events/skill-manifest.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// skill-manifest.js — what a skill IS, for every client that stores or runs one.
//
// A skill was a settings record: a prompt plus a few dropdowns, normalized by whichever
// client happened to save it. That was survivable while every skill was hand-written by
// the person running it. It stops being survivable the moment a skill can ARRIVE from
// somewhere — a hub, a repo, another agent's skill directory — because the questions
// change from "what does this prompt say" to "where did it come from, what may it reach,
// and has anything checked it".
//
// So this module owns the record. Not the storage (a platform question), not the UI (a
// platform question), not the fetching (F6 S3) — the shape, its evolution, and the two
// derivations no client may compute for itself:
//
//   • TRUST IS DERIVED, NEVER DECLARED. A skill cannot say it is trusted. `trustOf()`
//     reads provenance: shipped by us -> 'built-in', fetched -> 'community', neither ->
//     'user'. A stored `trust` field is stripped on normalize, and `builtin` is forced
//     false whenever an origin is present — otherwise "trusted" would be a string an
//     importer sets.
//   • DECLARED ACCESS IS COMPUTED FROM THE RECORD. Everything a skill can reach is
//     readable before it runs, which is what makes load-time approval possible (P10).
//     If a reviewer's summary were assembled by the install screen, the install screen
//     would be the security boundary.
//
// Versioning follows the log's discipline: additive only, absence means the previous
// default, and the upcast chain exists from the start so adding v3 does not mean
// rewriting every reader.

import { DATA_SCOPES } from './scopes.js';

export class SkillManifestError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillManifestError'; this.code = code; }
}

/** Schema version of the RECORD. Distinct from `version`, which is the author's semver. */
export const SKILL_MANIFEST_VERSION = 2;

export const SKILL_CONTEXTS = Object.freeze(['auto', 'page', 'selection', 'tabs', 'none']);
export const SKILL_HISTORY_SCOPES = Object.freeze(['none', 'chats', 'meetings', 'all']);
export const SKILL_MCP_MODES = Object.freeze(['none', 'selected', 'default']);

/**
 * Derived, never stored. 'community' is deliberately the level for a skill fetched from
 * a vendor repo with a famous name — only what we ship went through our review.
 */
export const SKILL_TRUST = Object.freeze(['built-in', 'user', 'community']);

/**
 * The directories a package may carry, matching the agentskills.io layout. `scripts` is
 * the tier-3 one: it cannot run in a browser extension and must not be offered as if it
 * could (see `needsBridge`).
 */
export const SKILL_FILE_KINDS = Object.freeze(['references', 'scripts', 'assets', 'templates', 'examples']);

const str = (v) => typeof v === 'string' && v.length > 0;

// A slash command is typed by a human and matched case-insensitively against a stored
// string; anything outside this grammar either cannot be typed or collides with the
// leading-slash parse.
const COMMAND = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A file path inside a package directory.
 *
 * The check is a security boundary, not tidiness: these strings become filesystem paths
 * in the bridge's skill store, and a package is authored by a stranger. Rejected are
 * absolute paths, any `..` segment, backslashes (a Windows separator that a POSIX
 * `split('/')` would not see as one), leading/trailing whitespace and control characters.
 * Allowing one of them is a directory-traversal write on someone's machine.
 */
export function isSafeSkillPath(p) {
  if (!str(p) || p.length > 255) return false;
  if (p !== p.trim()) return false;
  if (p.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return true;
}

/** Did this skill come from somewhere, or did the user write it? */
export function originOf(skill) {
  const o = skill?.origin;
  return o && typeof o === 'object' && str(o.source) && str(o.id) ? o : null;
}

/**
 * Derived from provenance, never read from the record. A skill that arrived from outside
 * is 'community' whoever published it; 'built-in' means we shipped it.
 */
export function trustOf(skill) {
  if (originOf(skill)) return 'community';
  return skill?.builtin ? 'built-in' : 'user';
}

/** The files a package carries, per directory, already filtered to safe paths. */
export function skillFiles(skill) {
  const files = skill?.files;
  const out = {};
  if (!files || typeof files !== 'object') return out;
  for (const kind of SKILL_FILE_KINDS) {
    const list = Array.isArray(files[kind]) ? files[kind].filter(isSafeSkillPath) : [];
    if (list.length) out[kind] = [...new Set(list)];
  }
  return out;
}

/**
 * True when running this skill fully needs a host that can execute code — i.e. the
 * bridge. The extension may still store, show and run the PROMPT half; what it may not
 * do is pretend the scripts ran.
 */
export function needsBridge(skill) {
  return (skillFiles(skill).scripts || []).length > 0;
}

/**
 * Everything this skill can reach, computed from the record. This is what an install
 * review, the Plugins lens and an admin export all read — one derivation, so the three
 * cannot disagree about what was approved.
 */
export function declaredAccess(skill = {}) {
  const files = skillFiles(skill);
  const mcpMode = SKILL_MCP_MODES.includes(skill.mcpMode) ? skill.mcpMode : 'none';
  const context = SKILL_CONTEXTS.includes(skill.context) ? skill.context : 'auto';
  const history = SKILL_HISTORY_SCOPES.includes(skill.historyContext) ? skill.historyContext : 'none';
  const reads = new Set(Array.isArray(skill.reads) ? skill.reads.filter((r) => DATA_SCOPES.includes(r)) : []);
  // The dropdowns ARE access statements; a record that declared `reads` separately from
  // them could claim less than it takes.
  if (context !== 'none') reads.add('page');
  if (history === 'chats' || history === 'all') reads.add('chats');
  if (history === 'meetings' || history === 'all') reads.add('meetings');
  return {
    trust: trustOf(skill),
    reads: [...reads].sort(),
    page: context,
    history,
    mcp: mcpMode,
    mcpServerIds: mcpMode === 'selected' && Array.isArray(skill.mcpServerIds) ? [...skill.mcpServerIds] : [],
    sources: Array.isArray(skill.sources) ? [...new Set(skill.sources.filter(str))].sort() : [],
    surfaces: Array.isArray(skill.surfaces) ? [...new Set(skill.surfaces.filter(str))].sort() : [],
    scripts: files.scripts || [],
    needsBridge: needsBridge(skill),
    meeting: !!skill.meeting,
  };
}

/** Human label for where a skill came from, for the surfaces that must show provenance. */
export function originLabel(skill) {
  const o = originOf(skill);
  if (!o) return trustOf(skill) === 'built-in' ? 'Built-in' : 'Written here';
  return o.id.length > 48 ? `${o.source} · …${o.id.slice(-40)}` : `${o.source} · ${o.id}`;
}

/** Two records describing the same upstream skill — for update checks and dedupe. */
export function sameSkillOrigin(a, b) {
  const x = originOf(a);
  const y = originOf(b);
  return !!x && !!y && x.source === y.source && x.id === y.id;
}

/**
 * Has upstream changed since this was installed? `null` when unanswerable (no origin, or
 * nothing was hashed) — which callers must treat as "do not claim it is current" rather
 * than as "up to date".
 */
export function skillIsStale(skill, upstreamHash) {
  const o = originOf(skill);
  if (!o || !str(o.hash) || !str(upstreamHash)) return null;
  return o.hash !== upstreamHash;
}

/**
 * Validate a skill DECLARATION — the static surface approved before anything runs.
 * Throws on the first problem, like `validateCapability`.
 */
export function validateSkill(skill) {
  if (!skill || typeof skill !== 'object') throw new SkillManifestError('SHAPE', 'skill must be an object');
  if (!str(skill.id)) throw new SkillManifestError('SHAPE', 'skill.id required');
  if (!str(skill.name)) throw new SkillManifestError('SHAPE', `skill '${skill.id}': name required`);
  if (skill.prompt != null && typeof skill.prompt !== 'string') {
    throw new SkillManifestError('SHAPE', `skill '${skill.id}': prompt must be a string`);
  }
  if (skill.command != null && skill.command !== '' && !COMMAND.test(String(skill.command))) {
    throw new SkillManifestError('SHAPE', `skill '${skill.id}': command must match ${COMMAND}`);
  }
  for (const [field, allowed] of [
    ['context', SKILL_CONTEXTS], ['historyContext', SKILL_HISTORY_SCOPES], ['mcpMode', SKILL_MCP_MODES],
  ]) {
    if (skill[field] != null && !allowed.includes(skill[field])) {
      throw new SkillManifestError('SHAPE', `skill '${skill.id}': ${field} must be one of ${allowed}`);
    }
  }
  if (skill.reads != null) {
    if (!Array.isArray(skill.reads) || !skill.reads.every((r) => DATA_SCOPES.includes(r))) {
      throw new SkillManifestError('SHAPE', `skill '${skill.id}': reads must be within ${DATA_SCOPES}`);
    }
  }
  for (const field of ['sources', 'surfaces']) {
    if (skill[field] != null && (!Array.isArray(skill[field]) || !skill[field].every(str))) {
      throw new SkillManifestError('SHAPE', `skill '${skill.id}': ${field} must be an array of ids`);
    }
  }
  if (skill.origin != null) {
    const o = skill.origin;
    if (typeof o !== 'object') throw new SkillManifestError('SHAPE', `skill '${skill.id}': origin must be an object`);
    // Without a source and an id it cannot be re-fetched or compared, which is the whole
    // reason the field exists; a half-origin is worse than none because it looks answered.
    if (!str(o.source) || !str(o.id)) {
      throw new SkillManifestError('ORIGIN', `skill '${skill.id}': origin needs both source and id`);
    }
  }
  if (skill.files != null) {
    if (typeof skill.files !== 'object') throw new SkillManifestError('SHAPE', `skill '${skill.id}': files must be an object`);
    for (const kind of Object.keys(skill.files)) {
      if (!SKILL_FILE_KINDS.includes(kind)) {
        throw new SkillManifestError('FILES', `skill '${skill.id}': unknown file kind '${kind}'`);
      }
      const list = skill.files[kind];
      if (!Array.isArray(list) || !list.every(str)) {
        throw new SkillManifestError('FILES', `skill '${skill.id}': files.${kind} must be an array of paths`);
      }
      const bad = list.find((p) => !isSafeSkillPath(p));
      if (bad) throw new SkillManifestError('PATH', `skill '${skill.id}': unsafe path in files.${kind}: ${JSON.stringify(bad)}`);
    }
  }
  // Files without an origin means someone hand-wrote a package record; that is allowed,
  // but scripts without an origin cannot be scanned against anything, and an unscannable
  // script is exactly what the admission gate exists to refuse.
  if (!originOf(skill) && (skill.files?.scripts || []).length) {
    throw new SkillManifestError('ORIGIN', `skill '${skill.id}': scripts require an origin to be scannable`);
  }
  return skill;
}

/**
 * v(n) -> v(n+1). Each MUST be total: it may not throw for any record of its version.
 *
 * v1 -> v2 stamps the version and nothing else, on purpose. Every field F6 adds is
 * absence-means-the-old-default, so there is nothing to fill in — the same discipline as
 * storing which plugins are DISABLED rather than the full state, so a field added later
 * needs no migration.
 */
export const SKILL_UPCASTERS = Object.freeze({
  1: (s) => ({ ...s, v: SKILL_MANIFEST_VERSION }),
});

/** Carry a stored skill forward to the current schema. Pure; never mutates the input. */
export function upcastSkill(stored) {
  if (!stored || typeof stored !== 'object') throw new SkillManifestError('SHAPE', 'skill must be an object');
  // A record written before the version existed is v1 by definition.
  let s = typeof stored.v === 'number' ? stored : { ...stored, v: 1 };
  let guard = 0;
  while (s.v < SKILL_MANIFEST_VERSION) {
    const step = SKILL_UPCASTERS[s.v];
    if (!step) throw new SkillManifestError('UPCAST', `no upcaster from v${s.v}`);
    s = step(s);
    if (++guard > 64) throw new SkillManifestError('UPCAST', 'upcaster chain did not terminate');
  }
  if (s.v > SKILL_MANIFEST_VERSION) {
    throw new SkillManifestError('UPCAST', `skill is v${s.v}; this reader only knows v${SKILL_MANIFEST_VERSION}`);
  }
  return s;
}

export function upcastSkills(stored) {
  return (Array.isArray(stored) ? stored : []).map(upcastSkill);
}

/**
 * Coerce a record into the canonical shape a writer stores. Total and forgiving — this
 * runs on save, where throwing would cost a user their edit; `validateSkill` is the
 * strict gate, used where a record ARRIVES.
 *
 * The security-relevant coercions are the ones that cannot be left to a caller:
 * `trust` is never persisted, `builtin` cannot survive an origin, and an unsafe file
 * path is dropped rather than stored and rejected later.
 */
export function normalizeSkill(skill) {
  if (!skill || typeof skill !== 'object') return skill;
  const out = { ...upcastSkill(skill) };

  // Skills predate the enabled flag — absence means enabled.
  out.enabled = out.enabled !== false;

  const mode = String(out.mcpMode || 'none').toLowerCase();
  out.mcpMode = SKILL_MCP_MODES.includes(mode) ? mode : 'none';
  const ids = Array.isArray(out.mcpServerIds) ? out.mcpServerIds : [];
  out.mcpServerIds = out.mcpMode === 'selected'
    ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];

  // Derived, never stored: a record that could assert its own trust would make every
  // check downstream a formality.
  delete out.trust;

  const origin = originOf(out);
  if (origin) {
    out.builtin = false; // "we shipped it" is not something an import may claim
    out.origin = {
      source: origin.source,
      id: origin.id,
      ...(str(origin.url) ? { url: origin.url } : {}),
      ...(str(origin.hash) ? { hash: origin.hash } : {}),
      ...(origin.scanned && typeof origin.scanned === 'object' ? { scanned: { ...origin.scanned } } : {}),
    };
  } else if (out.origin != null) {
    delete out.origin; // a half-origin looks answered and is not
  }

  if (out.reads != null) {
    out.reads = [...new Set((Array.isArray(out.reads) ? out.reads : []).filter((r) => DATA_SCOPES.includes(r)))].sort();
  }
  for (const field of ['sources', 'surfaces']) {
    if (out[field] != null) {
      out[field] = [...new Set((Array.isArray(out[field]) ? out[field] : []).filter(str))];
    }
  }

  if (out.files != null) {
    const files = skillFiles(out);
    if (Object.keys(files).length) out.files = files;
    else delete out.files;
  }

  if (out.version != null && !str(out.version)) delete out.version;

  return out;
}
