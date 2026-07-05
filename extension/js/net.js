// Shared host classifier + outbound-URL guard — the SSRF primitive.
//
// One implementation of "what is a loopback / cloud-metadata / private host",
// delivered the way the rest of @chatpanel/pii is: npm dependency for the
// gateway/bridge, vendorable into the browser extension (pure — only URL + string
// ops, no node APIs, so it runs in a Worker/service-worker too). Replaces the
// hand-maintained copies in the bridge (src/ssrf.js) and the extension
// (js/context.js isBlockedHost) so a security guard can't silently drift between
// the direct client path and the proxied path. See docs/secure-data-plane.md.
//
// The policy knobs cover the two legitimate trust contexts:
//   • A MODEL / API / MCP endpoint (gateway upstream, bridge MCP proxy) may live on
//     loopback (Ollama, LM Studio) or the LAN (a homelab GPU box) — so those are
//     allowed by default — but must NEVER reach cloud instance metadata.
//   • A WEB PAGE fetch (link title, page context) has no business touching loopback
//     or any private host at all — call with { allowLoopback:false, allowPrivate:false }.
// Cloud metadata (169.254.169.254 & friends) and non-http(s) schemes are blocked in
// BOTH contexts, unconditionally. Re-run the assert on every redirect hop.

function ipv4(h) {
  const m = String(h).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o;
}

const norm = (hostname) => String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

// Loopback = this host's own services (127.0.0.0/8, ::1, localhost, *.localhost).
export function isLoopbackHost(hostname) {
  const h = norm(hostname);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  const o = ipv4(h);
  return !!(o && o[0] === 127);
}

// Cloud instance metadata — the sharpest SSRF target (credential theft). Covers the
// link-local IMDS address used by AWS/GCP/Azure/DO (169.254.169.254), Alibaba's
// 100.100.100.200, and the GCP/name-based metadata hosts. ALWAYS blocked.
export function isMetadataHost(hostname) {
  const h = norm(hostname);
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  const o = ipv4(h);
  if (!o) return false;
  if (o[0] === 169 && o[1] === 254) return true;                 // 169.254.169.254 (+ link-local)
  if (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) return true; // Alibaba IMDS
  return false;
}

// Private / internal address space, EXCLUDING loopback + metadata (checked
// separately): RFC1918, CGNAT, IPv6 ULA/link-local, mDNS .local, this-host 0.x/::.
export function isPrivateHost(hostname) {
  const h = norm(hostname);
  if (!h) return true;
  if (h.endsWith('.local')) return true;
  if (
    h === '::' || h.startsWith('fc') || h.startsWith('fd')       // IPv6 ULA
    || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb') // link-local
  ) return true;
  const o = ipv4(h);
  if (o) {
    const [a, b] = o;
    if (a === 0 || a === 10) return true;                        // this-host / RFC1918
    if (a === 169 && b === 254) return true;                     // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;            // RFC1918
    if (a === 192 && b === 168) return true;                     // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
  }
  return false;
}

// Policy-driven classifier. Returns true if `hostname` must be blocked under `policy`.
// Defaults model the ENDPOINT context (loopback + LAN allowed, metadata never).
export function isBlockedHost(hostname, { allowLoopback = true, allowPrivate = true } = {}) {
  const h = norm(hostname);
  if (!h) return true;
  if (isMetadataHost(h)) return true;                            // never, in any context
  if (isLoopbackHost(h)) return !allowLoopback;
  if (isPrivateHost(h)) return !allowPrivate;
  return false;                                                  // public host
}

// Assert a URL is fetchable under `policy`; returns the parsed URL or throws.
// Call on the initial URL AND after every redirect hop.
export function assertFetchableUrl(u, policy = {}) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`invalid URL: ${u}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http(s) URLs allowed (got "${parsed.protocol}")`);
  }
  if (isBlockedHost(parsed.hostname, policy)) {
    throw new Error(`refusing to reach a blocked address (${parsed.hostname})`);
  }
  return parsed;
}

// Endpoint context: model/API/MCP upstream — loopback + LAN OK, metadata never.
export const assertEndpointUrl = (u, opts = {}) => assertFetchableUrl(u, { allowLoopback: true, allowPrivate: true, ...opts });
// Web-page context: no loopback, no private, no metadata — genuinely public only.
export const assertPublicWebUrl = (u) => assertFetchableUrl(u, { allowLoopback: false, allowPrivate: false });
