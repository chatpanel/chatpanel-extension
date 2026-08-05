// LEARNED CONTROL SCHEMES — what an agent worked out about how to drive an app,
// kept so the NEXT turn doesn't have to work it out again.
//
// Driving a canvas app or a game starts with a discovery cost: read the on-screen
// UI, open the help overlay, search the web for its shortcuts. That cost is pure
// waste if it is paid on every turn, and it is the main reason a second attempt at
// the same app looks as clumsy as the first. So an agent that has figured out a
// control scheme records it here, keyed by ORIGIN, and later turns on that origin
// get it folded into their system prompt as prior knowledge.
//
// Deliberately a plain capability with a small contract — the gateway or bridge
// could serve the same shape later (a shared, curated scheme library) without any
// caller changing. Storage is LOCAL ONLY: a scheme is a note about an app's
// keybindings, never page content, and it is never transmitted anywhere.
//
//   chatpanel:appControls → { v, apps: { <origin>: ControlScheme } }
//
// A ControlScheme is:
//   { origin, app, summary, bindings: [{ input, does }], notes?, source?,
//     learnedAt, usedAt, uses }

export const APP_CONTROLS_SCHEMA_VERSION = 1;

const K_APP_CONTROLS = 'chatpanel:appControls';

// A learned scheme is small, but a heavy browser sees a lot of origins — cap the
// map and evict the least recently USED (not the oldest learned, which would drop
// the app you drive daily in favour of one you visited once).
const MAX_APPS = 120;
const MAX_BINDINGS = 40;
const MAX_STR = 300;

const clip = (s, n = MAX_STR) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

async function readAll() {
  try {
    const got = await chrome.storage.local.get(K_APP_CONTROLS);
    const raw = got[K_APP_CONTROLS];
    if (!raw || typeof raw !== 'object') return {};
    return raw.apps && typeof raw.apps === 'object' ? raw.apps : {};
  } catch {
    return {};
  }
}

async function writeAll(apps) {
  // Evict coldest first so the store stays bounded no matter how much a user browses.
  const entries = Object.entries(apps);
  if (entries.length > MAX_APPS) {
    entries.sort((a, b) => (b[1]?.usedAt || 0) - (a[1]?.usedAt || 0));
    apps = Object.fromEntries(entries.slice(0, MAX_APPS));
  }
  await chrome.storage.local.set({
    [K_APP_CONTROLS]: { v: APP_CONTROLS_SCHEMA_VERSION, apps },
  });
}

// Normalize whatever a model hands us into a storable scheme. Everything is
// clipped and shape-checked — this text goes straight back into a later prompt,
// so it must not be able to grow without bound.
function normalize(origin, input = {}, prev = null) {
  const bindings = (Array.isArray(input.bindings) ? input.bindings : [])
    .filter((b) => b && (b.input || b.keys) && b.does)
    .slice(0, MAX_BINDINGS)
    .map((b) => ({ input: clip(b.input || b.keys, 80), does: clip(b.does, 160) }));
  return {
    origin,
    app: clip(input.app, 80) || prev?.app || '',
    summary: clip(input.summary) || prev?.summary || '',
    bindings: bindings.length ? bindings : prev?.bindings || [],
    notes: clip(input.notes, 500) || prev?.notes || '',
    source: clip(input.source, 200) || prev?.source || '',
    learnedAt: prev?.learnedAt || Date.now(),
    usedAt: Date.now(),
    uses: (prev?.uses || 0) + 1,
  };
}

// --------------------------------------------------------------------------
// Public contract
// --------------------------------------------------------------------------

// The scheme for an origin, or null. Marks it used so eviction keeps what matters.
export async function getControlScheme(origin) {
  if (!origin) return null;
  const apps = await readAll();
  const hit = apps[origin];
  if (!hit) return null;
  try {
    apps[origin] = { ...hit, usedAt: Date.now() };
    await writeAll(apps);
  } catch {
    // A bookkeeping failure must never block a read.
  }
  return hit;
}

// Record (or merge into) what was learned about an origin.
export async function saveControlScheme(origin, input) {
  if (!origin) return null;
  const apps = await readAll();
  const next = normalize(origin, input, apps[origin] || null);
  apps[origin] = next;
  await writeAll(apps);
  return next;
}

export async function forgetControlScheme(origin) {
  const apps = await readAll();
  if (!apps[origin]) return false;
  delete apps[origin];
  await writeAll(apps);
  return true;
}

export async function listControlSchemes() {
  const apps = await readAll();
  return Object.values(apps).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
}

// Render a scheme as the prior-knowledge block folded into the system prompt.
// Explicitly marked as possibly-stale: an app can change its bindings between
// sessions, and an agent that trusts a stale scheme over what is on screen is
// worse than one that never had it.
export function describeControlScheme(s) {
  if (!s) return '';
  const lines = [];
  lines.push(
    `KNOWN CONTROLS for ${s.app || s.origin} — learned on an earlier turn, so you do NOT need to ` +
      'rediscover them. Treat as a strong hint, not gospel: if the screen contradicts this, believe ' +
      'the screen and save the correction with save_app_controls.',
  );
  if (s.summary) lines.push(s.summary);
  if (s.bindings?.length) {
    lines.push(...s.bindings.map((b) => `  ${b.input} → ${b.does}`));
  }
  if (s.notes) lines.push(`Notes: ${s.notes}`);
  if (s.source) lines.push(`Source: ${s.source}`);
  return lines.join('\n');
}

// Tool spec + executor, so page-tools can offer this without knowing the storage
// shape. Kept here (not in page-tools) so the bridge/gateway can serve the same
// capability against the same contract.
export const SAVE_CONTROLS_TOOL_SPEC = {
  name: 'save_app_controls',
  description:
    'Record the control scheme you worked out for the app on this page, so future turns start ' +
    'knowing it instead of rediscovering it. Call this ONCE you have actually CONFIRMED how the app ' +
    'is driven — after the controls demonstrably worked, not from a guess. Include where you learned ' +
    'it (on-screen help, a web search). Also call it to CORRECT a scheme that turned out to be wrong.',
  parameters: {
    type: 'object',
    properties: {
      app: { type: 'string', description: 'Name of the app or game, e.g. "Figma", "Chess.com".' },
      summary: {
        type: 'string',
        description: 'One or two sentences on how the app is driven overall (pointer-locked? canvas? modal tools?).',
      },
      bindings: {
        type: 'array',
        description: 'The specific controls you confirmed.',
        items: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'The input, e.g. "right-click", "hold W", "Shift+drag".' },
            does: { type: 'string', description: 'What it does in this app.' },
          },
          required: ['input', 'does'],
        },
      },
      notes: { type: 'string', description: 'Gotchas — e.g. "must click the canvas once to capture the pointer".' },
      source: { type: 'string', description: 'Where this came from: "in-game help overlay", a URL, etc.' },
    },
    required: ['app', 'summary'],
  },
};

export function makeSaveControlsExecutor(origin) {
  return async (input) => {
    if (!origin) return { ok: false, error: 'no page origin — nothing to attach these controls to' };
    const saved = await saveControlScheme(origin, input || {});
    return { ok: true, saved: { app: saved.app, bindings: saved.bindings.length }, origin };
  };
}
