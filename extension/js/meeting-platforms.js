// The meeting platforms ChatPanel can capture — declared once.
//
// The four adapters already exist (content/adapter-*.js) behind a platform-neutral core,
// which is the adapter pattern arrived at independently. What was missing is a
// DECLARATION: the URL list lives in manifest.json's content_scripts AND again in
// background.js as MEETING_MATCHES, and the two must agree or capture silently breaks on a
// platform. That is the same two-lists bug that left a retired search engine showing in
// settings, in a place where the symptom is "the meeting was not recorded".
//
// A content script cannot be registered dynamically from here — MV3 declares them in the
// manifest — so this is not a live plugin registry. It is the single list everything else
// derives from, plus the toggle, which is the part a user actually wants: "do not record my
// Zoom calls" is a real preference and there was nowhere to say it.

export const MEETING_PLATFORMS = Object.freeze([
  {
    id: 'meet', label: 'Google Meet',
    matches: ['https://meet.google.com/*'],
    description: 'Capture captions and attendees from Google Meet.',
  },
  {
    id: 'zoom', label: 'Zoom (web client)',
    matches: ['https://*.zoom.us/wc/*'],
    description: 'Capture captions from the Zoom web client.',
  },
  {
    id: 'teams', label: 'Microsoft Teams',
    matches: [
      'https://teams.microsoft.com/*', 'https://*.teams.microsoft.com/*',
      'https://teams.live.com/*', 'https://*.teams.live.com/*',
    ],
    description: 'Capture captions from Teams.',
  },
  {
    id: 'webex', label: 'Webex',
    matches: ['https://*.webex.com/*'],
    description: 'Capture captions from Webex.',
  },
]);

/** Every URL pattern a meeting content script runs on. The one source for both consumers. */
export function meetingMatches() {
  return MEETING_PLATFORMS.flatMap((p) => p.matches);
}

/** Which platform a URL belongs to, or null. */
export function platformFor(url) {
  const u = String(url || '');
  return MEETING_PLATFORMS.find((p) => p.matches.some((m) => matchPattern(m, u))) || null;
}

/**
 * Chrome match-pattern testing, reduced to what these patterns actually use: an https
 * scheme, an optional leading wildcard on the host, and a path prefix. Deliberately not a
 * general implementation — a partial one that pretends to be general is how a pattern
 * silently stops matching.
 */
export function matchPattern(pattern, url) {
  const m = /^https:\/\/(\*\.)?([^/]+)(\/.*)$/.exec(String(pattern));
  if (!m) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const [, anySub, host, path] = m;
  const hostOk = anySub ? (parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)) : parsed.hostname === host;
  if (!hostOk) return false;
  const prefix = path.endsWith('*') ? path.slice(0, -1) : path;
  return path.endsWith('*') ? parsed.pathname.startsWith(prefix) : parsed.pathname === path;
}

/** Declare them so the Plugins page can list and switch them. */
export async function declareMeetingPlatforms() {
  const { declarePlugins } = await import('./plugins.js');
  return declarePlugins(MEETING_PLATFORMS.map((p) => ({
    id: `meeting:${p.id}`, kind: 'meeting', label: p.label, description: p.description,
  })));
}
