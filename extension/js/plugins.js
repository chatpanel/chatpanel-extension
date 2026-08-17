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

/** The manifest, built once per context and kept in step with the others. */
export function pluginManifest() {
  if (!ready) {
    ready = (async () => {
      const disabled = await load();
      const m = createManifest({
        disabled,
        onChange: (ids) => { chrome.storage.local.set({ [KEY]: ids }).catch(() => {}); },
      });

      // THE PANEL AND THE SETTINGS PAGE ARE DIFFERENT CONTEXTS.
      //
      // Each builds its own manifest from storage and would otherwise hold that snapshot
      // forever — so toggling a plugin in settings did nothing to the running side panel
      // until it was reloaded. The switch looked broken while working perfectly, which is
      // the same shape of failure as a tool that reports ok having done nothing.
      //
      // This is the reactive half of the capability model applied to a setting: state
      // changed elsewhere arrives here, and the next turn reflects it.
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes[KEY]) return;
          m.sync(Array.isArray(changes[KEY].newValue) ? changes[KEY].newValue : []);
        });
      } catch { /* no storage events available — the snapshot is still correct on load */ }

      return m;
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
