// Updating the bridge, as a capability rather than a button handler.
//
// An update is not one request: the bridge downloads its replacement, swaps its own binary
// and RESTARTS, so the connection drops mid-flight and the caller has to wait for a different
// process to answer on the same port. That wait lived inside the Bridge card's click handler,
// which is why the Channels card — the screen that actually tells you the bridge is too old —
// could name the fix but not offer it. One implementation, two callers today, and a first-run
// flow tomorrow costs nothing.

import { updateBridge, checkBridge } from './providers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Update and wait for the new version to answer. Resolves `{ ok, from, to, slow }` and never
 * throws — every failure here is a sentence the settings page shows, not an exception.
 *
 * `onStatus('updating'|'restarting')` lets a caller narrate the two phases, because the
 * restart is several seconds of silence and an un-narrated one reads as a hang.
 */
export async function updateBridgeAndWait(url, {
  onStatus = () => {}, tries = 8, gapMs = 1500, settleMs = 4000,
} = {}) {
  onStatus('updating');
  const r = await updateBridge(url);
  if (!r.ok) return { ok: false, error: r.error || 'unknown' };
  onStatus('restarting');
  await sleep(settleMs);
  for (let i = 0; i < tries; i += 1) {
    const state = await checkBridge(url);
    if (state?.ok && (!r.to || state.version === r.to)) {
      return { ok: true, from: r.from, to: state.version, state };
    }
    await sleep(gapMs);
  }
  // The swap succeeded — the bridge just has not finished coming back. Reporting that as a
  // failure would send the user to reinstall something that is already updated.
  return { ok: true, from: r.from, to: r.to, slow: true };
}

/** How to install or update by hand, when the running bridge cannot do it itself (an npm
 *  install, or none running at all). Kept beside the capability so both screens say the
 *  same thing — a stale copy of an install command is worse than no copy. */
export function bridgeInstallCommands({ npmCommand = '' } = {}) {
  if (npmCommand) return [{ label: 'Update the npm install', cmd: npmCommand }];
  return [
    { label: 'macOS / Linux', cmd: 'curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash' },
    { label: 'Windows (PowerShell)', cmd: 'irm https://dl.chatpanel.net/bridge/install.ps1 | iex' },
    { label: 'With Node, no install', cmd: 'npx @chatpanel/bridge' },
  ];
}
