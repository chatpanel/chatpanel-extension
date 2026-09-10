// GENERATED — do not edit.
// Source of truth: chatpanel-events/entity.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// ENTITY IDENTITY — forty mentions of one person are one subject, or they are nothing.
//
// Extraction we already have: `meeting-people.js` names the speakers on a call,
// `extraction.js` pulls topics and ENTITIES, `tags.js` folds the filing vocabulary. What
// none of them answer is the next question: are "Alex Rivera", "alex rivera" and the
// "Alex" who spoke in yesterday's standup the SAME subject? Without that answer a derived
// layer cannot exist — a brief is by definition an accumulation across records, so it needs
// something to accumulate *about*.
//
// Two rules do almost all the work, and both are deliberately conservative:
//
//   • CANONICAL FORM IS LOSSY, IDENTITY IS NOT. `subjectKey()` folds case, punctuation and
//     spacing — filing noise, exactly as in tags.js — but never folds two different names
//     together. The display name stays whatever the corpus said most often, so the user
//     reads "Alex Rivera" and not "alex-rivera".
//   • AN ALIAS IS ONLY AN ALIAS WHEN IT IS UNAMBIGUOUS. "Alex" folds into "Alex Rivera"
//     when Alex Rivera is the only Alex in the corpus. The moment a second Alex appears,
//     the bare token stops resolving to either — for good, and retroactively. Guessing here
//     is how a brief ends up attributing one person's decisions to another, which is the
//     single most expensive mistake this layer can make.
//
// Pure input → output: no storage, no clock, no model. The extension, the gateway and a
// future mobile client must agree on what "the same subject" is, and three implementations
// would mean three answers — the argument tags.js already makes for tags.

/** What a subject can be. `title` is a record title someone linked to with [[…]]. */
export const SUBJECT_KINDS = Object.freeze(['person', 'topic', 'tag', 'title']);

/**
 * A subject earns a brief with EVIDENCE, not on first sight (I-K4).
 *
 * PROVISIONAL. These numbers are the W0 measurement's whole point: `surveyCorpus()` reports
 * how many subjects clear them so they can be set from a real corpus instead of taste. Do
 * not treat them as decided until that report has been run.
 */
export const DEFAULT_THRESHOLD = Object.freeze({ records: 3, mentions: 5 });

/** Ceiling on the set of briefs, for the same reason memory.js caps memories. Provisional. */
export const MAX_SUBJECTS = 500;

/** Longest name we will treat as a subject — past this it is a sentence, not a subject. */
export const MAX_SUBJECT_CHARS = 60;

// Words that are never a subject on their own. A one-token candidate has to survive this
// list before it can become a page, because "notes", "meeting" and "update" appear in every
// record and would each clear any threshold instantly.
const STOP_SUBJECTS = new Set([
  'chat', 'chats', 'note', 'notes', 'meeting', 'meetings', 'call', 'calls', 'update',
  'updates', 'summary', 'summaries', 'agenda', 'todo', 'todos', 'task', 'tasks', 'item',
  'items', 'thing', 'things', 'stuff', 'misc', 'other', 'general', 'test', 'testing',
  'untitled', 'draft', 'drafts', 'new', 'old', 'today', 'yesterday', 'tomorrow', 'week',
  'day', 'month', 'year', 'time', 'people', 'person', 'team', 'work',
]);

/**
 * Fold a name to its canonical form: lowercase, Unicode-aware, separators collapsed.
 *
 * Spaces survive as spaces (unlike normalizeTag, which folds them to '-') because a person's
 * name is read back to the user and "alex rivera" has to be recognisable as one.
 */
export function normalizeSubject(name) {
  const raw = String(name ?? '').normalize('NFKC').trim().replace(/^[#@]+/, '');
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_CHARS)
    .trim();
}

/** `person:alex rivera` — the identity a brief is filed under. '' when nothing survives. */
export function subjectKey(kind, name) {
  const norm = normalizeSubject(name);
  if (!norm || !SUBJECT_KINDS.includes(kind)) return '';
  return `${kind}:${norm}`;
}

/** Tokens of a canonical name. */
export function subjectTokens(name) {
  const norm = normalizeSubject(name);
  return norm ? norm.split(' ').filter(Boolean) : [];
}

/**
 * Is this string worth considering as a subject at all?
 *
 * Rejects blanks, over-long phrases, pure numbers and the stop list above. A multi-token
 * phrase is allowed even when one of its tokens is a stop word ("design review" is a real
 * topic, "review" alone is not).
 */
export function isSubjectCandidate(name, { kind = 'topic' } = {}) {
  // Length is judged BEFORE folding: normalizeSubject truncates at MAX_SUBJECT_CHARS, so a
  // check on its output can never fire and a whole sentence would slip through as a subject.
  if (String(name ?? '').trim().length > MAX_SUBJECT_CHARS) return false;
  const norm = normalizeSubject(name);
  if (!norm || norm.length < 2) return false;
  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.every((t) => /^\p{N}+$/u.test(t))) return false;
  if (tokens.length === 1 && STOP_SUBJECTS.has(tokens[0])) return false;
  // A person needs at least two characters of actual letters — "j r" is initials, not an
  // identity we can accumulate against.
  if (kind === 'person' && !/\p{L}{2}/u.test(norm)) return false;
  return true;
}

