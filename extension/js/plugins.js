// The one manifest: what is installed, and what the user has switched off.
//
// Four registries exist — adapters, tool groups, search engines, sources — each small and
// correct alone. None of them can answer "what is running, and can I turn that off?", and
// answering it in four places would repeat the duplication that already bit us with the
// engine list.
//
// So this is admission control rather than a rewrite. Registries keep their shape; they ask
// one question before offering anything. It is also the seam user-contributed plugins will
// need: once a plugin can arrive from outside, "is this allowed to run" has to be asked
// somewhere that is not the plugin.
//
// Persistence is chrome.storage — the platform half, injected here rather than known by the
// shared contract.

import { createManifest } from './events/manifest.js';

const KEY = 'chatpanel:disabledPlugins';

let ready = null;

async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return Array.isArray(got?.[KEY]) ? got[KEY] : [];
  } catch {
    // A manifest that cannot be read must not disable everything — unknown means enabled,
    // for the same reason it does in the contract.
    return [];
  }
}

/** The manifest, built once. */
export function pluginManifest() {
  if (!ready) {
    ready = (async () => {
      const disabled = await load();
      return createManifest({
        disabled,
        onChange: (ids) => { chrome.storage.local.set({ [KEY]: ids }).catch(() => {}); },
      });
    })().catch(() => createManifest());
  }
  return ready;
}

/**
 * Ask whether something may run.
 *
 * Synchronous callers get `true` before the manifest has loaded: a registry consulted
 * during startup must not have its plugins vanish because storage was slow. The window is
 * one read and the cost of being wrong in it is a plugin the user disabled running once.
 */
export async function isPluginEnabled(id) {
  return (await pluginManifest()).isEnabled(id);
}

/** Register what a subsystem installs, so the Plugins page can list it. */
export async function declarePlugins(entries) {
  const m = await pluginManifest();
  for (const e of entries) m.register(e);
  return m;
}

/** Drop only what the user has switched off. The one call a registry makes. */
export async function enabledOnly(items, idOf = (x) => x?.id) {
  return (await pluginManifest()).filter(items, idOf);
}
