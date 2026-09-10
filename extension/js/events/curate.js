// GENERATED — do not edit.
// Source of truth: chatpanel-events/curate.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// THE MAINTENANCE PASS — the half that costs nothing.
//
// The wiki pattern's lint step is usually described as a model reading the whole corpus
// looking for contradictions, which is both expensive and O(N²). Most of what it would
// "notice" is mechanical, though: a [[link]] pointing at nothing, a record connected to
// nothing, two titles that differ by a space, a tag spelled two ways, a subject mentioned
// everywhere with no page. None of that needs a model, and running it first is what keeps
// the model half small enough to bound — only candidates this pass FLAGGED are ever
// adjudicated, and only within one subject's claims (never N×N over the corpus).
//
// So this module is the deterministic layer, and `surveyCorpus()` is its first caller: the
// W0 read-only report over an existing corpus. It answers, for a real user's data, the
// question the design cannot answer from a chair — is this corpus dense enough that a
// derived layer beats re-deriving from retrieval every time? If the numbers are thin the
// honest conclusion is to finish retrieval instead, and this report is what says so.
//
// Pure input → output. No storage, no clock, no network, no model — it runs in a service
// worker, in Node against a backup, and in the gateway against the warm store, and gives
// the same answer in all three.

import { normalizeTag } from './tags.js';
// The bounded Levenshtein, from the module that holds only it. Two implementations of "how
// far apart are these strings" become two answers to "is this the same title" — but see
// distance.js for why it is not imported from voice-intents.js, which is where it grew up.
import { editDistance } from './distance.js';
import {
  DEFAULT_THRESHOLD, MAX_SUBJECTS, isSelfLabel, isSubjectCandidate,
  normalizeSubject, rankSubjects, resolveSubjects,
} from './entity.js';
import { isRedactionToken } from './redaction-tokens.js';

/** Wikilink syntax, matching store-notes.js `extractLinks` exactly — one grammar, not two. */
const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** Below this, two normalized titles are "the same title typed twice". */
export const NEAR_TITLE_DISTANCE = 2;

/**
 * A ceiling on pairwise work, and the reason it exists.
 *
 * The near-duplicate passes below used to compare EVERY pair, which is the exact N×N scan
 * the design says not to build — and it behaved like one: 1s at 2,000 records, 10s at 6,000,
 * 40s at 12,000, on the UI thread, which is an unresponsive tab rather than a slow report.
 *
 * The fix is BLOCKING, the standard record-linkage answer: two strings within `distance`
 * edits almost always still agree on their first or last few characters, so only strings
 * sharing one of those keys are ever compared. That turns the pass near-linear while keeping
 * the findings that matter. The budget is the backstop for the pathological case — ten
 * thousand titles that all start the same way — so a weird corpus costs a truncated report
 * rather than a hung page.
 */
export const MAX_PAIR_COMPARISONS = 200_000;

// Two keys per string: what it starts with and what it ends with. An edit near the front
// still matches on the tail, and vice versa — one pass over each bucket catches both.
const BLOCK_KEY_CHARS = 4;
function blockKeys(norm) {
  const head = norm.slice(0, BLOCK_KEY_CHARS);
  const tail = norm.slice(-BLOCK_KEY_CHARS);
  return head === tail ? [`p:${head}`] : [`p:${head}`, `s:${tail}`];
}

/**
 * Candidate pairs worth comparing, from a list of normalized strings — never all of them.
 * Yields `[a, b]` with each unordered pair at most once, within the comparison budget.
 */
function* blockedPairs(norms, { budget = MAX_PAIR_COMPARISONS } = {}) {
  const blocks = new Map();
  for (const n of norms) {
    for (const key of blockKeys(n)) {
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(n);
    }
  }
  let spent = 0;
  const seen = new Set();
  for (const bucket of blocks.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (spent >= budget) return;
        const key = bucket[i] < bucket[j] ? `${bucket[i]}\u0000${bucket[j]}` : `${bucket[j]}\u0000${bucket[i]}`;
        if (seen.has(key)) continue; // a pair sharing BOTH keys lands in two buckets
        seen.add(key);
        spent += 1;
        yield [bucket[i], bucket[j]];
      }
    }
  }
}

