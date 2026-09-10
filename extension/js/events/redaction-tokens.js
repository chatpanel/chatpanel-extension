// GENERATED — do not edit.
// Source of truth: chatpanel-events/redaction-tokens.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Recognising a redaction placeholder — one predicate, and nothing else in the module.
//
// It is its own file for the reason `distance.js` is: three unrelated places need this
// question answered — the subject resolver, the wikilink parser, and the extension's note
// index — and the first two live in `entity.js`, which has since grown entity resolution,
// merge suggestions and a Levenshtein dependency. Importing 25 KB of that into a notes page
// to ask "is this string a placeholder" is the same 120 KB mistake in a smaller coat.

/**
 * A REDACTION PLACEHOLDER IS NOT A SUBJECT — and this is the sharpest edge in the module.
 *
 * `@chatpanel/pii` writes `[[PERSON_1]]`, `[[EMAIL_2]]`, `[[LOCATION_1]]`, which is
 * character-for-character the `[[wikilink]]` grammar. So a redacted transcript reads as a
 * document full of links to pages that do not exist, and every one of them earned a "wanted
 * page" brief. The name of a person we deliberately did not learn was being filed as a thing
 * we know about.
 *
 * The tempting fix is to treat the token as a pseudonymous identity — it IS stable, and
 * within one conversation `PERSON_1` really does mean one person. It must not become a
 * subject anyway, because **the vault is scoped to a conversation**: `PERSON_1` in Monday's
 * chat and `PERSON_1` in Friday's are different people, and a global subject would merge
 * strangers under one page and attribute one person's decisions to another. That is the same
 * reason `aliasMap` refuses a bare token two people could claim — here it is guaranteed
 * rather than possible.
 *
 * So the placeholder is dropped from subject candidacy, and `curate.js` counts what was
 * dropped so the loss is REPORTED rather than silent. Never resolved against a vault into
 * anything derived and persisted, either: that would put the PII back on disk in a second
 * place, which is the one thing redaction exists to prevent.
 *
 * The pattern is duplicated from `@chatpanel/pii` rather than imported — this package ships
 * zero dependencies so the bridge can vendor it file by file, the same constraint that makes
 * the entitlement JWK live in two clients. `CLAUDE.md` lists `[[TYPE_n]]` as a wire contract
 * that only changes additively, and the extension (which vendors both) carries the drift
 * guard that fails when these two stop agreeing.
 */
export const REDACTION_TOKEN_TYPES = Object.freeze([
  'PERSON', 'ORG', 'LOCATION', 'ADDRESS', 'EMAIL', 'PHONE', 'ID', 'SSN', 'IBAN',
  'CREDITCARD', 'CARD', 'POST', 'FAC', 'GROUP', 'NRP', 'ENTITY', 'KEY', 'SECRET',
  'TERM', 'PII', 'OTHER',
]);

const BARE_TOKEN_RE = /^([A-Z][A-Z0-9]*)_\d+$/;
const unwrap = (v) => String(v ?? '').trim().replace(/^\[{1,2}|\]{1,2}$/g, '');

/**
 * Is this BARE string one of the redaction placeholders?
 *
 * Matched against the type vocabulary rather than the `[A-Z]+_\d+` shape, and everywhere —
 * inside brackets too. The shape alone eats real subjects: `[[Q3_2026]]` and `[[PHASE_2]]`
 * are links people genuinely write, and silently dropping them would trade one invisible bug
 * for another. A custom dictionary type is the accepted gap: it is user-chosen, so filing it
 * is a name the user picked, not a stranger's identity.
 *
 * Bracket-tolerant, because a wikilink parser has already stripped them by the time we ask,
 * and a model echoing a placeholder into JSON routinely mangles them.
 */
export function isRedactionToken(value) {
  const m = BARE_TOKEN_RE.exec(unwrap(value));
  return !!m && REDACTION_TOKEN_TYPES.includes(m[1]);
}
