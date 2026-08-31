// GENERATED — do not edit.
// Source of truth: chatpanel-events/memory.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

/**
 * MEMORY — the small set of durable facts about the user that every model should already know.
 *
 * ChatPanel remembers conversations, meetings and notes, and can search all of them. What it
 * could not do is KNOW anything. Told "call me Alex, and never open with a preamble", the next
 * turn — let alone the next agent, or Codex over MCP — started from zero, because the only way
 * a fact survived was for someone to search for it, and nobody searches for their own name.
 *
 * Memory is the opposite of history by design. History is large, retrieved, and about events.
 * Memory is SMALL, ambient, and about standing truths — so it can be carried into every turn
 * instead of looked up, and so a person can read the whole of it in one screen and correct it.
 * That size limit is the feature: a memory that grows without bound becomes a second corpus,
 * and a second corpus needs search, and then nothing is ambient any more.
 *
 * Four properties make it work the same everywhere:
 *
 *   ONE VOCABULARY. Five kinds, closed set. `identity` and `preference` are AMBIENT — they
 *   apply to every turn, so they are carried unconditionally. `project`, `fact` and
 *   `reference` are RETRIEVED, because "the staging cluster is in Frankfurt" is only worth
 *   tokens on a turn that mentions it. One rule decides which, in `recall`, so the extension,
 *   the gateway and a future mobile client cannot disagree about what the model was told.
 *
 *   CAPTURE IS DETERMINISTIC. `candidatesFrom` reads a string. No model call, no network, no
 *   latency, on every user message — which is the only reason it can run on every user
 *   message. It separates what the user COMMANDED ("remember that…") from what they merely
 *   REVEALED ("I prefer…"), because those deserve different answers: the first is consent,
 *   the second is a guess, and a guess must be offered rather than acted on.
 *
 *   WRITES RECONCILE, THEY DO NOT ACCUMULATE. Saying "call me Alex" twice must leave one
 *   memory, and saying "actually, call me Sam" must leave one memory with the new value and
 *   the old one recoverable. `reconcile` decides create/update/duplicate against what is
 *   already stored; a client that just pushes rows produces a list nobody can read by week
 *   two.
 *
 *   THE PROMPT FORM IS SHARED. `memoryBlock` is the one rendering. If the extension wrote its
 *   own the model would be told something subtly different depending on which surface the
 *   user typed into, and the bug would be invisible.
 *
 * Class R: pure, dependency-free, no I/O. Persistence is the host's (chrome.storage in the
 * extension, an encrypted file in the gateway) — the same split as `store.js`.
 */

export const MEMORY_VERSION = 1;

/**
 * The closed vocabulary. Deliberately five: enough that a memory's kind tells you how to
 * treat it, few enough that a person choosing one does not have to think.
 *
 * `ambient` is the load-bearing bit — it is not a label, it is the retrieval rule.
 */
export const MEMORY_KINDS = Object.freeze({
  identity: { label: 'Identity', ambient: true, hint: 'Who the user is — name, role, pronouns, language, timezone.' },
  preference: { label: 'Preference', ambient: true, hint: 'How they want things done — tone, format, defaults, things never to do.' },
  project: { label: 'Project', ambient: false, hint: 'Ongoing work, goals and constraints not derivable from the material itself.' },
  fact: { label: 'Fact', ambient: false, hint: 'A durable fact about their world — systems, teams, environments, conventions.' },
  reference: { label: 'Reference', ambient: false, hint: 'A pointer to something external — a URL, a dashboard, a ticket, a doc.' },
});

export const MEMORY_KIND_NAMES = Object.freeze(Object.keys(MEMORY_KINDS));

/** Kinds carried on every turn regardless of what was said. */
export const AMBIENT_KINDS = Object.freeze(MEMORY_KIND_NAMES.filter((k) => MEMORY_KINDS[k].ambient));

/**
 * Bounds. A memory longer than this is a note, and there is already a notes feature; a store
 * larger than this is a corpus, and there is already a history feature. Both limits exist to
 * stop memory turning into the thing next to it.
 */
export const MAX_MEMORY_CHARS = 280;
export const MIN_MEMORY_CHARS = 3;
export const DEFAULT_MAX_MEMORIES = 200;
/** Prompt budget for the injected block. ~100 tokens; enough for a readable standing brief. */
export const DEFAULT_BLOCK_CHARS = 1200;

