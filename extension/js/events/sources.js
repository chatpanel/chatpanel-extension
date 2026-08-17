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
export const DEFAULT_INTERNAL_PATTERNS = Object.freeze([
  'localhost',
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '*.internal',
  '*.intranet',
  '*.corp',
  '*.lan',
  '*.local',
  '*.home.arpa',
  // A bare hostname with no dot (http://wiki/, http://tickets/) only resolves inside a private
  // search domain — it cannot be a public site.
  '<intranet>',
]);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(host) {
  const m = IPV4.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reduce((acc, n) => acc * 256 + n, 0);
}

function inCidr(host, cidr) {
  const [net, bitsRaw] = cidr.split('/');
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
  if (p === '<intranet>') return !h.includes('.') && !IPV4.test(h);
  if (p.includes('/')) return inCidr(h, p);
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
