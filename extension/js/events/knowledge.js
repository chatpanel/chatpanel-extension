// GENERATED — do not edit.
// Source of truth: chatpanel-events/knowledge.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// BRIEFS — the derived layer. A statement about a SUBJECT that accumulates across records.
//
// Everything else ChatPanel stores is a record of an event: a chat happened, a call
// happened, a human wrote a note. Nothing is a synthesis, so every answer is re-derived
// from scratch, every session, forever — and a multi-agent run's findings die with the run.
// A brief is the thing that compounds.
//
// FOUR INVARIANTS, and they are the whole defence (see docs/knowledge-compounding.md §5.1):
//
//   I-K1  Every claim cites raw. A claim with no ref is a BUG, not a weak claim — it is
//         refused on write. Derived text can then always be checked against, or rebuilt
//         from, the immutable records under it.
//   I-K2  A brief is REBUILDABLE. Delete every brief and this module reconstructs them from
//         the record store. That makes a brief a projection — the same guarantee replay()
//         gives the event log — and it makes "rebuild all" a cache clear, not data loss.
//   I-K3  Nothing self-promotes. `draft` is free; `promoted` needs a gate. Class-R
//         derivations may auto-promote (a backlink is not an opinion); model-written prose
//         may not. Unreviewed agent writing compounding into confident nonsense is the
//         failure mode that is undetectable six months later.
//   I-K4  Bounded, or it is a second corpus. A brief has a size ceiling and the SET of
//         briefs has a count ceiling driven by evidence — memory.js already made this
//         argument for memory, and the same sentence applies here.
//
// This phase (W1) is entirely class R: no model, no network, no clock of its own. Every
// claim is something the corpus already states — who was present, when, what co-occurs,
// what the user themselves told us. Prose synthesis arrives in W3, behind the gate, and
// lands as `proposed` beside these rather than replacing them.
//
// WHY THIS FILE IS THE MODEL AND `knowledge-derive.js` IS THE PASS. Reading a brief and
// BUILDING one have very different costs: reading needs the shape and the renderer, while
// building walks the whole corpus and needs entity resolution and the maintenance passes.
// The MV3 service worker only ever reads — it syncs stored briefs to the gateway — so
// putting both halves in one module would have put 60 KB of derivation on its cold start
// for code it never runs. The split is what keeps that honest rather than remembered.

// From subject-name.js, not entity.js: this module is on the MV3 service worker's graph and
// needs exactly one string function, where entity.js also carries alias resolution and merge
// suggestion. Same argument as the knowledge/knowledge-derive split, one level down.
import { normalizeSubject } from './subject-name.js';

/** draft → proposed → promoted → archived. `promotion.js` (W3) owns the transitions. */
export const BRIEF_STATES = Object.freeze(['draft', 'proposed', 'promoted', 'archived']);

/** What a claim is derived FROM. Class R throughout this phase. */
export const CLAIM_KINDS = Object.freeze(['presence', 'timeline', 'together', 'wanted', 'stated']);

// I-K4, made concrete. A brief that grows without bound is a document, and a document
// needs its own summary, and then nothing has been gained.
export const MAX_CLAIMS = 12;
export const MAX_CLAIM_REFS = 8;
export const MAX_BRIEF_RECORDS = 200;
export const MAX_BRIEF_CHARS = 4000;

// How many co-occurring subjects a `together` claim names. Past a handful it stops being a
// statement and becomes a tag cloud.
const TOGETHER_LIMIT = 5;

/**
 * A stable, non-cryptographic content hash, computed SYNCHRONOUSLY.
 *
 * Deliberately not SHA-256, which `store.js` uses and which is async: derivation walks
 * every record in the corpus and runs in an MV3 service worker, so a hash per record has to
 * be synchronous or the whole pass becomes a promise storm. The job here is DRIFT
 * DETECTION — "has the record this claim cites changed since the claim was made" — not
 * tamper resistance, and FNV-1a answers that exactly as well while staying pure.
 */
