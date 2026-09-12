// GENERATED — do not edit.
// Source of truth: chatpanel-events/meeting-insights.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What a meeting settled, asked for and left open — read out of the summary it already has.
//
// The extension writes a meeting's summary as markdown with headings: "## Decisions",
// "## Action items", "## Open questions", whatever the model chose to call them. A client that
// wants an Insights view should not re-derive that with a second model call; the sections
// are there, and one parser that recognises the headings is the same on every client.
//
// Pure, forgiving of wording: a heading is matched by what it MEANS ("Decisions", "Agreed",
// "Outcomes" are one thing), bullets in any marker, numbered or not.

const KINDS = Object.freeze([
  { id: 'decisions', label: 'Decisions', re: /\b(decision|decided|agreed|agreement|outcome|resolution)s?\b/i },
  { id: 'actions', label: 'Action items', re: /\b(action|todo|to-do|next step|follow[- ]?up|task|owner)s?\b/i },
  { id: 'questions', label: 'Open questions', re: /\b(question|open item|unresolved|blocker|risk)s?\b/i },
]);

export const INSIGHT_KINDS = Object.freeze(KINDS.map((k) => ({ id: k.id, label: k.label })));

/** Split markdown into `[{ heading, level, items, text }]` on its headings. */
export function summarySections(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = { heading: '', level: 0, items: [], text: '' };
  const push = () => { if (cur.heading || cur.items.length || cur.text.trim()) out.push({ ...cur, text: cur.text.trim() }); };
  for (const raw of lines) {
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) { push(); cur = { heading: h[2].trim(), level: h[1].length, items: [], text: '' }; continue; }
    const b = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(raw);
    if (b) { cur.items.push(b[1]); continue; }
    if (raw.trim()) cur.text += (cur.text ? '\n' : '') + raw.trim();
  }
  push();
  return out;
}

/** Which insight a heading names, or null for a section that is neither. */
export function insightKindOf(heading) {
  const h = String(heading || '');
  for (const k of KINDS) if (k.re.test(h)) return k.id;
  return null;
}

/**
 * `{ decisions, actions, questions, other }` — each a list of `{ text, section }`; `other`
 * keeps the sections that were none of the three, so a view can still show them.
 */
export function meetingInsights(markdown) {
  const out = { decisions: [], actions: [], questions: [], other: [] };
  for (const s of summarySections(markdown)) {
    const kind = insightKindOf(s.heading);
    const items = s.items.length ? s.items : (s.text ? s.text.split('\n') : []);
    if (!kind) { if (s.heading || items.length) out.other.push(s); continue; }
    for (const text of items) out[kind].push({ text, section: s.heading });
  }
  return out;
}

/** True when the summary has at least one insight worth a tab. */
export function hasInsights(markdown) {
  const i = meetingInsights(markdown);
  return i.decisions.length + i.actions.length + i.questions.length > 0;
}
