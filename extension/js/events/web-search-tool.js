// GENERATED — do not edit.
// Source of truth: chatpanel-events/web-search-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// `web_search` as a TOOL — the spec, the guidance, and how results are put in front of a
// model, without the search itself.
//
// Running a search is platform work: the extension fetches SERPs from a service worker
// with DOMParser, the desktop's main process reads anchors with a tokenizer, a gateway that
// grew one would use its own fetch. What is identical everywhere is what the model is told
// the tool does, what it is told about citing, and how a result list becomes text it can
// cite from — so that is what lives here, and `search` is injected.
//
// The citation rules are in the RESULT, not only in the system prompt, on purpose: the
// model reads them at the moment it has sources in hand, which is when it is most likely to
// follow them, and a turn that never searches never pays for them.

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WEB_SEARCH_TOOL_SYSTEM =
  'You can call web_search to look up current information from the web — prices, news, recent '
  + 'events, documentation, or anything time-sensitive or that may have changed since your training. '
  + 'Call it whenever the user asks about such things instead of guessing or saying you are unsure. '
  + 'Cite results inline as markdown links — e.g. ([1](https://…)) — never HTML, <sup>, or bare '
  + 'numbers, and finish with a "Sources" list of the links you used.';

export const WEB_SEARCH_SPEC = Object.freeze({
  name: WEB_SEARCH_TOOL_NAME,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  description:
    'Search the web and return ranked result snippets with their source URLs. Use this for '
    + 'current events, live prices/quotes, news, product/library docs, or any fact you are unsure '
    + 'about or that may have changed since training — prefer it over guessing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query — a few keywords work best.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

/**
 * Flatten a search result into one readable blob the model can cite from.
 *
 * `res` is `{ query, engines: [ids], results: [{ rank, title, url, text }] }`. A citation
 * index of markdown links sits at the TOP so it survives truncation.
 */
export function searchResultsToText(res) {
  if (!res?.results?.length) {
    // Name the engines HERE especially. The success path already lists them; the failure
    // path did not, so "no web results" looked like "the web has nothing" when it usually
    // means "the one engine we were allowed to ask returned nothing" — a search engine
    // blocking us and a query with no answer are completely different problems, and the
    // model cannot tell them apart without this.
    const tried = (res?.engines || []).join(', ');
    return `No web results for "${res?.query || ''}"`
      + (tried ? ` (searched: ${tried}).` : '.')
      + ' This may mean the engine blocked the request rather than that nothing exists —'
      + ' do NOT conclude the information is unavailable. Try a shorter, more general query'
      + ' (drop dates and qualifiers), and tell the user they can enable another search'
      + ' engine in ChatPanel settings if it keeps failing.';
  }
  const engines = Array.isArray(res.engines) ? res.engines : [];
  const sources = res.results.map((r) => `[${r.rank}] [${r.title}](${r.url})`).join('\n');
  const example = res.results[0].url;
  const head =
    `Web search results for "${res.query}" (engines: ${engines.join(', ')}).\n\n`
    + 'Citation rules: when a claim draws on a result below, cite it inline as a markdown '
    + `link to that result's URL — e.g. ([1](${example})). Cite multiple sources as separate `
    + 'links: ([1](url)) ([3](url)). Do NOT output HTML, <sup>, or bare bracket numbers like '
    + '[1] — every citation must be a clickable markdown link. Finish with a "Sources" section '
    + 'that repeats, as markdown links, each source you cited.\n\n'
    + `Sources:\n${sources}`;
  const body = res.results
    .map((r) => `### [${r.rank}] ${r.title}\n<${r.url}>\n\n${r.text}`)
    .join('\n\n---\n\n');
  return `${head}\n\n---\nResult details:\n\n${body}`;
}

/**
 * The tool provider — `{ specs, system, execute }` for `buildToolset`.
 *
 * @param search `(query) => Promise<{ query, engines, results }>` — the host's search. It
 *               may throw; the model gets the message rather than a dead turn.
 */
export function webSearchToolProvider({ search } = {}) {
  if (typeof search !== 'function') throw new Error('webSearchToolProvider: search required');
  return {
    specs: [WEB_SEARCH_SPEC],
    system: WEB_SEARCH_TOOL_SYSTEM,
    async execute(name, input) {
      if (name !== WEB_SEARCH_TOOL_NAME) return JSON.stringify({ error: `Unknown tool: ${name}` });
      const q = String(input?.query || '').trim();
      if (!q) return 'No query provided to web_search.';
      try {
        const res = await search(q);
        // Return an OBJECT so the step can name the ENGINE that actually served the results.
        // "web_search" alone doesn't tell the user whether Startpage or DuckDuckGo answered —
        // which matters, because engines differ in coverage, and because a CLI agent may have
        // run its OWN search instead of this one. `note` becomes the step's badge; `text` is
        // what the model reads, unchanged.
        const engines = (res?.engines || []).join(', ');
        return { text: searchResultsToText(res), note: engines ? `ChatPanel · ${engines}` : 'ChatPanel' };
      } catch (e) {
        return `web_search failed: ${e?.message || e}`;
      }
    },
  };
}
