// The user's OWN data — past chats, notes, meetings — plus the web.
//
// Collapsed behind one `find` dispatcher: six schemas and a 678-token system block were
// resident on every turn, paid whether or not the turn touched any of it, and a model
// handed that block opened conversations by reciting its own tools.

import { defineToolGroup } from '../events/tool-groups.js';
import { historyToolProvider } from '../history-rag.js';
import { webSearchToolProvider, webSearchOpts } from '../web-search.js';
import { buildToolset } from '../toolset.js';
import { dataDispatchProvider } from '../data-dispatch.js';
import { isPro, can } from '../license.js';
import { declarePlugins, pluginManifest } from '../plugins.js';

// The web is a SOURCE, like chats, notes and meetings — so "use web search at all" is one
// switch on the Plugins page, while "which engines, in what order" stays with the engines.
// Splitting it that way is what keeps a single truth per question: a capability switch here,
// a configuration there, and no state repeated between them.
declarePlugins([{
  id: 'source:web', kind: 'source', label: 'Web',
  description: 'Search the web when answering.',
}]).catch(() => {});

export const dataGroup = defineToolGroup({
  id: 'data',
  label: "The user's own data and the web",
  priority: 50,
  applies: (ctx) => !!ctx.resolvedAgent && (ctx.includeHistory !== false || ctx.includeWebSearch !== false),
  async build(ctx) {
    const { settings = {}, license = null } = ctx;
    const pro = isPro(license);
    const providers = [];

    if (ctx.includeHistory !== false && settings?.ui?.historyTools !== false) {
      providers.push(historyToolProvider({
        includeMeetings: can(license, 'liveMeetings'),
        explicit: !!ctx.history?.enabled,
        liveReader: ctx.liveReader,
        warm: (settings?.ui?.warmSearch?.enabled && settings.ui.warmSearch.url)
          ? { url: settings.ui.warmSearch.url } : null,
      }));
    }
    const manifest = await pluginManifest().catch(() => null);
    const webAllowed = !manifest || manifest.isEnabled('source:web');
    if (ctx.includeWebSearch !== false && settings?.ui?.webSearch?.enabled !== false && webAllowed) {
      providers.push(webSearchToolProvider(webSearchOpts(settings, pro)));
    }
    if (!providers.length) return null;

    const inner = buildToolset(providers);
    // Opt-out exists because a model that handles a flat toolset better should not be
    // forced through indirection.
    if (settings?.ui?.dataDispatch === false) {
      return inner ? { specs: inner.specs, system: inner.system, execute: inner.execute } : null;
    }
    return dataDispatchProvider(inner);
  },
});
