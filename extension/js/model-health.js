// What each model has actually been doing lately — the extension's binding of
// @chatpanel/events/model-health.js.
//
// The router's declared attributes are what a model IS; this is how it has been BEHAVING —
// and when the two disagree, behaviour wins. A model whose credits ran out is configured
// perfectly and cannot answer, and routing to it because its config still looks good is the
// error a user experiences as "it keeps picking the broken one".
//
// The classifier and the ledger are the shared package's (the desktop runs the same ones).
// What is the extension's is WHERE the ledger lives:
//
// Deliberately NOT on disk. These are observations about right now, and a failure remembered
// across a browser restart would keep a model sidelined long after the quota reset or the
// outage ended — sidelining a working model is a worse error than trying a broken one once.
//
// But shared across PAGES within the session, and that took a bug to learn. This lived in
// plain module memory, which is per page context: the side panel learned that a local model
// was refusing connections, and briefs.html — a separate page, a separate module instance —
// started every synthesis believing it was fine, dialled it, got ERR_CONNECTION_REFUSED, and
// only then fell over. `chrome.storage.session` is exactly the scope the paragraph above
// asks for — survives a page switch, dies with the browser.

import { createModelHealth, classifyFailure } from './events/model-health.js';

export { classifyFailure };

const SESSION_KEY = 'chatpanel:modelHealth';
const sessionArea = () => globalThis.chrome?.storage?.session || null;

const ledger = createModelHealth({
  onChange: (snapshot) => {
    const area = sessionArea();
    if (!area) return;
    try { area.set({ [SESSION_KEY]: snapshot }).catch?.(() => {}); } catch { /* best effort */ }
  },
});

/** Load what the rest of this browser session has already learned. Idempotent; cheap. */
export async function hydrateHealth() {
  const area = sessionArea();
  if (!area) return false;
  try {
    const got = await area.get(SESSION_KEY);
    return ledger.hydrate(got?.[SESSION_KEY]);
  } catch { return false; }
}
const _hydrated = hydrateHealth();
export const healthReady = () => _hydrated;

/** The ledger itself, for the shared failover loop. */
export const modelHealth = ledger;

export const markUnhealthy = (id, err, modelName = '') => ledger.markUnhealthy(id, err, modelName);
export const markHealthy = (id) => ledger.markHealthy(id);
export const healthOf = (id, modelName = '') => ledger.healthOf(id, modelName);
export const unhealthyModels = () => ledger.unhealthyModels();
/** Test-only: forget everything. */
export const resetHealth = () => ledger.reset();