/** How much term overlap counts as a record answering a question, in `spanningQuestions`. */
export const SPAN_MIN_TERMS = 2;

/**
 * Accept either the extension's Source shape (`meta.tags` / `meta.terms` / `meta.people`)
 * or a flat record, so a caller does not have to reshape a corpus to survey it.
 */
export function normalizeRecord(rec) {
  if (!rec || !rec.id) return null;
  const meta = rec.meta || {};
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);
  return {
    id: String(rec.id),
    type: String(rec.type || rec.kind || '').toLowerCase() || 'record',
    title: String(rec.title || '').trim(),
    date: Number(rec.date || rec.updatedAt || rec.startedAt || 0) || 0,
    text: String(rec.text || rec.contentText || ''),
    tags: list(rec.tags ?? meta.tags),
    topics: list(rec.topics ?? meta.terms ?? meta.topics),
    people: list(rec.people ?? meta.people),
  };
}

export function normalizeRecords(records) {
  // Tolerates null as well as an omitted argument: a caller reading a corpus that has not
  // loaded yet passes null, and a survey that throws there reads as a broken tool rather
  // than as an empty corpus.
  return (Array.isArray(records) ? records : []).map(normalizeRecord).filter(Boolean);
}

/**
 * Every `[[target]]` in a string, de-duplicated, in first-seen order — MINUS the redaction
 * placeholders, which share the syntax exactly.
 *
 * `@chatpanel/pii` writes `[[PERSON_1]]`, so a redacted transcript looks like a document
 * full of links to pages nobody wrote. Counting those as wanted pages filed the people we
 * deliberately did not learn about as things we know. Matched by TYPE, not by shape, so a
 * real `[[Q3_2026]]` link still resolves.
 */
export function wikilinksIn(text) {
  const out = [];
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(String(text || '')))) {
    // `[[Title|alias]]` is Obsidian's display form — the LINK is the part before the pipe.
    const target = m[1].split('|')[0].trim();
    if (!target || isRedactionToken(target)) continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * The placeholders a text carries, by type — what redaction COST the graph.
 *
 * Reported rather than silently dropped, because the loss is real and the user is the only
 * one who can decide about it. `PERSON_1` is a genuine, stable entity inside its own
 * conversation; what makes it unusable as a subject is that the vault is scoped to that
 * conversation and is never persisted, so Monday's `PERSON_1` and Friday's are different
 * people and merging them would attribute one person's decisions to another.
 *
 * Seeing "412 redacted mentions across 38 records" is what tells someone their redaction
 * level is costing them a connected graph — a trade only they can make.
 */
export function redactedTokensIn(text) {
  const out = new Map();
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(String(text || '')))) {
    const target = m[1].split('|')[0].trim();
    if (!isRedactionToken(target)) continue;
    const type = /^([A-Z][A-Z0-9]*)_/.exec(target.replace(/^\[{1,2}|\]{1,2}$/g, ''))?.[1] || 'OTHER';
    out.set(type, (out.get(type) || 0) + 1);
  }
  return out;
}

/** Corpus-wide: how many placeholders, of which types, across how many records. */
export function redactionCost(records = []) {
  const byType = {};
  let total = 0;
  let recordsAffected = 0;
  for (const r of normalizeRecords(records)) {
    const found = redactedTokensIn(r.text);
    if (!found.size) continue;
    recordsAffected += 1;
    for (const [type, n] of found) { byType[type] = (byType[type] || 0) + n; total += n; }
  }
  return { total, records: recordsAffected, byType };
}

/**
 * Links that point at nothing — the corpus telling you which pages it wants.
 *
 * This is the highest-signal candidate source in the whole pass: a human already decided
 * the subject was worth naming, and typed it. Returns most-wanted first.
 */
