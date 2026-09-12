// GENERATED — do not edit.
// Source of truth: chatpanel-events/weather-tool.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// `weather` as a TOOL — the spec, the guidance, and the answer shape, without the fetch.
//
// The extension answers "how is the weather in X" with this rather than with a web search,
// because weather sites are rendered by scripts and a fetched page is navigation and no
// temperature — which is exactly what a desktop turn without this tool produced: "I couldn't
// retrieve reliable live weather". The engine (`weather.js`: the wttr.in query, the parse,
// the ambiguity check) is already shared; this is the tool every client arms in front of it.
//
// `fetchJson(url, { timeoutMs })` is injected: each host owns its network guard and applies
// it to a URL a MODEL supplied — attacker-influenced by construction.

import { getWeather } from './weather.js';

export const WEATHER_TOOL_NAME = 'weather';

export const WEATHER_TOOL_SYSTEM =
  'For weather, call `weather` FIRST — it answers the whole question in one request. Only '
  + 'fall back to web_search if it tells you to. Report the location it says it resolved, '
  + 'because a bare town name can geocode to the wrong place.';

export function weatherToolProvider({ fetchJson } = {}) {
  if (typeof fetchJson !== 'function') throw new Error('weatherToolProvider: fetchJson required');
  return {
    specs: [
      {
        name: 'weather',
        // A read, declared: the round runner overlaps reads and serialises everything it
        // cannot classify, and "weather" is not a verb its name heuristic knows.
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        description:
          'Current conditions and a short forecast for one place, in a single request. Use this '
          + 'for any weather question instead of searching. Returns the location it actually '
          + 'resolved to — say which place the answer is for.',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'A place, as the user said it. Add a state or country only if THEY did '
                + '— "Fairview, OR" if they said so, plain "Fairview" if they did not.',
            },
          },
          required: ['location'],
          additionalProperties: false,
        },
      },
    ],
    system: WEATHER_TOOL_SYSTEM,
    async execute(name, input) {
      if (name !== 'weather') return JSON.stringify({ error: `Unknown tool: ${name}` });
      const location = String(input?.location || '').trim();
      if (!location) return 'No location provided to weather.';
      const got = await getWeather(location, { fetchJson });
      // THE FALLBACK IS AN INSTRUCTION, not an error string. A model handed "weather failed"
      // stops, or apologises; a model told which tool answers this next just uses it. The
      // whole point of preferring one source is that it must degrade to the general one.
      if (!got.ok) {
        return `The weather service could not answer for "${location}" (${got.reason}). `
          + `Now call web_search for "weather in ${location}" and answer from the results — `
          + 'do not tell the user a tool failed.';
      }
      return { text: got.text, note: 'ChatPanel · wttr.in' };
    },
  };
}
