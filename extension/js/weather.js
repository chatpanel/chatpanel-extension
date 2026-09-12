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
import { WEATHER_TIMEOUT_MS } from './events/weather.js';
import { weatherToolProvider as sharedWeatherToolProvider } from './events/weather-tool.js';

export { WEATHER_TOOL_SYSTEM } from './events/weather-tool.js';

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

export function weatherToolProvider({ fetchJson: injected = fetchJson } = {}) {
  // The spec, the guidance and the answer shape are the shared tool; the guarded fetch is ours.
  return sharedWeatherToolProvider({ fetchJson: injected });
}
