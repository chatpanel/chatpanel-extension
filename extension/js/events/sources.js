// GENERATED — do not edit.
// Source of truth: chatpanel-events/sources.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

/**
 * WHERE THE CONTENT CAME FROM DECIDES HOW FAR IT MAY TRAVEL.
 *
 * A model was summarising an internal access-management page and the turn went to a public
 * inference host, because routing asked what the WORK needed — tools, vision, quality — and
 * never asked where the material came from. Capability decided; provenance did not exist.
 *
 * This module supplies the missing question. It classifies a source URL as internal or not,
 * and turns that into a REACH CEILING the router already knows how to enforce. Two properties
 * make it a guard rather than a preference:
 *
 *   - It only ever NARROWS. `meetReach` takes the tighter of two ceilings, so no later step,
 *     plugin or user dial can widen what an internal source already restricted. A guard that
 *     something downstream can relax is a suggestion.
 *   - It fails CLOSED. An unparseable URL is treated as internal, because the alternative is
 *     to send data outward on the strength of a string we could not read.
 *
 * Pure and dependency-free: the same rules must hold in the extension, the gateway and the
 * bridge, or "internal" means three different things and the strictest one is not the one
 * that runs.
 */

const REACH_ORDER = ['device', 'trusted', 'any'];

/** The tighter of two reach ceilings. Guards compose by MEET — they can only narrow. */
export function meetReach(a, b) {
  const ia = REACH_ORDER.indexOf(a);
  const ib = REACH_ORDER.indexOf(b);
  // An unknown value is not a licence to travel further: treat it as the tightest.
  if (ia < 0) return REACH_ORDER.includes(b) ? b : 'device';
  if (ib < 0) return a;
  return REACH_ORDER[Math.min(ia, ib)];
}

/**
 * Hosts that are internal by NETWORK TOPOLOGY — the STARTING list, not a floor.
 *
 * Deliberately limited to what the address itself proves. A corporate wiki on a public SaaS
 * domain looks exactly like any other public host from here — that case needs the user's own
 * patterns, and pretending to detect it would give a false sense of coverage.
 *
 * These are seeded into the user's editable list rather than silently prepended to it,
 * because "internal" is a fact about someone's network, not about ours: a developer testing
 * against localhost may well want that traffic to reach a cloud model, and a rule they cannot
 * see is a rule they cannot correct.
 */
export const INTERNAL_PATTERN_CATALOG = Object.freeze([
  { pattern: 'localhost', label: 'This machine, by name' },
  { pattern: '127.0.0.0/8', label: 'Loopback' },
  { pattern: '::1', label: 'Loopback (IPv6)' },
  { pattern: '0.0.0.0/8', label: 'This network' },
  { pattern: '10.0.0.0/8', label: 'Private network' },
  { pattern: '172.16.0.0/12', label: 'Private network' },
  { pattern: '192.168.0.0/16', label: 'Private network (home / office)' },
  { pattern: '100.64.0.0/10', label: 'Carrier-grade NAT — used by some corporate networks' },
  { pattern: '169.254.0.0/16', label: 'Link-local — never routes off this segment' },
  { pattern: 'fe80::/10', label: 'Link-local (IPv6)' },
  { pattern: 'fc00::/7', label: 'Unique local (IPv6) — the 10.x of IPv6' },
  { pattern: '*.internal', label: 'Reserved name' },
  { pattern: '*.intranet', label: 'Reserved name' },
  { pattern: '*.corp', label: 'Conventional corporate suffix' },
  { pattern: '*.lan', label: 'Conventional LAN suffix' },
  { pattern: '*.local', label: 'mDNS / Bonjour' },
  { pattern: '*.localdomain', label: 'Default suffix on many routers' },
  { pattern: '*.home', label: 'Home network' },
  { pattern: '*.home.arpa', label: 'Home network (RFC 8375)' },
  { pattern: '*.private', label: 'Conventional private suffix' },
  { pattern: '*.test', label: 'Reserved for testing (RFC 2606)' },
  { pattern: '*.invalid', label: 'Reserved as never-resolvable' },
  { pattern: '<intranet>', label: 'Any bare hostname with no dots, e.g. http://wiki/ — includes localhost' },
]);