export class MemoryError extends Error {
  constructor(message) { super(message); this.name = 'MemoryError'; }
}

// --------------------------------------------------------------------------
// The record
// --------------------------------------------------------------------------

/**
 * Normalize anything memory-shaped into the canonical record. Throws MemoryError on input
 * that cannot be a memory — callers get one validation path rather than each inventing
 * their own defaults.
 *
 * `now` and `newId` are injected for the same reason they are in `event.js`: a pure module
 * that reads the clock cannot be replayed or tested.
 *
 * @returns {{
 *   id: string, v: number, text: string, kind: string, scope: string, key: string,
 *   tags: string[], pinned: boolean, source: object, confidence: number,
 *   createdAt: number, updatedAt: number, usedAt: number, useCount: number,
 *   expiresAt: number|null, history: {text: string, at: number}[]
 * }}
 */
export function normalizeMemory(input = {}, { now = 0, newId = null } = {}) {
  const text = collapse(input.text);
  if (text.length < MIN_MEMORY_CHARS) throw new MemoryError('a memory needs text');
  if (text.length > MAX_MEMORY_CHARS) {
    throw new MemoryError(`a memory must be at most ${MAX_MEMORY_CHARS} characters — save longer material as a note`);
  }
  const kind = MEMORY_KINDS[input.kind] ? input.kind : 'fact';
  const at = Number(input.createdAt) || Number(now) || 0;
  return {
    id: String(input.id || (newId ? newId() : '') || ''),
    v: MEMORY_VERSION,
    text,
    kind,
    // Free-form so a client can scope to an agent, a workspace or a site without this module
    // enumerating surfaces it cannot know about. 'global' means every turn everywhere.
    scope: String(input.scope || 'global'),
    key: memoryKey(text),
    // Derived, not asked for — see slotOf. An explicit slot still wins.
    slot: collapse(input.slot).toLowerCase() || slotOf(text),
    tags: [...new Set((input.tags || []).map((t) => collapse(t).toLowerCase()).filter(Boolean))].slice(0, 8),
    pinned: !!input.pinned,
    // WHERE IT CAME FROM, always. A memory the user cannot trace is a memory they cannot
    // trust, and the first thing anyone asks of a wrong one is "when did I say that".
    source: {
      via: String(input.source?.via || 'user'),      // user | agent | import | mcp
      surface: String(input.source?.surface || ''),  // chat | notes | meeting | mcp | settings
      ref: String(input.source?.ref || ''),          // conversation/meeting/note id
      agent: String(input.source?.agent || ''),      // which model or CLI proposed it
    },
    // How sure the CAPTURE was, not how true the fact is. An explicit command is 1.
    confidence: clamp01(input.confidence == null ? 1 : Number(input.confidence)),
    createdAt: at,
    updatedAt: Number(input.updatedAt) || at,
    usedAt: Number(input.usedAt) || 0,
    useCount: Math.max(0, Math.floor(Number(input.useCount) || 0)),
    expiresAt: input.expiresAt ? Number(input.expiresAt) : null,
    // Bounded supersession ledger — "you used to say X" without an unbounded audit log.
    history: (input.history || []).slice(-5).map((h) => ({ text: collapse(h.text), at: Number(h.at) || 0 })),
  };
}

/** True when `rec` is a well-formed memory. Never throws — for filtering a loaded store. */
export function isValidMemory(rec) {
  try { normalizeMemory(rec, { now: rec?.createdAt || 1 }); return !!rec?.id; } catch { return false; }
}

/**
 * The identity of a FACT rather than of a record — two phrasings of the same standing truth
 * should collide here so `reconcile` can supersede rather than accumulate.
 *
 * Lowercased, stripped of punctuation and of the framing words people vary freely ("I always
 * prefer" / "prefer"), then the remaining words sorted and deduped. Sorting is safe precisely
 * because this is a dedup key and never a display value: "deploy on fridays" and "on fridays,
 * deploy" are the same standing fact, and treating them as two is the failure this prevents.
 */
export function memoryKey(text) {
  const words = collapse(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !KEY_STOPWORDS.has(w));
  return [...new Set(words)].sort().join(' ');
}

