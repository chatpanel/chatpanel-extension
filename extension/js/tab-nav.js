// Opening and navigating tabs — the one place that does it.
//
// NOT A NEW CAPABILITY. Web search has opened background tabs since it shipped (js/web-search.js
// renders a SERP or a JS-only page in one, reads it, closes it), so `tabs` and `<all_urls>` are
// already in the manifest and nothing here adds a permission, a manifest line, or anything a
// store reviewer has not already seen. What was missing was not the ability to open a tab — it
// was a TOOL that let a model ask for one, which is why "go to google.com and search for X",
// asked four different ways in one session, reached a model with click, type and screenshot and
// no way to arrive anywhere.
//
// Extracted rather than copied: web-search grew this wait, and a second implementation of "has
// the page finished loading" is a second set of timeouts to get wrong. It takes its constants
// as arguments so that caller keeps its own tuning.
//
// EVERY url passes assertFetchable — before opening AND again after the load, because a public
// URL is free to redirect to a private one. The URL reaching here was chosen by a model that has
// been reading page text, tool results and meeting transcripts, so it is attacker-influenced by
// construction: without the guard, "open http://127.0.0.1:4319/…" points the user's browser at
// their own bridge, and 169.254.169.254 at cloud credentials.

import { assertFetchable } from './context.js';

export const NAV_TIMEOUT_MS = 15_000;
export const RENDER_SETTLE_MS = 500;

/**
 * Resolve once the tab reports `complete`, or once the timeout is up.
 *
 * A timeout is NOT an error: a slow page is still the page, and throwing away a navigation that
 * worked because it took 16 seconds is worse than reporting it late. The settle delay is what
 * gives a rendered SPA a moment to paint after `complete` fires.
 */
export function waitForTabComplete(tabId, { timeoutMs = NAV_TIMEOUT_MS, settleMs = RENDER_SETTLE_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* already gone */ }
      setTimeout(resolve, settleMs);
    };
    function listener(id, info) { if (id === tabId && info.status === 'complete') finish(); }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

/** Where the tab actually ended up. Empty strings rather than a throw — the tab may be gone. */
async function landedAt(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: t?.url || '', title: t?.title || '' };
  } catch { return { url: '', title: '' }; }
}

/**
 * Open `url` in a NEW tab. Returns { ok, opened, tabId } or { error }.
 *
 * The new tab is deliberately not handed back as a target to act on: a page nobody has looked at
 * yet has not been granted anything.
 */
export async function openTab(url, { active = true } = {}) {
  let parsed;
  try { parsed = assertFetchable(String(url || '').trim()); } catch (e) {
    return { error: `${e?.message || e}` };
  }
  const tab = await chrome.tabs.create({ url: parsed.href, active });
  return { ok: true, opened: parsed.href, tabId: tab?.id ?? null };
}

/**
 * Point an EXISTING tab at `url` and wait for it. Returns where it actually landed.
 *
 * The second assertion is the point of doing this here: a link shortener, an ad redirect or an
 * SSO hop can move a public URL onto a blocked host after it was approved.
 */
export async function navigateTab(tabId, url, opts = {}) {
  let parsed;
  try { parsed = assertFetchable(String(url || '').trim()); } catch (e) {
    return { error: `${e?.message || e}` };
  }
  await chrome.tabs.update(tabId, { url: parsed.href });
  await waitForTabComplete(tabId, opts);
  const landed = await landedAt(tabId);
  if (landed.url) {
    try { assertFetchable(landed.url); } catch (e) {
      return { error: `Navigation ended somewhere it is not allowed to go — ${e?.message || e}` };
    }
  }
  return { ok: true, requested: parsed.href, ...landed };
}