/**
 * The patterns on by default. Derived from the catalog so the list a UI offers and the list
 * the classifier applies cannot drift — two copies of this would mean a rule someone can see
 * and not switch off, or switch off and not escape.
 */
export const DEFAULT_INTERNAL_PATTERNS = Object.freeze(INTERNAL_PATTERN_CATALOG.map((x) => x.pattern));
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(host) {
  const m = IPV4.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reduce((acc, n) => acc * 256 + n, 0);
}

/**
 * An IPv6 address as its 128 bits, or null if it is not one. Bits rather than a normalised
 * string because prefix matching (fc00::/7, fe80::/10) is a bit-length comparison — a
 * textual "starts with" would get /7 wrong, since the boundary falls inside a hex digit.
 */
function v6Bits(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return null;
  const [headRaw, tailRaw, ...rest] = h.split('::');
  if (rest.length) return null;   // more than one '::' is not a valid address
  const parse = (part) => (part ? part.split(':').filter((x) => x !== '') : []);
  let head = parse(headRaw);
  let tail = tailRaw === undefined ? [] : parse(tailRaw);
  // A trailing IPv4 form (::ffff:10.0.0.1) — the last group is four octets, not two.
  const last = (tail.length ? tail : head)[Math.max(0, (tail.length ? tail : head).length - 1)];
  if (last && last.includes('.')) {
    const v4 = ipToInt(last);
    if (v4 == null) return null;
    const pair = [(v4 >>> 16).toString(16), (v4 & 0xffff).toString(16)];
    if (tail.length) tail = [...tail.slice(0, -1), ...pair];
    else head = [...head.slice(0, -1), ...pair];
  }
  const missing = 8 - head.length - tail.length;
  if (tailRaw === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let bits = '';
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    bits += parseInt(g, 16).toString(2).padStart(16, '0');
  }
  return bits;
}

