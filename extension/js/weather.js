// The weather tool — this client's half of @chatpanel/events/weather.js.
//
// Everything that decides anything (the URL, the parse, the wording, whether a place name
// was ambiguous) lives in the shared package, so the gateway and a mobile client inherit it.
// What is HERE is only what is bound to this platform: the guarded fetch, and the sentence
// that hands the turn back to web_search when the service does not answer.
//
// WHY A TOOL AT ALL. There wasn't one, so "how is the weather in X" went to web_search and
// the model assembled an answer out of whatever three sites it scraped — several fetches for
// one number, a different answer each time, and one observed failure where the repeated
// search tripped the loop guard, the reworded retry found nothing, and the model announced it
// had no access to weather. One JSON request answers the whole question.

import { assertFetchable } from './context.js';
import { getWeather, WEATHER_TIMEOUT_MS } from './events/weather.js';

/**
 * Fetch JSON through the same host guard every other outbound request uses.
 *
 * The URL is built by the shared module from a location the MODEL supplied, so it is
 * attacker-influenced by construction — a transcript or a page can put words in that field.
 * `assertFetchable` is the one place that decides what is reachable; a second opinion here
 * would be a second answer to the same question.
 */
async function fetchJson(url, { timeoutMs = WEATHER_TIMEOUT_MS } = {}) {
  assertFetchable(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    // A redirect can leave a public URL on a private host, so the landing URL is checked too.
    if (res.url) assertFetchable(res.url);
    if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const WEATHER_TOOL_SYSTEM =
  'For weather, call `weather` FIRST — it answers the whole question in one request. Only '
  + 'fall back to web_search if it tells you to. Report the location it says it resolved, '
  + 'because a bare town name can geocode to the wrong place.';

export function weatherToolProvider({ fetchJson: injected = fetchJson } = {}) {
  return {
    specs: [
      {
        name: 'weather',
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
      const got = await getWeather(location, { fetchJson: injected });
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
