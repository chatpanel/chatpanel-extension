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

// ── The meeting page's own read of the notes ──────────────────────────────────────
//
// The Insights tab on a meeting is five tiles — Summary, Topics, Key Moments, Shared Links,
// Action Items — and the extension's meetings page parsed them out of the notes with its own
// section matcher, badge reader and owner/due grammar, inline. The desktop's meeting page
// draws the same five tiles, so the parse is here: one answer to "which line is a risk".
//
// Different from `meetingInsights` above on purpose: that groups by what a line MEANS
// (decisions / actions / questions) for a dashboard count; this keeps the notes' own
// sections and the marks inside them (a [Risk] badge, an _(owner)_, a due date).

const isBullet = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
const stripBullet = (l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();

/** Plain text of a markdown-ish line: bold, italic, code and underscores unwrapped. */
export const demd = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2').replace(/`(.+?)`/g, '$1').replace(/_(.+?)_/g, '$1').trim();

export const NOTE_SECTIONS = Object.freeze(['summary', 'topics', 'moments', 'links', 'actions']);

/** Which of the five tiles a heading belongs to, or null. */
export function noteSectionKind(heading) {
  const s = String(heading || '').toLowerCase();
  if (/tl;?dr|summary|overview|recap/.test(s)) return 'summary';
  if (/topic|agenda/.test(s)) return 'topics';
  if (/key moment|moments|highlight|decision/.test(s)) return 'moments';
  if (/shared link|link|url|resource|reference/.test(s)) return 'links';
  if (/action|task|next step|to-?do|follow-?up/.test(s)) return 'actions';
  return null;
}

export const MOMENT_BADGES = Object.freeze(['decision', 'risk', 'question', 'highlight']);

/** A key moment's badge — `[Risk] the replica…` → risk — defaulting to highlight. */
export function momentBadge(text) {
  const t = String(text ?? '');
  // `**Risk:**` puts the colon before the closing stars; `**Risk**:` after. Both are a badge.
  // Anchored: a badge is how the line STARTS — "a plain highlight" is not a highlight badge.
  const m = t.match(/^\s*\*{0,2}\[?\s*(decision|risk|question|highlight)\s*\]?\s*:?\*{0,2}\s*:?/i);
  if (m) return { badge: m[1].toLowerCase(), text: t.slice(m.index + m[0].length).trim() };
  return { badge: 'highlight', text: t };
}

/**
 * The five tiles, read out of a meeting's notes.
 * -> { summary, topics: [], moments: [{ badge, text }], links: [], actions: [{ text, done, owner, due, lineIndex }], hasAny }
 *
 * An action item is `- [ ] text _(owner)_ — due` in any of its looser forms; a plain bullet
 * under the actions heading is an item with nothing known about it.
 */
export function parseMeetingNotes(md) {
  const out = { summary: '', topics: [], moments: [], links: [], actions: [], hasAny: false };
  const src = String(md ?? '');
  if (!src.trim()) return out;
  let cur = 'summary';
  const summaryParts = [];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { cur = noteSectionKind(h[1]); return; }
    if (!line.trim()) return;
    if (cur === 'summary') summaryParts.push(isBullet(line) ? stripBullet(line) : line.trim());
    else if (cur === 'topics') { if (isBullet(line)) out.topics.push(demd(stripBullet(line))); }
    else if (cur === 'moments') { if (isBullet(line)) { const b = momentBadge(stripBullet(line)); out.moments.push({ badge: b.badge, text: demd(b.text) }); } }
    else if (cur === 'links') {
      if (isBullet(line)) {
        const value = demd(stripBullet(line));
        if (value && !/^no shared links\.?$/i.test(value)) out.links.push(value);
      }
    } else if (cur === 'actions') {
      const m = line.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/);
      if (m) {
        let text = m[2].trim(); let owner = ''; let due = '';
        const ow = text.match(/_\(([^)]+)\)_|\(([^)]+)\)/);
        if (ow) { owner = (ow[1] || ow[2] || '').trim(); text = text.replace(ow[0], '').trim(); }
        const du = text.match(/[—-]\s*_?([^_]+?)_?\s*$/);
        if (du && /due|\d|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow|eod|eow|next/i.test(du[1])) {
          due = du[1].replace(/^due\s*/i, '').trim(); text = text.slice(0, du.index).trim();
        }
        out.actions.push({ text: demd(text), done: m[1].toLowerCase() === 'x', owner: demd(owner), due, lineIndex: idx });
      } else if (isBullet(line)) out.actions.push({ text: demd(stripBullet(line)), done: false, owner: '', due: '', lineIndex: idx });
    }
  });
  out.summary = demd(summaryParts.join(' ').trim());
  out.hasAny = !!(out.summary || out.topics.length || out.moments.length || out.links.length || out.actions.length);
  return out;
}

/** Action items grouped by owner, named owners first, "Unassigned" last. */
export function groupActionsByOwner(actions) {
  const groups = new Map();
  (actions || []).forEach((action, index) => {
    const owner = (action.owner || '').trim() || 'Unassigned';
    if (!groups.has(owner)) groups.set(owner, { owner, items: [] });
    groups.get(owner).items.push({ action, index });
  });
  return [...groups.values()].sort((a, b) => {
    if (a.owner === 'Unassigned') return 1;
    if (b.owner === 'Unassigned') return -1;
    return a.owner.localeCompare(b.owner);
  });
}
