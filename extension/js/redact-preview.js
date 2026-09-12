// WHAT THE MODEL RECEIVES — the composer strip that shows the outbound draft as it will
// leave this device, with every substituted value drawn as the token that replaces it.
//
// A badge is a PROMISE: it says a thing is happening and asks to be believed. This shows the
// output instead, so trust is something the user checks rather than something the UI asserts.
//
// TWO RULES HOLD THIS TOGETHER, and both were learned the hard way:
//
//   1. The panel never shows a redaction it did not compute. The states below are explicit
//      for exactly that reason.
//   2. A missing detector costs the user the NAMES, never the whole panel. The deterministic
//      layer (emails, phones, cards, the dictionary) is synchronous and had already run —
//      replacing the text with an orange sentence answered a question nobody asked, and hid
//      the redactions that WERE going to happen behind the report of the one that was not.
//
// Rendering only. The redaction itself comes from providers.previewRedaction(), which is the
// same pipeline the Settings "Test a prompt" button and the real turn use, so this cannot
// drift from what is actually sent. Loaded dynamically (the composer imports it at the call
// site) so nothing here sits on the side panel's first paint.

import { icon } from './icons.js';

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The detector's error, said in words a person can act on.
 *
 * `detect HTTP 503` is what the transport knows and nothing a user can do anything with. It
 * is also the commonest failure by a distance — the gateway's bundled detector not running —
 * and it was being reported as though redaction itself had broken.
 */
export function detectorFailureText(err) {
  const raw = String(err?.message || err || '');
  const code = Number(raw.match(/detect HTTP (\d+)/)?.[1] || 0);
  if (code === 503 || code === 502) return 'the detector is not running yet';
  if (code === 404) return 'the detector address is wrong';
  if (code === 401 || code === 403) return 'the detector refused the key';
  if (/timeout/i.test(raw)) return 'the detector did not answer in time';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'the detector could not be reached';
  return raw.slice(0, 120) || 'the detector failed';
}

/** "1 person · 2 emails" — what was replaced, by kind, read off the spans themselves. */
export function redactionTally(spans) {
  const counts = new Map();
  for (const s of spans || []) {
    const type = s.kind === 'alias'
      ? 'pseudonym'
      // The span's token is the placeholder as it appears in the text — brackets and all —
      // so "[[LOCATION_1]]" becomes "location" before it is counted.
      : String(s.token || '').replace(/^\[\[|\]\]$/g, '').replace(/_\d+$/, '').toLowerCase().replace(/_/g, ' ');
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${esc(plural(type, n))}`)
    .join(' · ');
}

/** "2 people", "3 emails", "1 credit card" — a token type as a countable noun. */
function plural(type, n) {
  if (n <= 1) return type;
  if (type === 'person') return 'people';
  return type.endsWith('s') ? type : `${type}s`;
}

// The line under the text for the coverage this pass did NOT have. Deterministic patterns
// catch emails, phones and card numbers and cannot catch a person's name — a preview that
// shows a name back with the shield lit reads as "this is fine", and nothing on screen
// contradicts it.
function coverageNote(status, err) {
  switch (status) {
    case 'nodetector':
      return '<span class="rp-note rp-warn">Names, orgs and places are NOT redacted — no detector is set up. '
        + '<button type="button" class="rp-settings">Set one up</button></span>';
    case 'failed':
      return `<span class="rp-note rp-warn">Names, orgs and places are NOT redacted — ${esc(detectorFailureText(err))}. `
        + '<button type="button" class="rp-settings">Check the detector</button></span>';
    case 'patterns':
      return '<span class="rp-note">Patterns only — emails, phone and card numbers. '
        + '<button type="button" class="rp-upgrade">Turn on name detection</button> to catch names, orgs and places.</span>';
    case 'pending':
      return '<span class="rp-note">Checking for names…</span>';
    default:
      return '';
  }
}

/**
 * Paint one frame of the preview.
 *
 * `result` is whatever redaction is known RIGHT NOW — the deterministic pass while the
 * detector is still out, its richer answer once it lands, and still the deterministic pass
 * if the detector fails. `status` says which: 'pending' | 'patterns' | 'ok' | 'failed' |
 * 'nodetector'. `onSettings` / `onEnableModel` wire the two buttons.
 */
export function paintRedactPreview(panel, { result, status, err, onSettings, onEnableModel } = {}) {
  if (!panel) return;
  const head = `<span class="rp-head">${icon('privacy')} What the model receives</span>`;
  const note = coverageNote(status, err);

  // No deterministic result to show (an empty draft, or even the synchronous pass threw).
  // The warning still has to appear — silence would read as "nothing here needs redacting",
  // which is the one thing this panel cannot claim.
  if (!result) {
    panel.innerHTML = head + note;
  } else {
    const { redacted, spans } = result;
    let html = esc(redacted).replace(/\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g, (m) => `<mark>${m}</mark>`);
    // Pseudonyms aren't tokenized — highlight the alias text itself.
    for (const s of (spans || []).filter((x) => x.kind === 'alias')) {
      const alias = esc(s.token);
      if (alias) html = html.split(alias).join(`<mark>${alias}</mark>`);
    }
    // What was replaced, counted by kind. The marks show WHERE; this says how many and of
    // what — the same summary the sent message carries, so the two read alike.
    const tally = redactionTally(spans);
    const sum = tally
      ? `<span class="rp-note rp-sum">Replaced ${tally}.</span>`
      : (status === 'ok' || status === 'patterns'
        ? '<span class="rp-note rp-sum">Nothing to replace in this draft.</span>'
        : '');
    panel.innerHTML = `${head}${html}${sum}${note}`;
  }

  const go = panel.querySelector('.rp-settings');
  if (go && onSettings) go.onclick = onSettings;
  const up = panel.querySelector('.rp-upgrade');
  if (up && onEnableModel) up.onclick = onEnableModel;
  panel.classList.remove('hidden');
}