export function wantedPages(records = []) {
  const recs = normalizeRecords(records);
  const titles = new Set(recs.map((r) => normalizeSubject(r.title)).filter(Boolean));
  const wanted = new Map();
  for (const r of recs) {
    for (const target of wikilinksIn(r.text)) {
      const norm = normalizeSubject(target);
      if (!norm || titles.has(norm)) continue;
      let w = wanted.get(norm);
      if (!w) { w = { target, norm, count: 0, records: new Set() }; wanted.set(norm, w); }
      w.count += 1;
      w.records.add(r.id);
    }
  }
  return [...wanted.values()]
    .map((w) => ({ target: w.target, norm: w.norm, count: w.count, recordCount: w.records.size }))
    .sort((a, b) => b.recordCount - a.recordCount || b.count - a.count || a.norm.localeCompare(b.norm));
}

/**
 * Records connected to nothing else.
 *
 * "Connected" is deliberately generous — a resolvable wikilink in either direction, or a
 * shared tag, or a shared topic. A record that fails all three is genuinely marooned: no
 * path leads to it except full-text search, which is exactly the state a derived layer is
 * supposed to fix. Notes' Stats tab computes a notes-only version of this today; this is
 * the same question asked across chats, meetings and notes at once.
 */
export function orphanRecords(records = []) {
  const recs = normalizeRecords(records);
  const byTitle = new Map();
  for (const r of recs) {
    const norm = normalizeSubject(r.title);
    if (norm && !byTitle.has(norm)) byTitle.set(norm, r.id);
  }
  const linked = new Set();
  const shared = new Map(); // term -> record ids
  for (const r of recs) {
    for (const target of wikilinksIn(r.text)) {
      const hit = byTitle.get(normalizeSubject(target));
      if (hit && hit !== r.id) { linked.add(r.id); linked.add(hit); }
    }
    for (const t of [...r.tags.map(normalizeTag), ...r.topics.map(normalizeSubject)]) {
      if (!t) continue;
      if (!shared.has(t)) shared.set(t, new Set());
      shared.get(t).add(r.id);
    }
  }
  for (const ids of shared.values()) {
    if (ids.size > 1) for (const id of ids) linked.add(id);
  }
  return recs.filter((r) => !linked.has(r.id)).map((r) => ({ id: r.id, type: r.type, title: r.title, date: r.date }));
}

/**
 * "Atlas sync 3" and "Atlas sync 4" are a SERIES, not a typo of each other — and so are
 * "Chat 1" … "Chat 8". They sit one or two edits apart, so without this guard the near-match
 * pass reports every recurring meeting and every default chat title as one duplicate group,
 * which is precisely the noise that makes a maintenance report get ignored.
 */
function sameSeries(a, b) {
  const stem = (s) => s.replace(/\s*\d+$/, '').trim();
  const sa = stem(a), sb = stem(b);
  return sa !== a || sb !== b ? sa === sb : false;
}

/**
 * Titles that are the same thing written twice — exact collisions after normalization, and
 * near-misses within `NEAR_TITLE_DISTANCE`. Each group is a merge candidate, never a merge:
 * "Q3 Planning" and "Q4 Planning" are one character apart and must NOT be merged, which is
 * precisely why this pass reports and the promotion gate decides.
 */
export function duplicateTitles(records = [], { distance = NEAR_TITLE_DISTANCE } = {}) {
  const recs = normalizeRecords(records).filter((r) => normalizeSubject(r.title));
  const groups = new Map();
  for (const r of recs) {
    const norm = normalizeSubject(r.title);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(r);
  }
  const norms = [...groups.keys()].sort();

  // Near-misses first, over BLOCKED candidate pairs rather than every pair — see
  // MAX_PAIR_COMPARISONS for what that replaced.
  const nearOf = new Map();
  for (const [a, b] of blockedPairs(norms)) {
    // A title short enough that `distance` edits rewrite most of it is not a near-miss.
    if (Math.min(a.length, b.length) <= distance * 2) continue;
    if (sameSeries(a, b)) continue;
    if (editDistance(a, b, distance) > distance) continue;
    if (!nearOf.has(a)) nearOf.set(a, []);
    if (!nearOf.has(b)) nearOf.set(b, []);
    nearOf.get(a).push(b);
    nearOf.get(b).push(a);
  }

  const out = [];
  const merged = new Set();
  for (const norm of norms) {
    if (merged.has(norm)) continue;
    const cluster = [norm];
    for (const other of nearOf.get(norm) || []) {
      if (merged.has(other) || other === norm) continue;
      cluster.push(other);
      merged.add(other);
    }
    const items = cluster.flatMap((n) => groups.get(n));
    if (items.length > 1) {
      out.push({
        norm,
        titles: [...new Set(items.map((r) => r.title))],
        ids: items.map((r) => r.id),
      });
    }
  }
  return out.sort((a, b) => b.ids.length - a.ids.length || a.norm.localeCompare(b.norm));
}