/**
 * Resolve short forms to full names, but ONLY when the corpus leaves no doubt.
 *
 * Given the canonical names seen for one kind, returns `alias -> canonical`. A bare token
 * maps to a multi-token name when it is that name's first or last token AND exactly one
 * name in the corpus claims it. Two people called Alex means neither owns "alex", so the
 * bare token maps to nothing and stays a subject of its own — visible, unmerged, and
 * therefore checkable, which is the failure mode we want.
 */
export function aliasMap(names) {
  const canonical = new Set();
  for (const n of names || []) {
    const norm = normalizeSubject(n);
    if (norm && norm.includes(' ')) canonical.add(norm);
  }
  const claims = new Map(); // token -> Set(full names claiming it)
  for (const full of canonical) {
    const tokens = full.split(' ');
    for (const t of [tokens[0], tokens[tokens.length - 1]]) {
      if (!t || t.length < 2 || STOP_SUBJECTS.has(t)) continue;
      if (!claims.has(t)) claims.set(t, new Set());
      claims.get(t).add(full);
    }
  }
  const out = new Map();
  for (const [token, owners] of claims) {
    if (owners.size !== 1) continue; // ambiguous — resolve to nothing, on purpose
    out.set(token, [...owners][0]);
  }
  return out;
}

/**
 * Fold a list of raw mentions into subjects.
 *
 * `mentions` is `[{ kind, name, recordId }]` — whatever the corpus said, in whatever form.
 * The result is one entry per identity, carrying every surface form that reached it, the
 * distinct records it appeared in, and the display name the corpus used most often.
 *
 * Aliases are resolved per KIND: two topics can share a word without being the same topic,
 * and the person rule above must not leak into tags.
 */
export function resolveSubjects(mentions = []) {
  const byKind = new Map();
  for (const m of mentions) {
    const kind = m?.kind;
    if (!SUBJECT_KINDS.includes(kind)) continue;
    if (!isSubjectCandidate(m.name, { kind })) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(m);
  }

  const subjects = new Map();
  for (const [kind, list] of byKind) {
    // Only PERSON names carry the short-form rule. A topic named "design" is not the
    // "design review" topic, and folding them would silently merge two pages.
    const aliases = kind === 'person' ? aliasMap(list.map((m) => m.name)) : new Map();
    for (const m of list) {
      const norm = normalizeSubject(m.name);
      const canonical = aliases.get(norm) || norm;
      const key = `${kind}:${canonical}`;
      let s = subjects.get(key);
      if (!s) {
        s = { key, kind, name: '', canonical, aliases: [], records: new Set(), mentions: 0, forms: new Map() };
        subjects.set(key, s);
      }
      s.mentions += 1;
      if (m.recordId) s.records.add(m.recordId);
      const display = String(m.name ?? '').normalize('NFKC').trim();
      if (display) s.forms.set(display, (s.forms.get(display) || 0) + 1);
      if (norm !== canonical && !s.aliases.includes(norm)) s.aliases.push(norm);
    }
  }

  for (const s of subjects.values()) {
    // The name the user reads is a surface form of the CANONICAL identity, most common
    // first, ties broken alphabetically so the choice is stable across runs rather than
    // insertion-ordered. Forms that only reached this subject through an alias are ranked
    // last: `person:alex rivera` displayed as "Alex" because the short form happened to be
    // one mention commoner would be a page whose title is not the subject's name.
    const forms = [...s.forms.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    s.name = forms.find(([f]) => normalizeSubject(f) === s.canonical)?.[0]
      || forms[0]?.[0]
      || s.canonical;
    s.aliases.sort();
    delete s.forms;
  }
  return subjects;
}

/** Does this subject have enough evidence to deserve a page? */
export function earnsBrief(subject, threshold = DEFAULT_THRESHOLD) {
  if (!subject) return false;
  const records = subject.records instanceof Set ? subject.records.size : (subject.records?.length || 0);
  const mentions = Number(subject.mentions) || 0;
  return records >= (threshold.records ?? DEFAULT_THRESHOLD.records)
      && mentions >= (threshold.mentions ?? DEFAULT_THRESHOLD.mentions);
}

/**
 * Rank subjects and keep the ones that earned a page, strongest first.
 *
 * `limit` is the I-K4 count ceiling made concrete: a corpus with 4000 qualifying subjects
 * does not get 4000 briefs, it gets the best `limit` of them, and the rest stay subjects
 * without pages until the evidence moves.
 */
export function rankSubjects(subjects, { threshold = DEFAULT_THRESHOLD, limit = MAX_SUBJECTS } = {}) {
  const list = [...(subjects instanceof Map ? subjects.values() : subjects || [])];
  return list
    .filter((s) => earnsBrief(s, threshold))
    .map((s) => ({ ...s, recordCount: s.records instanceof Set ? s.records.size : (s.records?.length || 0) }))
    .sort((a, b) => b.recordCount - a.recordCount || b.mentions - a.mentions || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}
