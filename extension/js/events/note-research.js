// GENERATED — do not edit.
// Source of truth: chatpanel-events/note-research.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What a note is ABOUT, and whether a search result is actually related to it.
//
// A research pane beside a note answers two questions, and both are ranking problems rather
// than retrieval ones. The retrieval is already shared (`sources-retrieval.js`, `rrf.js`) and
// the corpus differs per client; what has to be identical is the JUDGEMENT — what words the
// query is built from, and which results are close enough to show.
//
// THE FAILURE THIS EXISTS TO PREVENT IS A PANE FULL OF PLAUSIBLE, UNRELATED THINGS. Any
// ranker returns its top N for any query, so a note containing "can you check the plan today"
// retrieves the user's whole history ranked by nothing. Every result looks like a result. The
// fix is two-sided: build the query from the note's content-bearing words, then require a real
// overlap before showing anything. **Empty is better than irrelevant** — an empty pane is read
// as "nothing yet", a full one as "these are related", and only one of those can be wrong.
//
// Extracted from the extension's `notes-util.js`, where it was already pure.

/**
 * Words that carry no topic, dropped from every query and every relevance test.
 *
 * Beyond ordinary stop-words this drops NOTE-META and AGENT noise — claude, codex, agent,
 * research, question, answer, summarize, https, www — because a note that says "ask Claude to
 * research this" would otherwise be judged to be ABOUT Claude and research, and would match
 * every other note in which the user typed the same sentence.
 */
const STOP = new Set(('the a an and or but for to of in on at by with from as is are was were be been being this that these those it its i you your my me we our they them he she his her can could would should will shall may might do does did done get got make made just like about into over under out up down off not no yes plan planning day today check please help note notes write writing claude code codex anthropic agent agents assistant research researcher question questions answer answers answered reply inline summary summarize source sources cite citation https http www com net org html url link links thing things using use used need needs want wants below above here there').split(/\s+/));

/**
 * The content-bearing terms of a query — lowercased words of 4+ characters that are not
 * stop-words. Used to judge relevance, so it is about what the text IS, not how it is phrased.
 */
export function salientTerms(q) {
  const out = new Set();
  for (const w of String(q || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) || []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * A note's TOPIC terms, most-repeated first — what a good search query is built from.
 *
 * Ranked by FREQUENCY rather than position, because the words at the top of a note are
 * usually its scaffolding ("Notes from the meeting about…") while the words it keeps
 * returning to are its subject. Ties break toward the longer, more specific term.
 */
export function topicTerms(text, n = 8) {
  const freq = new Map();
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([w]) => w);
}

/**
 * How related a result is to the query — 0 means "do not show this".
 *
 * A specific word (6+ characters) is worth twice a short one, and a WORKSPACE hit has to earn
 * its place: two matching terms, or one specific one. A single generic word in common is how
 * an unrelated note from March ends up in the pane.
 *
 * `web: true` relaxes that last rule, deliberately. A web result was fetched for a query the
 * user explicitly asked for, and re-gating it on snippet overlap drops valid hits whose
 * snippet happens to paraphrase — which is most of them.
 */
export function researchRelevance(card, salient, { web = false } = {}) {
  if (!salient || !salient.size) return 0;
  const hay = `${card?.title || ''} ${card?.snippet || ''}`.toLowerCase();
  let hits = 0;
  let specific = 0;
  let score = 0;
  for (const t of salient) {
    if (!hay.includes(t)) continue;
    hits += 1;
    score += t.length >= 6 ? 2 : 1;
    if (t.length >= 6) specific += 1;
  }
  if (!hits) return 0;
  if (web || hits >= 2 || specific >= 1) return score;
  return 0;
}

/** The web query for a note: its title plus its topic terms, capped at a sane length. */
export function webQuery(title, terms) {
  return [String(title || ''), [...(terms || [])].slice(0, 8).join(' ')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    .slice(0, 120);
}

/** One line of a source, flattened — enough to recognise it, not enough to read instead. */
export function researchSnippet(text = '', max = 160) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Rank and gate a set of candidate cards against the query.
 *
 * `{ kind, title, snippet, url, key }` in, the same objects out, ordered by relevance with
 * the irrelevant dropped and `dismissed` keys removed. Web cards keep their retrieval order
 * (the engine already ranked them and the user asked for them); workspace cards are re-ranked
 * on overlap, which is the gate described above.
 */
export function rankResearchCards(cards, query, { dismissed = null, web = false } = {}) {
  const salient = salientTerms(query);
  const skip = dismissed instanceof Set ? dismissed : new Set(dismissed || []);
  const kept = (Array.isArray(cards) ? cards : []).filter((c) => c && !skip.has(c.key ?? c.url));
  if (web) return kept;
  return kept
    .map((c) => ({ c, s: researchRelevance(c, salient) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/**
 * Merge the two lanes into one shelf.
 *
 * Web first when the user explicitly asked for a web search — that is what they pressed —
 * then the grounded workspace hits, deduped by key across both.
 */
export function mergeResearchLanes(webCards, localCards, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const c of [...(webCards || []), ...(localCards || [])]) {
    const k = c?.key ?? c?.url;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
