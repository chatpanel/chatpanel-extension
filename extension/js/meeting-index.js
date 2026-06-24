// Client-side search + relationship engine for the Meetings dashboard.
// Pure functions, no deps: a BM25 full-text index over every meeting's
// title + notes + transcript, and a meeting⇄people graph for related-meeting
// discovery and visualization. Everything runs locally on already-decrypted
// records — nothing leaves the device.

const STOP = new Set((
  'the a an and or but of to in on at for with is are was were be been being it this that these those as i you he ' +
  'if am because need needs needed its lets let ' +
  'she they we us my your our their me him her them so no yes not do does did have has had will would can could ' +
  'should from by about into over under again further then once here there all any both each few more most other ' +
  'some such only own same than too very just dont cant couldnt didnt doesnt hadnt hasnt havent im ive id isnt ' +
  'youre were werent theyre thats theres whats wheres whos wont wouldnt shouldnt okay yeah uh um like really ' +
  'going get got know think mean right well say said also one two how what when where which who whom why'
).split(/\s+/));

const TITLE_STOP = new Set((
  'zoom meet google teams microsoft webex transcript transcripts transcription full light meeting meetings invitation ' +
  'invite room personal imported import recording recorded call video audio minutes minute min mins'
).split(/\s+/));

const WEAK_TITLE_TERMS = new Set(['one-on-one']);

function normalizeToken(raw) {
  let word = String(raw || '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/^['+_-]+|['+_-]+$/g, '');
  if (word.endsWith("'s")) word = word.slice(0, -2);
  const compact = word.replace(/['_-]+/g, '');
  if (/^[a-z]\+\+$/.test(word)) return word;
  if (compact.length < 2 || /^\d+$/.test(compact)) return '';
  if (STOP.has(word) || STOP.has(compact)) return '';
  return word.replace(/'/g, '');
}

export function tokenize(text) {
  const m = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'_+-]{1,}/g);
  if (!m) return [];
  return m.map(normalizeToken).filter(Boolean);
}

function titleTerms(title) {
  const normalized = String(title || '')
    .toLowerCase()
    .replace(/\b1\s+on\s+1\b/g, ' one-on-one ')
    .replace(/\b1\s*[:/-]\s*1\b/g, ' one-on-one ')
    .replace(/\bone\s+on\s+one\b/g, ' one-on-one ');
  return [...new Set(tokenize(normalized).filter((term) => !TITLE_STOP.has(term)))];
}

// docs: [{ id, text }] → an index usable by bm25Search().
export function buildIndex(docs) {
  const N = docs.length;
  const df = new Map();
  let totalLen = 0;
  const docInfo = docs.map((d) => {
    const terms = tokenize(d.text);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += terms.length;
    return { id: d.id, len: terms.length, tf };
  });
  const avgdl = totalLen / (N || 1);
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { N, avgdl, idf, docInfo };
}

// Okapi BM25. Returns [{ id, score }] sorted desc (score > 0 only).
export function bm25Search(idx, query, { k1 = 1.5, b = 0.75 } = {}) {
  const qterms = [...new Set(tokenize(query))];
  if (!qterms.length || !idx) return [];
  const out = [];
  for (const d of idx.docInfo) {
    let s = 0;
    for (const t of qterms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = idx.idf.get(t) || 0;
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / (idx.avgdl || 1))));
    }
    if (s > 0) out.push({ id: d.id, score: s });
  }
  out.sort((a, b2) => b2.score - a.score);
  return out;
}

// meetings: [{ id, title, platform, startedAt, people: string[], terms: string[] }]
// Builds the people⇄meeting graph + helpers for related discovery.
export function buildGraph(meetings) {
  const meetingsByPerson = new Map(); // person -> Set(meetingId)
  const byId = new Map();
  const titleTermsById = new Map();
  for (const m of meetings) {
    byId.set(m.id, m);
    titleTermsById.set(m.id, titleTerms(m.title));
    for (const p of m.people) {
      if (!meetingsByPerson.has(p)) meetingsByPerson.set(p, new Set());
      meetingsByPerson.get(p).add(m.id);
    }
  }

  // Meetings related to `id`: shared people (weight 2 each) + shared salient
  // terms (weight 1 each). Sorted by total weight.
  function relatedMeetings(id, { limit = 8 } = {}) {
    const m = byId.get(id);
    if (!m) return [];
    const score = new Map();
    const why = new Map();
    const whyTopics = new Map();
    const whyTitles = new Map();
    for (const p of m.people) {
      for (const mid of meetingsByPerson.get(p) || []) {
        if (mid === id) continue;
        score.set(mid, (score.get(mid) || 0) + 2);
        if (!why.has(mid)) why.set(mid, new Set());
        why.get(mid).add(p);
      }
    }
    const myTerms = new Set(m.terms || []);
    const myTitleTerms = new Set(titleTermsById.get(id) || []);
    for (const other of meetings) {
      if (other.id === id) continue;
      const sharedTopics = [];
      const seen = new Set();
      for (const t of other.terms || []) {
        if (!myTerms.has(t) || seen.has(t)) continue;
        seen.add(t);
        sharedTopics.push(t);
      }
      if (sharedTopics.length) {
        score.set(other.id, (score.get(other.id) || 0) + Math.min(sharedTopics.length, 5));
        whyTopics.set(other.id, sharedTopics);
      }
      const sharedTitleTerms = [];
      const seenTitles = new Set();
      for (const t of titleTermsById.get(other.id) || []) {
        if (!myTitleTerms.has(t) || seenTitles.has(t)) continue;
        seenTitles.add(t);
        sharedTitleTerms.push(t);
      }
      if (sharedTitleTerms.length && sharedTitleTerms.some((term) => !WEAK_TITLE_TERMS.has(term))) {
        score.set(other.id, (score.get(other.id) || 0) + Math.min(sharedTitleTerms.length, 4));
        whyTitles.set(other.id, sharedTitleTerms);
      }
    }
    return [...score.entries()]
      .map(([mid, w]) => ({
        id: mid,
        weight: w,
        sharedPeople: [...(why.get(mid) || [])],
        sharedTopics: whyTopics.get(mid) || [],
        sharedTitleTerms: whyTitles.get(mid) || [],
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  // People a person most often shares meetings with.
  function coAttendees(person) {
    const counts = new Map();
    for (const mid of meetingsByPerson.get(person) || []) {
      for (const p of byId.get(mid)?.people || []) {
        if (p !== person) counts.set(p, (counts.get(p) || 0) + 1);
      }
    }
    return [...counts.entries()].map(([p, c]) => ({ person: p, count: c })).sort((a, b) => b.count - a.count);
  }

  return { meetingsByPerson, byId, relatedMeetings, coAttendees };
}

// Salient terms for a doc — top tf terms (used as graph "topics" + related signal).
export function topTerms(text, n = 8) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}
