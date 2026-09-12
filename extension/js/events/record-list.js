// GENERATED — do not edit.
// Source of truth: chatpanel-events/record-list.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A list of records as a person reads it: which order, which ones, and under which heading.
//
// The desktop showed 300 rows newest-modified-first with a date and nothing else, and it read
// as unsorted — twelve rows saying "Sep 12" are indistinguishable, "modified" is not the
// date a person remembers a chat by, and nothing separated today from last month. The query
// was right; the reading was impossible. These are the rules that make the same rows
// legible, kept out of the client because every list of records — the extension's history,
// a phone's — has to answer the same three questions the same way.
//
// Pure: `now` is injected, and a record needs only `{ title, snippet?, updatedAt, createdAt }`.

export const SORT_MODES = Object.freeze(['recent', 'started', 'title']);

export const SORT_LABELS = Object.freeze({
  recent: 'Recently active',
  started: 'Date started',
  title: 'Title A–Z',
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The timestamp a sort mode reads — modified for `recent`, created for `started`. */
export function sortStamp(rec, mode = 'recent') {
  if (mode === 'started') return num(rec?.createdAt) || num(rec?.updatedAt);
  return num(rec?.updatedAt) || num(rec?.createdAt);
}

export function sortRecords(items, mode = 'recent') {
  const list = Array.isArray(items) ? [...items] : [];
  if (mode === 'title') {
    return list.sort((a, b) => String(a?.title || '').localeCompare(String(b?.title || ''), undefined, { sensitivity: 'base' }) || sortStamp(b) - sortStamp(a));
  }
  const m = SORT_MODES.includes(mode) ? mode : 'recent';
  return list.sort((a, b) => sortStamp(b, m) - sortStamp(a, m));
}

/**
 * Keep the rows every word of the query appears in — title or snippet, any order, any case.
 * A query of nothing keeps everything, so a filter box can be bound to it directly.
 */
export function filterRecords(items, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(items) ? items : [];
  if (!words.length) return list;
  return list.filter((r) => {
    const hay = `${r?.title || ''}\n${r?.snippet || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const DAY = 86_400_000;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Which heading a timestamp files under, relative to `now`. */
export function dayBucket(ts, now = Date.now()) {
  const t = num(ts);
  if (!t) return { key: 'undated', label: 'Undated', order: 9e15 };
  const today = startOfDay(now);
  const day = startOfDay(t);
  const daysAgo = Math.round((today - day) / DAY);
  if (daysAgo <= 0) return { key: 'today', label: 'Today', order: 0 };
  if (daysAgo === 1) return { key: 'yesterday', label: 'Yesterday', order: 1 };
  if (daysAgo < 7) return { key: 'week', label: 'Earlier this week', order: 2 };
  const d = new Date(t);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) return { key: 'month', label: 'Earlier this month', order: 3 };
  const label = d.getFullYear() === n.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return { key: `m-${d.getFullYear()}-${d.getMonth()}`, label, order: 4 + (n.getFullYear() * 12 + n.getMonth()) - (d.getFullYear() * 12 + d.getMonth()) };
}

/**
 * The time a row shows, sized to how far away it is: a clock today and yesterday, a weekday
 * this week, a short date after that. Inside a day group the clock is the only thing that
 * tells two rows apart — which is the whole reason the desktop's list looked unsorted.
 */
export function rowTime(ts, now = Date.now(), { locale = undefined } = {}) {
  const t = num(ts);
  if (!t) return '';
  const b = dayBucket(t, now);
  const d = new Date(t);
  if (b.key === 'today' || b.key === 'yesterday') return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (b.key === 'week') return DAYS[d.getDay()];
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * Sort, filter and group in one pass: `[{ key, label, items }]`, groups in reading order.
 * With `mode: 'title'` there is one group and no heading, because an alphabetical list has
 * nothing to do with days.
 */
export function groupRecords(items, { mode = 'recent', query = '', now = Date.now() } = {}) {
  const sorted = sortRecords(filterRecords(items, query), mode);
  if (mode === 'title') return sorted.length ? [{ key: 'all', label: '', items: sorted }] : [];
  const groups = new Map();
  for (const r of sorted) {
    const b = dayBucket(sortStamp(r, mode), now);
    if (!groups.has(b.key)) groups.set(b.key, { key: b.key, label: b.label, order: b.order, items: [] });
    groups.get(b.key).items.push(r);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order).map(({ order, ...g }) => g);
}