function inCidr(host, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const hostV6 = v6Bits(host);
  const netV6 = v6Bits(net);
  if (hostV6 || netV6) {
    // A v4 host never sits inside a v6 range, and vice versa — comparing them would be a
    // type confusion that quietly matches or quietly does not.
    if (!hostV6 || !netV6) return false;
    const n = Number(bitsRaw);
    if (!Number.isFinite(n) || n < 0 || n > 128) return false;
    return hostV6.slice(0, n) === netV6.slice(0, n);
  }
  const ip = ipToInt(host);
  const base = ipToInt(net);
  if (ip == null || base == null) return false;
  const bits = Number(bitsRaw);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  // Shifting by 32 is a no-op in JS, so /0 is spelled out rather than computed.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * Does `host` match one pattern? Supported forms, in the order a person would expect:
 *   `*.example.com`  the domain and every subdomain
 *   `example.com`    the same — a bare domain covers its subdomains, because someone adding
 *                    their company domain means the whole company, not one host
 *   `10.0.0.0/8`     a CIDR range
 *   `<intranet>`     any single-label host, which can only resolve on a private network
 */
export function hostMatches(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const p = String(pattern || '').toLowerCase().trim();
  if (!h || !p) return false;
  // A NAME with no dots — not an address. A public IPv6 literal has no dots either, and
  // sweeping it in here would have quietly pinned every v6 host on the internet as internal.
  if (p === '<intranet>') return !h.includes('.') && !h.includes(':') && !h.startsWith('[') && !IPV4.test(h);
  if (p.includes('/')) return inCidr(h, p);
  // '::1' and '[::1]' and '0:0:0:0:0:0:0:1' are one address written three ways.
  const pv6 = v6Bits(p);
  if (pv6) return v6Bits(h) === pv6;
  const bare = p.startsWith('*.') ? p.slice(2) : p;
  if (h === bare) return true;
  if (h.endsWith(`.${bare}`)) return true;
  // A leading wildcard anywhere else ("*.corp.*") is not supported rather than
  // half-supported: a pattern that silently matches nothing is worse than one that is
  // rejected, because it looks like protection.
  return false;
}

/**
 * Classify one source. Returns `{ internal, host, matched }`.
 *
 * FAILS CLOSED. A URL we cannot parse counts as internal: we would rather keep a public page
 * on-device than send an internal one out because a string was malformed. The same applies to
 * non-http schemes — a `file:` path is local by definition.
 */
export function classifySource(url, { patterns = DEFAULT_INTERNAL_PATTERNS } = {}) {
  const raw = String(url || '').trim();
  if (!raw) return { internal: false, host: '', matched: null };
  let host = '';
  let scheme = '';
  try {
    const u = new URL(raw);
    host = u.hostname;
    scheme = u.protocol.replace(':', '');
  } catch {
    return { internal: true, host: '', matched: 'unparseable' };
  }
  if (scheme === 'file') return { internal: true, host, matched: 'file:' };
  // Extension and browser-internal pages carry no third-party content, and are not sources
  // anyone means to protect — treating them as internal would pin every turn to a local
  // model for no reason.
  if (/^(chrome|edge|about|moz|chrome-extension|data|blob)$/.test(scheme)) {
    return { internal: false, host, matched: null };
  }
  for (const p of patterns) {
    if (hostMatches(host, p)) return { internal: true, host, matched: p };
  }
  return { internal: false, host, matched: null };
}

/**
 * Every url written in a piece of text.
 *
 * Declared sources are not the only way internal material enters a turn: someone pastes a
 * link to an internal runbook, or a tool result comes back carrying one. The address is the
 * evidence, and it is evidence wherever it appears — so the same classifier that reads the
 * tab reads the body too.
 *
 * Explicit schemes only. A bare host like `wiki/page` is indistinguishable from an ordinary
 * path, and matching it would pin turns on text that mentions no site at all — a guard that
 * fires on prose gets switched off, which protects nobody.
 */
export function extractUrls(text) {
  const out = [];
  const re = /\b(?:https?|file):\/\/[^\s<>"'`)\]}]+/gi;
  for (const m of String(text || '').matchAll(re)) {
    // Trailing punctuation belongs to the sentence, not to the address.
    out.push(m[0].replace(/[.,;:!?]+$/, ''));
  }
  return out;
}

/**
 * Build the reach policy for a turn from everything it draws on.
 *
 * ANY internal source pins the WHOLE turn. A turn that mixes an internal page with a public
 * one is still carrying the internal page, and splitting the difference would send it out.
 *
 * `ceiling` is what an internal source narrows to — 'device' for local models only, or
 * 'trusted' to also allow a workspace gateway the user runs. It cannot widen anything: the
 * result is always the tighter of the ceiling and what was already required.
 */
export function sourcePolicyFor(sources = [], { patterns, ceiling = 'device', base = 'any' } = {}) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  const hits = [];
  for (const s of list) {
    const url = typeof s === 'string' ? s : (s?.url || s?.href || '');
    if (!url) continue;
    const c = classifySource(url, patterns ? { patterns } : undefined);
    if (c.internal) hits.push({ url, host: c.host, matched: c.matched });
  }
  if (!hits.length) return { internal: false, reach: base, hits: [], why: null };
  const safeCeiling = REACH_ORDER.includes(ceiling) ? ceiling : 'device';
  return {
    internal: true,
    reach: meetReach(base, safeCeiling),
    hits,
    // Named so the person can see WHICH rule pinned the turn — an unexplained restriction
    // gets switched off wholesale.
    why: `${hits[0].host || 'the source'} matches '${hits[0].matched}' — kept ${safeCeiling === 'device' ? 'on this device' : 'inside your workspace'}`,
  };
}