/**
 * One vocabulary spelled several ways — "design-review" and "designreview" filed apart.
 *
 * Tags already normalize (tags.js), so a collision here is a real divergence in what the
 * user typed, not a normalization bug. Topics come from a model and drift harder.
 */
export function vocabularyDrift(records = [], { distance = 1 } = {}) {
  const recs = normalizeRecords(records);
  const freq = new Map();
  for (const r of recs) {
    for (const raw of r.tags) {
      const t = normalizeTag(raw);
      if (t) freq.set(t, (freq.get(t) || 0) + 1);
    }
    for (const raw of r.topics) {
      const t = normalizeTag(raw);
      if (t) freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const terms = [...freq.keys()].sort();
  const bare = (t) => t.replace(/-/g, '');

  // Same blocking as duplicateTitles. A vocabulary is smaller than a corpus, so this has not
  // bitten yet — but it is the identical shape, and the identical shape is what bites.
  const nearOf = new Map();
  for (const [a, b] of blockedPairs(terms)) {
    if (Math.min(a.length, b.length) <= 3) continue;
    if (bare(a) !== bare(b) && editDistance(a, b, distance) > distance) continue;
    if (!nearOf.has(a)) nearOf.set(a, []);
    if (!nearOf.has(b)) nearOf.set(b, []);
    nearOf.get(a).push(b);
    nearOf.get(b).push(a);
  }

  const out = [];
  const taken = new Set();
  for (const term of terms) {
    if (taken.has(term)) continue;
    const near = (nearOf.get(term) || []).filter((t) => !taken.has(t) && t !== term);
    for (const t of near) taken.add(t);
    if (near.length) {
      out.push({ terms: [term, ...near].map((t) => ({ term: t, count: freq.get(t) || 0 })) });
    }
  }
  return out.sort((a, b) => b.terms.length - a.terms.length);
}

/**
 * Every mention the corpus offers, without a model: who was on a call, what it was tagged,
 * what topics were extracted for it, what someone [[linked]] to, and what the records are
 * titled. These are the raw inputs `resolveSubjects()` folds into identities.
 */
export function mentionsFrom(records = []) {
  const recs = normalizeRecords(records);
  const out = [];
  for (const r of recs) {
    for (const name of r.people) out.push({ kind: 'person', name, recordId: r.id });
    for (const name of r.tags) out.push({ kind: 'tag', name, recordId: r.id });
    for (const name of r.topics) out.push({ kind: 'topic', name, recordId: r.id });
    for (const name of wikilinksIn(r.text)) out.push({ kind: 'title', name, recordId: r.id });
  }
  // A person's self-label ("You") survives candidacy HERE and is decided by
  // `resolveSubjects`, which is the only layer that knows whether we have a name to fold it
  // into. Filtering it out at this level threw the user out of their own corpus.
  return out.filter((m) => isSubjectCandidate(m.name, { kind: m.kind })
    || (m.kind === 'person' && isSelfLabel(m.name)));
}

/** Query terms, folded the way `sources-retrieval.js queryTerms` folds them. */
function termsOf(text, { min = 3 } = {}) {
  return [...new Set(
    String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= min),
  )];
}

/**
 * How often does answering a question require more than one record?
 *
 * The measurement that decides whether this layer is worth building at all. If almost every
 * question is answered by a single record, retrieval already wins and synthesis buys
 * nothing; if the typical question touches four, then every asking of it re-derives the
 * same join, forever, and a maintained page pays for itself.
 *
 * Deterministic and crude on purpose — term overlap, no model, no embeddings. It is a
 * ratio, not a search engine, and a ratio only has to be honest.
 */
export function spanningQuestions(records = [], questions = [], { minTerms = SPAN_MIN_TERMS, span = 3 } = {}) {
  const recs = normalizeRecords(records);
  const index = recs.map((r) => ({ id: r.id, terms: new Set(termsOf(`${r.title}\n${r.text}`)) }));
  let spanning = 0;
  let considered = 0;
  const hits = [];
  for (const q of questions) {
    const terms = termsOf(q);
    if (terms.length < minTerms) continue; // "thanks!" is not a question about the corpus
    considered += 1;
    let n = 0;
    for (const rec of index) {
      let overlap = 0;
      for (const t of terms) if (rec.terms.has(t)) overlap += 1;
      if (overlap >= minTerms) n += 1;
    }
    hits.push(n);
    if (n > span) spanning += 1;
  }
  hits.sort((a, b) => a - b);
  return {
    considered,
    spanning,
    fraction: considered ? spanning / considered : 0,
    medianRecords: hits.length ? hits[Math.floor(hits.length / 2)] : 0,
    span,
  };
}

/**
 * W0 — the whole deterministic pass, as one read-only report.
 *
 * Nothing here writes, and nothing here calls a model. Run it before building the derived
 * layer, and let its numbers set the thresholds in `entity.js` rather than the other way
 * round.
 */
export function surveyCorpus(records = [], { questions = [], threshold = DEFAULT_THRESHOLD, limit = MAX_SUBJECTS } = {}) {
  const recs = normalizeRecords(records);
  const byType = {};
  let chars = 0;
  for (const r of recs) {
    byType[r.type] = (byType[r.type] || 0) + 1;
    chars += r.text.length;
  }
  const mentions = mentionsFrom(recs);
  const subjects = resolveSubjects(mentions);
  const qualifying = rankSubjects(subjects, { threshold, limit });
  const byKind = {};
  for (const s of qualifying) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  const wanted = wantedPages(recs);
  const orphans = orphanRecords(recs);
  const redaction = redactionCost(recs);

  return {
    corpus: {
      records: recs.length,
      byType,
      chars,
      oldest: recs.reduce((m, r) => (r.date && (!m || r.date < m) ? r.date : m), 0),
      newest: recs.reduce((m, r) => Math.max(m, r.date || 0), 0),
    },
    subjects: {
      total: subjects.size,
      qualifying: qualifying.length,
      byKind,
      threshold: { records: threshold.records ?? DEFAULT_THRESHOLD.records, mentions: threshold.mentions ?? DEFAULT_THRESHOLD.mentions },
      capped: subjects.size > 0 && qualifying.length === limit,
      top: qualifying.slice(0, 25).map((s) => ({
        key: s.key, kind: s.kind, name: s.name, aliases: s.aliases,
        records: s.recordCount, mentions: s.mentions,
      })),
    },
    wantedPages: { total: wanted.length, top: wanted.slice(0, 25) },
    orphans: {
      total: orphans.length,
      fraction: recs.length ? orphans.length / recs.length : 0,
      byType: orphans.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }), {}),
      sample: orphans.slice(0, 10),
    },
    redaction,
    duplicateTitles: duplicateTitles(recs),
    vocabularyDrift: vocabularyDrift(recs),
    questions: spanningQuestions(recs, questions),
  };
}

