// Update checker for the manually-installed ("Load unpacked") build.
//
// While the Chrome Web Store listing is in review, users install ChatPanel by
// downloading the zip and loading it unpacked — which means Chrome does NOT
// auto-update it. So we poll the public GitHub release and tell the user when a
// newer build exists, with a one-click path to the download.
//
// This whole module no-ops once ChatPanel is installed from the Web Store
// (installType 'normal'), since that build auto-updates.

const REPO = 'chatpanel/chatpanel-extension';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const DOWNLOAD_URL = 'https://dl.chatpanel.net/extension.zip';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const K_CHECK = 'chatpanel:updateCheck'; // { checkedAt, latest }
const K_DISMISSED = 'chatpanel:updateDismissed'; // version the user dismissed the banner for
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000; // twice a day is plenty

export const currentVersion = () => chrome.runtime.getManifest().version;

// Was this build installed from the Web Store? getSelf() needs no permission.
// 'normal' = store (auto-updates); 'development' = unpacked (manual). On any
// error we assume unpacked, which is the safe default for showing the notice.
export async function isWebStoreInstall() {
  try {
    const info = await chrome.management.getSelf();
    return info.installType === 'normal';
  } catch {
    return false;
  }
}

// Pull a dotted version out of a release tag like "ext-v0.2.2".
function parseVersion(s = '') {
  const m = /(\d+(?:\.\d+){0,3})/.exec(s || '');
  return m ? m[1] : null;
}

// Semver-ish numeric compare. >0 if a is newer than b.
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Returns { managed, current, latest, updateAvailable, downloadUrl, releasesUrl }.
// `managed: true` means a Web Store install — callers should show nothing.
// Throttled to CHECK_EVERY_MS unless `force`.
export async function checkForUpdate({ force = false } = {}) {
  const current = currentVersion();
  if (await isWebStoreInstall()) {
    return { managed: true, current, updateAvailable: false };
  }

  let latest = null;
  const got = await chrome.storage.local.get(K_CHECK);
  const cache = got[K_CHECK];
  if (!force && cache && Date.now() - cache.checkedAt < CHECK_EVERY_MS) {
    latest = cache.latest;
  } else {
    try {
      const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (res.ok) {
        const data = await res.json();
        latest = parseVersion(data.tag_name) || parseVersion(data.name);
        await chrome.storage.local.set({ [K_CHECK]: { checkedAt: Date.now(), latest } });
      } else {
        latest = cache?.latest || null;
      }
    } catch {
      latest = cache?.latest || null;
    }
  }

  const updateAvailable = !!latest && cmp(latest, current) > 0;
  return { managed: false, current, latest, updateAvailable, downloadUrl: DOWNLOAD_URL, releasesUrl: RELEASES_URL };
}

// The side-panel banner is shown at most once per available version; remember a
// dismissal so we don't nag, but re-show when an even newer build lands.
export async function isDismissed(version) {
  const got = await chrome.storage.local.get(K_DISMISSED);
  return got[K_DISMISSED] === version;
}
export async function dismiss(version) {
  await chrome.storage.local.set({ [K_DISMISSED]: version });
}