export function contentHash(text) {
  const s = String(text ?? '');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `f${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** `person:alex rivera` → `brief:person-alex-rivera`. Safe as a storage key and a URL hash. */
export function briefId(subjectKey) {
  const [kind, ...rest] = String(subjectKey || '').split(':');
  const slug = normalizeSubject(rest.join(':')).replace(/\s+/g, '-').replace(/-+/g, '-');
  if (!kind || !slug) return '';
  // The slug is TRUNCATED, so two long subjects can share one, and it is lossy, so two
  // kinds can too. A hash of the CANONICAL key rides along to separate them. Canonical, not
  // raw: "Alex Rivera" and "alex  rivera" are one subject and must land on one id, or a
  // rebuild would fork the page in two — the exact failure I-K2 exists to make impossible.
  const canonical = `${kind}:${normalizeSubject(rest.join(':'))}`;
  return `brief:${kind}-${slug.slice(0, 48)}-${contentHash(canonical).slice(1, 7)}`;
}

/** Records are addressed `chat:x` / `meeting:y` / `note:z` — the ref kind is the prefix. */
function refForRecord(rec) {
  const [kind, ...rest] = String(rec.id).split(':');
  const id = rest.join(':') || rec.id;
  const known = kind === 'chat' || kind === 'meeting' || kind === 'note' || kind === 'page';
  return makeRef({ kind: known ? kind : 'result', id: known ? id : rec.id, hash: contentHash(rec.text) });
}

function claim({ id, kind, text, refs, at = 0, confidence = 1 }) {
  return {
    id,
    kind,
    text,
    // I-K1 lives here: a claim is CONSTRUCTED with its refs, and `checkKnowledgeInvariants`
    // refuses one that arrives without them. There is no path that writes a claim first and
    // attaches provenance later, because that path is how provenance goes missing.
    refs: refs.slice(0, MAX_CLAIM_REFS),
    firstSeen: at,
    lastConfirmed: at,
    confidence,
    cls: 'R', // class R — derived, not written. W3's prose claims carry 'C'.
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isoDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

/**
 * The searchable body. A brief is a SOURCE, ranked by the same engine as everything else
 * (design §7.6 — no second retrieval stack), so it has to render to text like one.
 */
export function briefToText(brief) {
  if (!brief) return '';
  const L = [`BRIEF: ${brief.subject.name}`];
  if (brief.subject.aliases?.length) L.push(`Also known as: ${brief.subject.aliases.join(', ')}`);
  L.push(`Kind: ${brief.kind}`);
  L.push('');
  for (const c of brief.claims) {
    L.push(`- ${c.text}`);
    if (c.refs.length) L.push(`  (${c.refs.map((r) => `${r.kind}:${r.id}`).join(', ')})`);
  }
  if (brief.records.length) {
    L.push('', 'RECORDS:');
    for (const r of brief.records.slice(-40).reverse()) L.push(`- ${r.type}: ${r.title || 'untitled'}`);
  }
  return L.join('\n').slice(0, MAX_BRIEF_CHARS);
}

/** Terms the graph and the search index rank a brief by — its subject and its neighbours. */
export function briefTerms(brief) {
  if (!brief) return [];
  const together = brief.claims.find((c) => c.kind === 'together');
  const names = together ? together.text.replace(/^Usually alongside /, '').replace(/\.$/, '').split(', ') : [];
  return [...new Set([brief.subject.name, ...(brief.subject.aliases || []), ...names])].filter(Boolean);
}

/**
 * The invariants, as a check rather than a promise. Returns the failures; empty means clean.
 * Same shape as `invariants.js checkInvariants()`, for the same reason: an invariant nobody
 * can run is a comment.
 */
export function checkKnowledgeInvariants(brief) {
  const fail = [];
  if (!brief || typeof brief !== 'object') return [{ invariant: 'I-K1', detail: 'not a brief' }];
  if (!BRIEF_STATES.includes(brief.state)) fail.push({ invariant: 'I-K3', detail: `unknown state ${brief.state}` });
  if (brief.state === 'promoted' && brief.cls === 'C') {
    fail.push({ invariant: 'I-K3', detail: 'model-written prose cannot be promoted without the gate' });
  }
  for (const c of brief.claims || []) {
    if (!c.refs?.length) fail.push({ invariant: 'I-K1', detail: `claim ${c.id} cites nothing` });
    if (!CLAIM_KINDS.includes(c.kind) && c.cls !== 'C') {
      fail.push({ invariant: 'I-K1', detail: `claim ${c.id} has unknown kind ${c.kind}` });
    }
  }
  if ((brief.claims || []).length > MAX_CLAIMS) fail.push({ invariant: 'I-K4', detail: `${brief.claims.length} claims exceeds ${MAX_CLAIMS}` });
  if (briefToText(brief).length >= MAX_BRIEF_CHARS) fail.push({ invariant: 'I-K4', detail: 'brief text is at the ceiling' });
  return fail;
}
