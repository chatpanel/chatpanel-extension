// GENERATED — do not edit.
// Source of truth: chatpanel-events/synthesis.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// SYNTHESIS — the first class-C claims: prose about a subject, written by a model.
//
// Everything a brief said until now was class R: a restatement of something a record
// already held, with nothing to review. This is the layer the wiki pattern is actually
// about — "what was decided about Atlas, and when did it change" — and it is exactly the
// layer the community warned about: agent writing nobody reviewed compounds into confident
// nonsense that a lint pass cannot tell apart from truth six months on (C2).
//
// So two rules do all the defending, and both are enforced here rather than promised:
//
//   I-K1  EVERY CLAIM CITES A RECORD IT WAS SHOWN. The model sees excerpts labelled with
//         their ids and must attach at least one to each claim. A claim citing nothing, or
//         citing an id that was not in the excerpt set, is REFUSED — not downgraded, not
//         flagged, refused — because a citation a reader cannot open is worse than no claim.
//   I-K3  NOTHING HERE PROMOTES. `claimsFromSynthesis` produces claims in state `proposed`
//         and `promotion.js` is the only path to `promoted`. There is no flag to skip it.
//
// The model call itself is not made here (no network, per the package rule). This module
// owns the SHAPE — one schema, one prompt, one parser — so the extension, the gateway and a
// desktop client ask the same question and read the answer the same way. It is written as
// a single appointment on purpose: a team appointment (W7 — drafters that must agree) has
// the same contract, with `converge()` in promotion.js deciding what to propose.

import { defineSchema, describeSchema } from './structured.js';

export const MAX_SYNTHESIS_CLAIMS = 8;
export const MAX_CLAIM_CHARS = 240;
export const MAX_EXCERPT_CHARS = 1200;
export const MAX_EXCERPTS = 24;

export const SYNTHESIS_SCHEMA = defineSchema({
  name: 'brief_synthesis',
  purpose: 'What the records establish about one subject, as separate cited claims.',
  fields: {
    claims: {
      type: 'object[]', maxItems: MAX_SYNTHESIS_CLAIMS,
      describe: 'the things the records establish about the subject — decisions, roles, status, changes — one per entry, each cited',
      fields: {
        text: { type: 'string', required: true, max: MAX_CLAIM_CHARS, describe: 'one specific claim in plain prose, past tense for events, present for standing facts' },
        refs: { type: 'string[]', required: true, maxItems: 6, describe: 'the record ids (exactly as labelled, e.g. meeting:m_12) that support this claim — at least one, only ones you were shown' },
        when: { type: 'string', max: 10, describe: 'YYYY-MM-DD of the record that establishes it, if one does' },
      },
    },
    summary: { type: 'string', max: 600, describe: 'two or three sentences of what a colleague should know about this subject right now' },
  },
  // "The records do not establish anything beyond what is already listed" is a legitimate
  // answer and must not be read as a failure — read as one, a caller might fall back to the
  // model's prose without the schema, which is the exact unstructured path this replaces.
  nothing: { claims: [], summary: '' },
});

/**
 * The prompt. The subject, what the deterministic layer already says (so the model adds to
 * it rather than restating it), and the excerpts it may cite — each labelled with the id it
 * must use. Excerpts are capped per record and in count, because this is a bounded call by
 * design (I-K4): a subject with two hundred records gets its most recent two dozen, and a
 * later pass can take the rest.
 */
export function synthesisPrompt({ subject, existing = [], excerpts = [] } = {}) {
  const name = String(subject?.name || 'the subject');
  const kind = String(subject?.kind || 'subject');
  const shown = excerpts.slice(0, MAX_EXCERPTS);
  const lines = [
    `Subject: ${name} (${kind})${subject?.aliases?.length ? ` — also written as ${subject.aliases.join(', ')}` : ''}.`,
    '',
    'Already established (do not repeat these):',
    ...(existing.length ? existing.map((c) => `- ${c}`) : ['- nothing yet']),
    '',
    `Records you may cite (${shown.length}). Cite ONLY these ids, exactly as written:`,
    ...shown.map((e) => `[${e.id}] ${e.title || ''}${e.date ? ` (${e.date})` : ''}\n${String(e.text || '').slice(0, MAX_EXCERPT_CHARS)}`),
    '',
    'Write what these records ESTABLISH about the subject: decisions, ownership, status, and',
    'anything that changed over time (say what it was before and after). Every claim must cite',
    'at least one of the ids above. If the records establish nothing beyond what is already',
    'listed, return no claims.',
    '',
    describeSchema(SYNTHESIS_SCHEMA),
  ];
  return lines.join('\n');
}

/**
 * The model's answer → claims a brief could carry, with the refusals listed.
 *
 * `knownIds` is the set of ids the model was shown. A claim citing anything outside it is
 * refused whole — the model invented or misremembered a citation, and a claim we cannot
 * trace is a claim we cannot keep (I-K1). `hashOf(id)` gives the record's drift hash so the
 * ref can later say "this record changed since I cited it".
 *
 * Returns claims in state `proposed`, class C. There is no argument that produces
 * `promoted`; that is promotion.js's job and nobody else's (I-K3).
 */
export function claimsFromSynthesis(value, { knownIds, hashOf = () => 'unhashed', now = 0, newId = null } = {}) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const out = [];
  const refused = [];
  let n = 0;
  const id = () => (newId ? newId() : `s${now}-${(n += 1)}`);
  for (const raw of value?.claims || []) {
    const text = String(raw?.text || '').trim();
    const refs = [...new Set((raw?.refs || []).map((r) => String(r || '').trim()).filter(Boolean))];
    if (!text) { refused.push({ text, why: 'empty' }); continue; }
    if (!refs.length) { refused.push({ text, why: 'no citation' }); continue; }
    const unknown = refs.filter((r) => !known.has(r));
    if (unknown.length) { refused.push({ text, why: `cites a record it was not shown: ${unknown.join(', ')}` }); continue; }
    out.push({
      id: id(),
      kind: 'synthesis',
      text: text.slice(0, MAX_CLAIM_CHARS),
      refs: refs.map((r) => {
        const idx = r.indexOf(':');
        return { kind: r.slice(0, idx), id: r.slice(idx + 1), hash: hashOf(r) };
      }),
      when: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.when || '')) ? raw.when : '',
      firstSeen: now,
      lastConfirmed: now,
      confidence: 0.6, // a model's read, not a record's word — lower than any class-R claim
      cls: 'C',
      state: 'proposed',
    });
  }
  return { claims: out, summary: String(value?.summary || '').trim().slice(0, 600), refused };
}