const KEY_STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'im', 'me', 'my', 'mine', 'we', 'our', 'us', 'you', 'your',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'that', 'this', 'it',
  'please', 'always', 'usually', 'generally', 'really', 'just', 'very', 'so',
  'remember', 'note', 'noting', 'user', 'prefer', 'prefers', 'preferred', 'like', 'likes',
]);

/**
 * THE SLOT A MEMORY FILLS, when it fills one — derived from the text itself.
 *
 * Token overlap cannot see that "Goes by Alex" and "Goes by Sam" are the same fact with a new
 * value: they share two words out of four, which is exactly what two unrelated memories look
 * like. So changing your name produced a SECOND memory and the model was told both.
 *
 * A slot is the subject a statement is about. Two memories with the same slot are one memory,
 * whatever their words, so the later one supersedes. Deriving it from the text rather than
 * asking the caller means it works identically for a captured phrase and for a `memory` tool
 * call from some agent that has never heard of slots.
 *
 * Returns '' when a statement is not slot-shaped ("Deploys on Fridays"), which is most of
 * them — those fall back to key and similarity matching.
 */
export function slotOf(text) {
  const t = collapse(text).toLowerCase().replace(/^the\s+/, '');
  // Identity phrasings all name the same slot, or the user's name lives in three places.
  if (/^(?:goes by|name is|is called|called)\b/.test(t)) return 'name';
  if (/^pronouns\b/.test(t)) return 'pronouns';
  // "<subject> is/are <value>" — the general form. Bounded to a short subject so a whole
  // sentence containing "is" somewhere does not become a slot that swallows its neighbours.
  const m = /^(?:my\s+|their\s+)?([\p{L}\p{N}][\p{L}\p{N} '-]{0,28}?)\s+(?:is|are|was|were)\b/u.exec(t);
  if (!m) return '';
  const subject = m[1].split(/\s+/).filter((w) => !KEY_STOPWORDS.has(w)).join(' ');
  return subject.length >= 3 ? subject : '';
}

/** Token-set overlap, 0..1 — "prefers terse answers" vs "prefers terse replies". */
export function similarity(a, b) {
  const A = new Set(memoryKey(a).split(' ').filter(Boolean));
  const B = new Set(memoryKey(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/**
 * How much of the SHORTER phrase the longer one contains, 0..1. Different question from
 * `similarity`, and the right one for "forget the Frankfurt thing": a person names a memory by
 * one distinctive word, not by restating it, so a symmetric measure scores that near zero.
 */
export function containment(a, b) {
  const A = new Set(memoryKey(a).split(' ').filter(Boolean));
  const B = new Set(memoryKey(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/** Above this, two memories are the same standing fact stated differently. */
export const SAME_FACT = 0.8;

// --------------------------------------------------------------------------
// Capture — reading a message for things worth keeping
// --------------------------------------------------------------------------

/**
 * COMMANDS. The user is addressing the assistant and telling it to keep something. The capture
 * group is the fact itself, so "remember that I deploy on Fridays" stores "I deploy on
 * Fridays" and not the instruction wrapping it.
 *
 * Each carries the kind it implies, because "call me Alex" is an identity and "from now on,
 * be terse" is a preference, and making the user pick afterwards is a step they should not
 * have to take.
 */
const COMMANDS = [
  { re: /^(?:please\s+)?(?:remember|memorize|memorise)(?:\s+that|\s+this)?[:,]?\s+(.+)$/i, kind: 'fact' },
  { re: /^(?:please\s+)?(?:keep in mind|bear in mind|don'?t forget|do not forget)(?:\s+that)?[:,]?\s+(.+)$/i, kind: 'fact' },
  { re: /^(?:please\s+)?(?:make a note|note)(?:\s+that|\s+of)[:,]?\s+(.+)$/i, kind: 'fact' },
  { re: /^(?:from now on|going forward|in future|in the future|henceforth)[:,]?\s+(.+)$/i, kind: 'preference' },
  { re: /^(?:call me|i go by|refer to me as)\s+(.+)$/i, kind: 'identity', rebuild: (m) => `Goes by ${trimEnd(m[1])}` },
  { re: /^my name(?:'s| is)\s+(.+)$/i, kind: 'identity', rebuild: (m) => `Name is ${trimEnd(m[1])}` },
  { re: /^(?:always|never)\s+(.+)$/i, kind: 'preference', rebuild: (m, raw) => sentence(raw) },
];

/**
 * REVEALS. Not addressed to the assistant at all — the user simply said something durable
 * about themselves in passing. These are OFFERED, never saved, because the inference is
 * exactly the kind that is right often enough to be useful and wrong often enough to be
 * insulting if acted on silently.
 */
const REVEALS = [
  { re: /^i (?:prefer|like|want|need)\s+(.+)$/i, kind: 'preference', confidence: 0.7 },
  { re: /^i (?:hate|dislike|don'?t like|do not like|can'?t stand)\s+(.+)$/i, kind: 'preference', confidence: 0.7 },
  { re: /^i(?:'m| am)(?: a| an| the)?\s+(.+)$/i, kind: 'identity', confidence: 0.6 },
  { re: /^i (?:work|working) (?:on|at|with)\s+(.+)$/i, kind: 'project', confidence: 0.6 },
  { re: /^i(?:'m| am) (?:working|building|writing) (?:on\s+)?(.+)$/i, kind: 'project', confidence: 0.6 },
  { re: /^(?:we|our team|my team) (?:use|uses|are using|run|runs|deploy|deploys)\s+(.+)$/i, kind: 'fact', confidence: 0.6 },
  { re: /^my (?:\w+\s){0,2}?(?:is|are)\s+(.+)$/i, kind: 'fact', confidence: 0.55 },
];

/** Removal is a command too, and it must be recognised or "forget that" gets stored as a fact. */
const FORGETS = [
  /^(?:please\s+)?forget(?:\s+that|\s+about)?[:,]?\s+(.+)$/i,
  /^(?:please\s+)?(?:stop remembering|no longer remember|un-?remember)[:,]?\s+(.+)$/i,
];

/**
 * A trigger word inside a QUESTION is not an instruction — "do you remember what we decided?"
 * asks for recall, and storing it as a fact is the single most obvious way to make this
 * feature look broken. Likewise "I can't remember" is a complaint, not a command.
 */
const NOT_A_COMMAND = /(?:^|\s)(?:do|does|did|can|could|would|will|what|when|where|who|why|how|are|is)\s+(?:you|i|we|it)\b/i;
const NEGATED = /\b(?:can'?t|cannot|don'?t|do not|couldn'?t|never|didn'?t)\s+(?:seem to\s+)?(?:remember|recall|forget)\b/i;

/**
 * Read one user message for things worth keeping.
 *
 * Returns candidates in the order found. `explicit: true` means the user issued a command and
 * the host may save it without asking; `explicit: false` means offer it and let them tap.
 * That distinction is the whole capture policy, and it lives here rather than in a client so
 * the panel, the gateway and a mobile app cannot each pick a different one.
 *
 * @param text  one user message.
 * @param opts.maxCandidates cap per message (default 3) — a wall of chips is not a prompt.
 * @param opts.includeReveals set false for surfaces with nowhere to show an offer.
 * @returns {{op: 'remember'|'forget', text: string, kind: string, confidence: number,
 *            explicit: boolean, trigger: string}[]}
 */
export function candidatesFrom(text, { maxCandidates = 3, includeReveals = true } = {}) {
  const out = [];
  const raw = String(text || '');
  // Fenced code is material, not speech. A README line that happens to start "I prefer" is
  // not the user telling us anything.
  const speech = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');

  for (const line of splitStatements(speech)) {
    if (out.length >= maxCandidates) break;
    if (line.length < MIN_MEMORY_CHARS) continue;
    if (NEGATED.test(line)) continue;

    let matched = false;
    for (const re of FORGETS) {
      const m = re.exec(line);
      if (!m) continue;
      const body = clip(trimEnd(m[1]));
      if (body.length >= MIN_MEMORY_CHARS) {
        out.push({ op: 'forget', text: body, kind: 'fact', confidence: 1, explicit: true, trigger: 'forget' });
        matched = true;
      }
      break;
    }
    if (matched) continue;

    // A question mark alone is not disqualifying — "remember that the demo is Friday?" is a
    // command with a tag. It is the interrogative SHAPE that rules a command out.
    if (NOT_A_COMMAND.test(line)) continue;

    for (const { re, kind, rebuild } of COMMANDS) {
      const m = re.exec(line);
      if (!m) continue;
      const body = clip(rebuild ? rebuild(m, line) : sentence(trimEnd(m[1])));
      if (body.length >= MIN_MEMORY_CHARS) {
        out.push({ op: 'remember', text: body, kind, confidence: 1, explicit: true, trigger: 'command' });
        matched = true;
      }
      break;
    }
    if (matched || !includeReveals) continue;

    for (const { re, kind, confidence } of REVEALS) {
      if (!re.test(line)) continue;
      const body = clip(sentence(line));
      // Two words minimum: "I am tired" is durable-looking and worthless. The floor is crude
      // on purpose — the cost of a bad offer is one ignored chip, and the cost of a clever
      // filter is a fact the user watched get dropped.
      if (body.split(/\s+/).length >= 3) {
        out.push({ op: 'remember', text: body, kind, confidence, explicit: false, trigger: 'reveal' });
      }
      break;
    }
  }
  return out.slice(0, maxCandidates);
}

// --------------------------------------------------------------------------
// Reconcile — what a write does to what is already there
// --------------------------------------------------------------------------

/**
 * Decide what saving `incoming` means against the memories already held.
 *
 *   duplicate — the same fact, said the same way. Nothing to do but touch it.
 *   update    — the same fact, restated or changed. Supersede in place, keep the old text.
 *   create    — genuinely new.
 *
 * There is deliberately no `conflict`. Two contradictory statements cannot be told apart from
 * a correction without understanding the sentence, and a memory system that asks "did you
 * mean to change your mind?" is a memory system people turn off. The later statement wins and
 * the earlier one stays visible in `history`.
 *
 * @returns {{action: 'create'|'update'|'duplicate', record: object, replaces: object|null}}
 */
export function reconcile(memories, incoming, { now = 0, newId = null } = {}) {
  const next = normalizeMemory(incoming, { now, newId });
  const pool = (memories || []).filter((m) => m && m.scope === next.scope);

  // Slot first: it is the only one of the three that can recognise a CHANGED VALUE, which is
  // what a correction is. Then exact key, then near-identical wording.
  const match = (next.slot && pool.find((m) => m.slot === next.slot))
    || pool.find((m) => m.key === next.key)
    || pool.find((m) => m.kind === next.kind && similarity(m.text, next.text) >= SAME_FACT);

  if (!match) return { action: 'create', record: next, replaces: null };

  if (collapse(match.text).toLowerCase() === next.text.toLowerCase()) {
    // Restating a memory is a signal about it: it is still true, and it is on the user's mind.
    return {
      action: 'duplicate',
      record: { ...match, updatedAt: Number(now) || match.updatedAt, useCount: match.useCount + 1 },
      replaces: match,
    };
  }

  return {
    action: 'update',
    record: {
      ...match,
      text: next.text,
      key: next.key,
      slot: next.slot,
      kind: next.kind,
      tags: next.tags.length ? next.tags : match.tags,
      confidence: next.confidence,
      source: next.source,
      updatedAt: Number(now) || match.updatedAt,
      history: [...match.history, { text: match.text, at: match.updatedAt }].slice(-5),
    },
    replaces: match,
  };
}

/**
 * Which stored memories a "forget X" refers to. Matches by id, then by exact key, then by
 * similarity — a person says "forget the Frankfurt thing", not a uuid.
 */
export function matchForForget(memories, query, { limit = 5 } = {}) {
  const q = collapse(query);
  if (!q) return [];
  const byId = (memories || []).filter((m) => m.id === q);
  if (byId.length) return byId;
  const key = memoryKey(q);
  return (memories || [])
    .map((m) => ({ m, s: m.key === key ? 1 : Math.max(similarity(m.text, q), containment(q, m.text)) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.m);
}

// --------------------------------------------------------------------------
// Recall — what the model is told, this turn
// --------------------------------------------------------------------------

/**
 * Choose the memories for one turn, within a character budget.
 *
 * Ambient kinds (identity, preference) come first and unconditionally: they are how the user
 * wants to be spoken to, and a turn that fails to mention their name is still a turn where
 * their name applies. Everything else is scored against the turn's text — a project memory
 * earns its tokens only when the turn is about it.
 *
 * Pinned always wins, of any kind. That is the user's explicit override of this whole ranking.
 *
 * @param memories all stored memories.
 * @param opts.text the turn's text (user message, or the question for a tool call).
 * @param opts.scopes which scopes apply — 'global' plus, say, `agent:claude-code`.
 * @param opts.maxChars budget for the rendered block.
 * @returns the chosen memories, most important first.
 */
export function recall(memories, {
  text = '', scopes = ['global'], kinds = null, now = 0,
  limit = 24, maxChars = DEFAULT_BLOCK_CHARS, includeAmbient = true,
} = {}) {
  const scopeSet = new Set(scopes.length ? scopes : ['global']);
  const terms = new Set(memoryKey(text).split(' ').filter(Boolean));

  const live = (memories || [])
    .filter((m) => m && m.text)
    .filter((m) => scopeSet.has(m.scope))
    .filter((m) => !kinds || kinds.includes(m.kind))
    .filter((m) => !m.expiresAt || !now || m.expiresAt > now);

  const scored = live.map((m) => {
    const words = new Set(m.key.split(' ').filter(Boolean));
    let overlap = 0;
    for (const w of words) if (terms.has(w)) overlap += 1;
    const relevance = words.size ? overlap / words.size : 0;
    const ambient = includeAmbient && MEMORY_KINDS[m.kind]?.ambient;
    // Recency and use are TIE-BREAKS, not drivers. A fact does not become truer because it
    // was mentioned recently, but between two equally relevant ones the live one is the
    // better guess.
    const freshness = now && m.updatedAt ? Math.max(0, 1 - (now - m.updatedAt) / YEAR) : 0;
    const used = Math.min(1, m.useCount / 10);
    return {
      m,
      keep: m.pinned || ambient || relevance > 0,
      score: (m.pinned ? 100 : 0) + (ambient ? 10 : 0) + relevance * 8 + freshness + used,
    };
  });

  const out = [];
  let chars = 0;
  for (const { m, keep, score } of scored.filter((s) => s.keep).sort((a, b) => b.score - a.score)) {
    if (out.length >= limit) break;
    const cost = m.text.length + m.kind.length + 6;
    if (chars + cost > maxChars && out.length) break;
    chars += cost;
    out.push(m);
    void score;
  }
  return out;
}

const YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * The ONE prompt rendering. Every surface that puts memory in front of a model uses this, so
 * "what the model was told" is a single, reviewable string rather than per-client prose.
 *
 * Returns '' for an empty set — callers can concatenate unconditionally.
 */
export function memoryBlock(memories, { heading = 'What you already know about this user', maxChars = DEFAULT_BLOCK_CHARS } = {}) {
  const list = (memories || []).filter((m) => m && m.text);
  if (!list.length) return '';
  const lines = [];
  let chars = 0;
  for (const m of list) {
    const line = `- (${m.kind}) ${m.text}`;
    if (chars + line.length > maxChars && lines.length) break;
    chars += line.length + 1;
    lines.push(line);
  }
  return [
    `## ${heading}`,
    'Saved by the user in ChatPanel and true across conversations, agents and devices.',
    'Apply them without being asked and without announcing them.',
    ...lines,
    'If the user states something durable about themselves, their preferences or their work,'
    + ' save it with the `memory` tool. If they correct one of these, update it — do not just agree.',
  ].join('\n');
}

/** Mark memories as used this turn. Recall quality depends on it, so it is not optional. */
export function markUsed(memories, ids, { now = 0 } = {}) {
  const set = new Set(ids || []);
  return (memories || []).map((m) => (set.has(m.id)
    ? { ...m, usedAt: Number(now) || m.usedAt, useCount: m.useCount + 1 }
    : m));
}

/**
 * Drop what has expired, then hold the store to `max` by evicting the least valuable.
 *
 * Eviction order is the inverse of value: never pinned, never ambient, then least used and
 * least recently touched. Returns both halves so a client can TELL the user what went rather
 * than silently shrinking their memory.
 */
export function pruneMemories(memories, { now = 0, max = DEFAULT_MAX_MEMORIES } = {}) {
  const all = (memories || []).filter(Boolean);
  const expired = now ? all.filter((m) => m.expiresAt && m.expiresAt <= now) : [];
  let kept = expired.length ? all.filter((m) => !expired.includes(m)) : all;
  const dropped = [...expired];

  if (kept.length > max) {
    const value = (m) => (m.pinned ? 3 : 0) + (MEMORY_KINDS[m.kind]?.ambient ? 1 : 0);
    const ranked = [...kept].sort((a, b) => value(b) - value(a)
      || b.useCount - a.useCount
      || (b.usedAt || b.updatedAt) - (a.usedAt || a.updatedAt));
    dropped.push(...ranked.slice(max));
    kept = ranked.slice(0, max);
  }
  return { kept, dropped };
}

// --------------------------------------------------------------------------
// The tool contract — one definition, every client
// --------------------------------------------------------------------------

/**
 * The `memory` tool as the model sees it, shared by the extension's turn toolset and the
 * gateway's MCP server. A second copy would drift, and the drift would be a model that
 * behaves differently in Claude Code than in the side panel for no reason a user could see.
 *
 * One tool with an `action`, not four tools: memory is a small feature and four schemas
 * resident on every turn would cost more than the memories themselves.
 */
export const MEMORY_TOOL_SPEC = Object.freeze({
  name: 'memory',
  description:
    "Save, update or remove a durable fact about the USER in ChatPanel — carried into every "
    + 'future conversation, on every model and agent. Use it the moment they state a standing '
    + 'preference ("always be terse"), an identity fact ("call me Alex"), or a constraint about '
    + 'their work that will still be true next week. Do NOT use it for one-off task details, '
    + 'anything already obvious from the conversation, or content that belongs in a note. '
    + 'Keep each memory one short self-contained sentence. Use `forget` when the user says '
    + 'something is no longer true, and `list` to see what is already stored before adding.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget', 'list'], description: 'What to do.' },
      text: { type: 'string', description: `The fact, as one short sentence written in the third person ("Prefers terse answers"). Max ${MAX_MEMORY_CHARS} characters. Required for remember; for forget, the memory to drop (its text or id).` },
      kind: { type: 'string', enum: MEMORY_KIND_NAMES, description: MEMORY_KIND_NAMES.map((k) => `${k}: ${MEMORY_KINDS[k].hint}`).join(' ') },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags for grouping.' },
    },
    required: ['action'],
  },
});

/** The system text that goes with the tool — why it exists, when NOT to reach for it. */
export function memoryToolSystem() {
  return [
    'You can give the user a memory that survives this conversation, this model and this device'
    + ' — call the `memory` tool.',
    'Save when they say something durable about themselves, how they want to be helped, or their'
    + ' ongoing work. Do not save task details, transient state, or anything they would not want'
    + ' repeated back to them in a month.',
    'Saving is a change to the user\'s own data: say in one short clause what you saved.',
  ].join(' ');
}

// --------------------------------------------------------------------------
// Versioning
// --------------------------------------------------------------------------

/**
 * Upcasters, empty at v1 — present so the first schema change is a one-line addition rather
 * than a migration nobody planned for. Same machinery as `upcast.js`.
 */
export const MEMORY_UPCASTERS = Object.freeze({});

export function upcastMemory(rec) {
  let out = rec;
  for (let v = Number(out?.v) || 1; v < MEMORY_VERSION; v += 1) {
    const up = MEMORY_UPCASTERS[v];
    if (!up) throw new MemoryError(`no upcaster from memory v${v}`);
    out = up(out);
  }
  return out;
}

// --------------------------------------------------------------------------
// Text helpers
// --------------------------------------------------------------------------

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);
const trimEnd = (s) => collapse(s).replace(/[.,;:!]+$/, '');
const clip = (s) => (s.length > MAX_MEMORY_CHARS ? `${s.slice(0, MAX_MEMORY_CHARS - 1).trimEnd()}…` : s);
const sentence = (s) => {
  const t = trimEnd(s);
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

/**
 * Split a message into the statements a trigger could apply to. Newlines and list bullets are
 * hard boundaries; sentence-ending punctuation is a soft one. Deliberately does NOT split on
 * commas — "remember that we ship on Friday, not Thursday" is one fact.
 */
function splitStatements(text) {
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) => collapse(line).replace(/^[-*+•]\s*|^\d+[.)]\s*/, '').split(/(?<=[.!?])\s+(?=[A-Z"'])/))
    .map(collapse)
    .filter(Boolean);
}
