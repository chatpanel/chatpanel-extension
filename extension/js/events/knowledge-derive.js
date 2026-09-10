// GENERATED — do not edit.
// Source of truth: chatpanel-events/knowledge-derive.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// DERIVING briefs — the pass that turns a corpus into the derived layer.
//
// Separate from `knowledge.js` (the model) because the costs are not alike: reading a brief
// needs its shape and its renderer; building one walks every record, resolves entities and
// runs the deterministic maintenance passes. Only pages ever build. The MV3 service worker
// only ever reads — it syncs stored briefs onward — so keeping this out of `knowledge.js`
// keeps it off the worker's cold start entirely, rather than relying on nobody importing it.
//
// Everything here is class R: no model, no network, and `now` is injected rather than read,
// so a rebuild is reproducible. That is what makes invariant I-K2 true — deriveBriefs() is
// the ONLY way a brief is ever created, so throwing them all away can never lose anything.

import { makeRef } from './ref.js';
import {
  DEFAULT_THRESHOLD, MAX_SUBJECTS, normalizeSubject, rankSubjects, resolveSubjects,
} from './entity.js';
import { mentionsFrom, normalizeRecords, wantedPages } from './curate.js';
import { MAX_CLAIMS, MAX_CLAIM_REFS, MAX_BRIEF_RECORDS, briefId, contentHash } from './knowledge.js';

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

// How many co-occurring subjects a `together` claim names. Past a handful it stops being a
// statement and becomes a tag cloud.
const TOGETHER_LIMIT = 5;

/**
 * Memories that are ABOUT this subject become its highest-confidence claims.
 *
 * This is how the existing memory layer folds in, and the direction matters. `identity` and
 * `preference` memories are AMBIENT — they ride every turn already, and copying them onto a
 * brief would say them twice. The other three kinds (`project`, `fact`, `reference`) are
 * retrieved rather than ambient, and a retrieved durable statement about a subject is
 * exactly what a claim is — except the user said it themselves, so it outranks anything
 * derived from co-occurrence.
 *
 * The reverse never happens automatically: a brief must not write itself into memory. Memory
 * is bounded because it is ambient; a corpus flowing into it would unbound the one thing in
 * the product that is deliberately small.
 */
function statedClaims(subject, memories, seq) {
  const out = [];
  const names = [subject.canonical, ...subject.aliases].filter(Boolean);
  for (const mem of memories) {
    if (!mem?.text || !mem.id) continue;
    if (mem.kind === 'identity' || mem.kind === 'preference') continue; // already ambient
    const hay = normalizeSubject(mem.text);
    // Whole-token containment, so "pricing" does not match "repricing" and a one-word
    // subject cannot claim every memory that happens to contain it as a substring.
    const hit = names.some((n) => n && (hay === n || hay.includes(` ${n} `) || hay.startsWith(`${n} `) || hay.endsWith(` ${n}`)));
    if (!hit) continue;
    out.push(claim({
      id: `${seq()}`,
      kind: 'stated',
      text: mem.text,
      refs: [makeRef({ kind: 'memory', id: mem.id, hash: contentHash(mem.text) })],
      at: Number(mem.updatedAt || mem.createdAt) || 0,
      confidence: Number(mem.confidence) || 1,
    }));
  }
  return out;
}

/**
 * One subject + the records that mention it → a brief.
 *
 * Every claim here is a restatement of something the corpus already holds, which is what
 * makes the phase free and what makes I-K3's auto-promotion defensible: none of it is an
 * opinion, so there is nothing for a reviewer to review.
 */
