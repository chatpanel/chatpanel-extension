// GENERATED — do not edit.
// Source of truth: chatpanel-events/subject-name.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Naming a subject, and when one is big enough to deserve a page.
//
// The small, dependency-free half of subject identity: fold a name to its canonical form,
// strip the decoration a directory hangs off it, and hold the evidence thresholds. Nothing
// here resolves aliases, proposes merges or reaches for a Levenshtein — that is `entity.js`,
// which imports this.
//
// The split is a load-time one, and it is the third time the lesson has come up here (see
// `distance.js` and `redaction-tokens.js`). `knowledge.js` needs exactly `normalizeSubject`
// to build a brief id, and the extension's brief store needs exactly `DEFAULT_THRESHOLD` —
// and both are on the MV3 service worker's graph. Reaching them through `entity.js` put
// entity resolution and merge suggestion on a worker that will never run either.

import { SUBJECT_KINDS } from './subject-kinds.js';

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
/**
 * Labels a meeting platform uses for the person holding the microphone.
 *
 * Zoom, Meet and Teams all write the local participant as "You" — so the user appears in
 * their own corpus under a name that is not a name, alongside however their colleagues'
 * clients spelled them. Resolving these needs one fact only the host has: who "you" IS.
 * `resolveSubjects` takes it rather than guessing, and with no `self` supplied these stay
 * unresolved instead of collapsing every meeting's local speaker into one fictional person.
 */
export const SELF_LABELS = Object.freeze(['you', 'me', 'myself', 'yourself', 'i']);

/**
 * Is this the platform's label for the local participant?
 *
 * Exported because two layers need the SAME exception and getting the order wrong is subtle:
 * a self-label fails `isSubjectCandidate` (it is a pronoun), so any pass that filters
 * candidacy BEFORE `resolveSubjects` can fold it has already thrown the user away. `curate.js
 * mentionsFrom` keeps them for exactly this reason and lets resolution decide.
 */
export function isSelfLabel(name) {
  return SELF_LABELS.includes(normalizeSubject(name));
}

/**
 * Strip the decoration a directory or a conference client hangs off a person's name.
 *
 * The same human arrives as "Alex Rivera", "Alex Rivera (ACME)", "Alex Rivera - Host" and
 * "Alex Rivera (he/him)" depending on which client wrote the label. The part in parentheses
 * or after a dash is an org, a role or a pronoun set — decoration, never identity — so it is
 * removed before folding.
 *
 * NOT removed for non-person subjects: "Migration (Phase 2)" is a different topic from
 * "Migration", where "Alex Rivera (ACME)" is not a different person from "Alex Rivera".
 */
export function stripQualifiers(name) {
  return String(name ?? '')
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')   // (ACME), [external], {guest}
    .replace(/\s+[-–—|·,]\s+.*$/, '')             // - Host, — Guest, | ACME
    .replace(/\s+/g, ' ')
    .trim();
}
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