/**
 * Sensitivity — the same corpus at several thresholds, so the number is CHOSEN rather than
 * inherited. A threshold that yields 4 subjects is useless and one that yields 4000 is a
 * second corpus (C5); the report should make both visible at a glance.
 */
export function thresholdSweep(records = [], grid = [
  { records: 2, mentions: 2 }, { records: 3, mentions: 5 }, { records: 4, mentions: 8 }, { records: 6, mentions: 12 },
]) {
  const subjects = resolveSubjects(mentionsFrom(records));
  return grid.map((threshold) => {
    const ranked = rankSubjects(subjects, { threshold, limit: Infinity });
    const byKind = {};
    for (const s of ranked) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    return { threshold, qualifying: ranked.length, byKind };
  });
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

/** The report as plain text — the form W0 is actually read in. */
export function formatSurvey(report, { sweep = null } = {}) {
  if (!report) return 'no report';
  const L = [];
  const { corpus, subjects, wantedPages: wp, orphans, duplicateTitles: dupes, vocabularyDrift: drift, questions } = report;

  L.push('CORPUS');
  L.push(`  ${corpus.records} records (${Object.entries(corpus.byType).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`);
  L.push(`  ${corpus.chars.toLocaleString()} chars · ${day(corpus.oldest)} → ${day(corpus.newest)}`);

  L.push('');
  L.push(`SUBJECTS  (earn a page at ≥${subjects.threshold.records} records and ≥${subjects.threshold.mentions} mentions)`);
  L.push(`  ${subjects.qualifying} of ${subjects.total} candidates qualify${subjects.capped ? ' (AT THE CEILING — raise the threshold)' : ''}`);
  L.push(`  by kind: ${Object.entries(subjects.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  for (const s of subjects.top) {
    L.push(`    ${String(s.records).padStart(4)} rec ${String(s.mentions).padStart(5)} men  ${s.kind}: ${s.name}${s.aliases.length ? `  (aka ${s.aliases.join(', ')})` : ''}`);
  }

  if (sweep?.length) {
    L.push('');
    L.push('THRESHOLD SWEEP');
    for (const row of sweep) {
      L.push(`  ≥${row.threshold.records} rec / ≥${row.threshold.mentions} men → ${String(row.qualifying).padStart(5)} subjects  (${Object.entries(row.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
    }
  }

  L.push('');
  L.push(`WANTED PAGES  ([[links]] resolving to nothing) — ${wp.total}`);
  for (const w of wp.top) L.push(`    ${String(w.recordCount).padStart(4)} rec  ${w.target}`);
  if (!wp.total) L.push('    none — either nobody uses [[links]] yet, or every one resolves');

  L.push('');
  L.push(`ORPHANS  (no link, no shared tag, no shared topic) — ${orphans.total} of ${corpus.records} (${pct(orphans.fraction)})`);
  L.push(`  by type: ${Object.entries(orphans.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);

  L.push('');
  L.push(`REDACTED MENTIONS  (placeholders that cannot become subjects) — ${report.redaction.total} across ${report.redaction.records} records`);
  L.push(`  by type: ${Object.entries(report.redaction.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  if (report.redaction.total) {
    L.push('  → the vault is per-conversation and is not persisted, so one PERSON_1 is not another.');
    L.push('    Lowering the redaction level is what buys these back as real subjects.');
  }

  L.push('');
  L.push(`DUPLICATE / NEAR-DUPLICATE TITLES — ${dupes.length} groups`);
  for (const g of dupes.slice(0, 10)) L.push(`    ${g.ids.length}×  ${g.titles.join('  |  ')}`);

  L.push('');
  L.push(`VOCABULARY DRIFT  (one term filed several ways) — ${drift.length} clusters`);
  for (const g of drift.slice(0, 10)) L.push(`    ${g.terms.map((t) => `${t.term}(${t.count})`).join('  |  ')}`);

  L.push('');
  L.push('QUESTIONS THAT SPAN RECORDS');
  if (!questions.considered) {
    L.push('  no questions supplied — pass the recent user turns to measure this');
  } else {
    L.push(`  ${questions.spanning} of ${questions.considered} (${pct(questions.fraction)}) touch more than ${questions.span} records`);
    L.push(`  median records touched: ${questions.medianRecords}`);
    L.push('');
    L.push(questions.fraction >= 0.3
      ? '  → synthesis has something to compound: most asking re-derives a join across records.'
      : '  → THIN. Most questions are answered by one record; finish retrieval (docs/retrieval.md) before building briefs.');
  }
  return L.join('\n');
}