export function deriveBrief(subject, { records, byId, cooccurring = [], memories = [], wanted = null, now = 0 } = {}) {
  const recs = [...(subject.records instanceof Set ? subject.records : subject.records || [])]
    .map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (a.date || 0) - (b.date || 0));
  if (!recs.length && !wanted) return null;

  let n = 0;
  const seq = () => { n += 1; return `c${n}`; };
  const claims = [];

  if (recs.length) {
    const byType = {};
    for (const r of recs) byType[r.type] = (byType[r.type] || 0) + 1;
    const parts = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, c]) => plural(c, t));
    claims.push(claim({
      id: seq(),
      kind: 'presence',
      text: `Appears in ${plural(recs.length, 'record')} — ${parts.join(', ')}.`,
      // The most recent records, because that is what a reader checks first — and the
      // newest is also the one most likely to still resolve.
      refs: recs.slice(-MAX_CLAIM_REFS).reverse().map(refForRecord),
      at: now,
    }));

    const first = recs.find((r) => r.date);
    const last = [...recs].reverse().find((r) => r.date);
    if (first && last && first !== last) {
      claims.push(claim({
        id: seq(),
        kind: 'timeline',
        text: `Runs from ${isoDay(first.date)} to ${isoDay(last.date)} — ${first.title || 'untitled'} → ${last.title || 'untitled'}.`,
        refs: [refForRecord(first), refForRecord(last)],
        at: now,
      }));
    }
  }

  if (cooccurring.length) {
    claims.push(claim({
      id: seq(),
      kind: 'together',
      text: `Usually alongside ${cooccurring.slice(0, TOGETHER_LIMIT).map((c) => c.name).join(', ')}.`,
      refs: recs.slice(-MAX_CLAIM_REFS).map(refForRecord),
      at: now,
    }));
  }

  if (wanted) {
    // A [[link]] that resolves to nothing is the corpus asking for a page: a human already
    // decided the subject was worth naming. Saying so on the brief is more useful than
    // hiding it, because it tells the reader the page is thin BECAUSE nobody wrote the
    // source, not because the derivation failed.
    claims.push(claim({
      id: seq(),
      kind: 'wanted',
      text: `Linked from ${plural(wanted.recordCount, 'record')} but no record carries this title.`,
      refs: recs.slice(0, MAX_CLAIM_REFS).map(refForRecord),
      at: now,
    }));
  }

  claims.push(...statedClaims(subject, memories, seq));

  const capped = claims.slice(0, MAX_CLAIMS);
  const dates = recs.map((r) => r.date || 0).filter(Boolean);
  return {
    id: briefId(subject.key),
    key: subject.key,
    kind: subject.kind,
    subject: { name: subject.name, aliases: [...(subject.aliases || [])] },
    // Class R may auto-promote (I-K3): nothing above is an opinion, so there is nothing a
    // reviewer could accept or reject. W3's prose arrives as `proposed` beside it.
    state: 'promoted',
    cls: 'R',
    claims: capped,
    records: recs.slice(-MAX_BRIEF_RECORDS).map((r) => ({ id: r.id, type: r.type, title: r.title, date: r.date })),
    stats: {
      records: recs.length,
      mentions: subject.mentions,
      claims: capped.length,
      first: dates.length ? Math.min(...dates) : 0,
      last: dates.length ? Math.max(...dates) : 0,
      wanted: !!wanted,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The whole corpus → the briefs it earns. This IS invariant I-K2: it is the only way a
 * brief is ever created, so throwing them all away can never lose anything.
 *
 * `now` is injected rather than read, so a rebuild is reproducible and testable — the same
 * rule loop.js and schedule.js follow.
 */
export function deriveBriefs(records = [], {
  memories = [], threshold = DEFAULT_THRESHOLD, limit = MAX_SUBJECTS, now = 0,
} = {}) {
  const recs = normalizeRecords(records);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const mentions = mentionsFrom(recs);
  const subjects = resolveSubjects(mentions);
  const ranked = rankSubjects(subjects, { threshold, limit });

  // Which subjects share records with which — the `together` claim, computed once for the
  // whole corpus rather than per subject, so this stays linear in mentions rather than
  // quadratic in subjects.
  const perRecord = new Map();
  for (const s of ranked) {
    for (const id of s.records) {
      if (!perRecord.has(id)) perRecord.set(id, []);
      perRecord.get(id).push(s.key);
    }
  }
  const pairs = new Map();
  for (const keys of perRecord.values()) {
    for (const a of keys) for (const b of keys) {
      if (a === b) continue;
      const m = pairs.get(a) || new Map();
      m.set(b, (m.get(b) || 0) + 1);
      pairs.set(a, m);
    }
  }
  const byKey = new Map(ranked.map((s) => [s.key, s]));
  const wantedByNorm = new Map(wantedPages(recs).map((w) => [w.norm, w]));

  const out = [];
  for (const s of ranked) {
    const co = [...(pairs.get(s.key) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, count, name: byKey.get(key)?.name || key }))
      .filter((c) => c.count > 1);
    const brief = deriveBrief(s, {
      byId,
      cooccurring: co,
      memories,
      wanted: s.kind === 'title' ? wantedByNorm.get(s.canonical) || null : null,
      now,
    });
    if (brief) out.push(brief);
  }
  return out;
}

/**
 * Which refs no longer resolve to what they cited.
 *
 * This is where `ref.js`'s `drifted` finally earns its existence: a claim saying "cutover
 * moved to Q4, see meeting m_8812" is worthless if m_8812 has since been edited into
 * something else, and a maintenance pass that cannot tell is a maintenance pass that lies.
 */
export function driftedRefs(brief, records = []) {
  const hashes = new Map();
  for (const r of normalizeRecords(records)) {
    const [kind, ...rest] = r.id.split(':');
    hashes.set(`${kind}:${rest.join(':') || r.id}`, contentHash(r.text));
  }
  const out = [];
  for (const c of brief?.claims || []) {
    for (const ref of c.refs || []) {
      if (ref.kind === 'memory') continue; // memories are not records; they drift by edit, not by hash
      const now = hashes.get(`${ref.kind}:${ref.id}`);
      if (now === undefined) out.push({ claim: c.id, ref, resolution: 'verified-but-unavailable' });
      else if (now !== ref.hash) out.push({ claim: c.id, ref, resolution: 'drifted' });
    }
  }
  return out;
}
