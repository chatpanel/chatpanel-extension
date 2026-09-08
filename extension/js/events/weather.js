// GENERATED — do not edit.
// Source of truth: chatpanel-events/weather.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Weather — one deterministic source, asked first, with search as the fallback.
//
// There was no weather capability at all, so every "how is the weather in X" went to
// web_search and the model assembled an answer from whatever three sites it happened to
// scrape. That is slow (several page fetches for one number), inconsistent between asks, and
// it failed in the way scraping fails: a repeated search got refused by the loop guard, the
// reworded retry returned nothing, and the model announced it had no access to weather.
//
// wttr.in answers the whole question in ONE request as JSON, which is why it is the default.
// It is not authoritative and it is not always up, so the tool falls back to search rather
// than pretending — but the common case costs one round trip and reads the same every time.
//
// THE GEOCODER IS THE KNOWN WEAKNESS, and it is handled by disclosure rather than cleverness.
// "Issaquah" once resolved to somewhere obscure and the answer looked plausible and was for
// the wrong place. wttr.in reports what it actually resolved to, so `formatWeather` always
// prints that line: a wrong place is then visible instead of silent. Guessing a region on the
// user's behalf would replace a visible error with an invisible one.
//
// Pure and platform-free, like every other module here: the fetch is INJECTED, so the
// extension passes its SSRF-guarded secureFetch, the gateway passes its own, and neither has
// a second copy of the parsing.

export const WEATHER_HOST = 'https://wttr.in';

/** Long enough for a cold CDN edge, short enough that a hung host still falls back. */
export const WEATHER_TIMEOUT_MS = 7000;

export class WeatherError extends Error {
  constructor(code, message) { super(message); this.name = 'WeatherError'; this.code = code; }
}

/**
 * The URL for one location.
 *
 * The location goes in the PATH, so it is percent-encoded whole — a bare `encodeURIComponent`
 * of "Seattle, WA" gives `Seattle%2C%20WA`, which wttr.in reads correctly, while leaving the
 * comma raw would let a location containing `/` or `?` reshape the request. Never interpolate
 * an unencoded user string into a path.
 */
export function weatherUrl(location, { host = WEATHER_HOST } = {}) {
  const q = String(location ?? '').trim();
  if (!q) throw new WeatherError('NO_LOCATION', 'a location is required');
  if (q.length > 120) throw new WeatherError('BAD_LOCATION', 'location is too long to be one');
  return `${host}/${encodeURIComponent(q)}?format=j1`;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => String(v ?? '').trim();
// wttr.in nests half its scalars as [{ value: "…" }], which is a shape, not data.
const firstValue = (v) => (Array.isArray(v) ? str(v[0]?.value) : str(v));

/**
 * wttr.in's `format=j1` body → a shape that does not mention wttr.in.
 *
 * Returns null for anything unusable rather than throwing: a malformed body and an outage are
 * the same event to the caller, and both mean "fall back to search".
 */
export function parseWeather(json, { query = '' } = {}) {
  if (!json || typeof json !== 'object') return null;
  const cur = Array.isArray(json.current_condition) ? json.current_condition[0] : null;
  if (!cur) return null;
  const tempC = num(cur.temp_C);
  const tempF = num(cur.temp_F);
  // A reading with no temperature is not a weather reading. Guarded because an error page
  // served as JSON still parses into an object, and half-empty output read as real data is
  // worse than no data.
  if (tempC === null && tempF === null) return null;

  const areaRaw = Array.isArray(json.nearest_area) ? json.nearest_area[0] : null;
  const area = areaRaw ? {
    name: firstValue(areaRaw.areaName),
    region: firstValue(areaRaw.region),
    country: firstValue(areaRaw.country),
    lat: num(areaRaw.latitude),
    lon: num(areaRaw.longitude),
  } : null;

  const days = (Array.isArray(json.weather) ? json.weather : []).slice(0, 3).map((d) => ({
    date: str(d.date),
    maxC: num(d.maxtempC),
    maxF: num(d.maxtempF),
    minC: num(d.mintempC),
    minF: num(d.mintempF),
    sunrise: str(d.astronomy?.[0]?.sunrise),
    sunset: str(d.astronomy?.[0]?.sunset),
    // The midday slot is the day's headline condition; the array is 3-hourly.
    condition: firstValue(d.hourly?.[4]?.weatherDesc) || firstValue(d.hourly?.[0]?.weatherDesc),
    chanceOfRain: num(d.hourly?.[4]?.chanceofrain),
  }));

  return {
    query: str(query),
    area,
    now: {
      tempC,
      tempF,
      feelsLikeC: num(cur.FeelsLikeC),
      feelsLikeF: num(cur.FeelsLikeF),
      condition: firstValue(cur.weatherDesc),
      humidity: num(cur.humidity),
      windKph: num(cur.windspeedKmph),
      windMph: num(cur.windspeedMiles),
      windDir: str(cur.winddir16Point),
      precipMm: num(cur.precipMM),
      uv: num(cur.uvIndex),
      observedAt: str(cur.localObsDateTime),
    },
    days,
  };
}

/** "Seattle, Washington, United States" — whatever of it exists, deduped. */
export function areaLabel(area, fallback = '') {
  if (!area) return fallback;
  const parts = [area.name, area.region, area.country].map(str).filter(Boolean);
  const seen = new Set();
  const uniq = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return uniq.join(', ') || fallback;
}

/**
 * True when the user named a bare place with no region or country.
 *
 * Not used to REWRITE the query — that is how you turn a wrong answer into a confidently
 * wrong one. It is used to add a line telling the model to say which place it got, so the
 * user can correct it. Dozens of towns are called Fairview.
 */
export function isAmbiguousLocation(location) {
  const q = str(location);
  if (!q) return false;
  return !/[,]/.test(q) && q.split(/\s+/).length <= 2;
}

const c2f = (c) => Math.round((c * 9) / 5 + 32);
const temp = (c, f) => {
  const cc = c === null && f !== null ? Math.round(((f - 32) * 5) / 9) : c;
  const ff = f === null && c !== null ? c2f(c) : f;
  if (cc === null && ff === null) return '';
  if (cc === null) return `${ff}°F`;
  if (ff === null) return `${cc}°C`;
  return `${ff}°F / ${cc}°C`;
};

/** What the model reads. Compact — this is one fact, not a report. */
export function formatWeather(w) {
  if (!w) return '';
  const where = areaLabel(w.area, w.query);
  const lines = [];
  // FIRST LINE NAMES THE PLACE IT ACTUALLY RESOLVED. The geocoder picks obscure matches for
  // bare town names, and an answer that does not say where it is from cannot be caught.
  lines.push(`Weather for ${where}${w.query && where.toLowerCase() !== w.query.toLowerCase() ? ` (asked: "${w.query}")` : ''}`);
  const n = w.now;
  const now = [`Now: ${temp(n.tempC, n.tempF)}`];
  if (n.feelsLikeC !== null || n.feelsLikeF !== null) now.push(`feels like ${temp(n.feelsLikeC, n.feelsLikeF)}`);
  if (n.condition) now.push(n.condition.toLowerCase());
  lines.push(now.join(', '));
  const detail = [];
  if (n.humidity !== null) detail.push(`humidity ${n.humidity}%`);
  if (n.windMph !== null || n.windKph !== null) {
    detail.push(`wind ${n.windMph !== null ? `${n.windMph} mph` : `${n.windKph} km/h`}${n.windDir ? ` ${n.windDir}` : ''}`);
  }
  if (n.precipMm !== null) detail.push(`precip ${n.precipMm} mm`);
  if (n.uv !== null) detail.push(`UV ${n.uv}`);
  if (detail.length) lines.push(detail.join(' · '));
  for (const d of w.days) {
    const range = `${temp(d.maxC, d.maxF)} high / ${temp(d.minC, d.minF)} low`;
    const rain = d.chanceOfRain !== null ? `, ${d.chanceOfRain}% rain` : '';
    lines.push(`${d.date}: ${range}${d.condition ? `, ${d.condition.toLowerCase()}` : ''}${rain}`);
  }
  if (n.observedAt) lines.push(`Observed ${n.observedAt} local. Source: wttr.in`);
  if (isAmbiguousLocation(w.query)) {
    lines.push('The place name was ambiguous — TELL THE USER which location this is for, and '
      + 'offer to re-check with a state or country if it is the wrong one.');
  }
  return lines.join('\n');
}

/**
 * Ask for one location's weather.
 *
 * @param fetchJson async (url, { timeoutMs }) -> parsed JSON. Injected, so the caller's
 *        SSRF-guarded fetch is the only one that runs and this module stays runnable in Node,
 *        a browser and a mobile runtime.
 * @returns { ok: true, weather, text } | { ok: false, reason }
 *
 * NEVER THROWS. Every failure is a reason the caller can hand to the model as "use search
 * instead", because an exception here would surface as a tool error and stop the turn on a
 * question the fallback can still answer.
 */
export async function getWeather(location, { fetchJson, timeoutMs = WEATHER_TIMEOUT_MS, host = WEATHER_HOST } = {}) {
  let url;
  try { url = weatherUrl(location, { host }); } catch (e) { return { ok: false, reason: e.message }; }
  if (typeof fetchJson !== 'function') return { ok: false, reason: 'no fetch was provided' };
  let json;
  try {
    json = await fetchJson(url, { timeoutMs });
  } catch (e) {
    return { ok: false, reason: e?.message || 'the weather service did not answer' };
  }
  const weather = parseWeather(json, { query: location });
  if (!weather) return { ok: false, reason: 'the weather service returned nothing usable' };
  return { ok: true, weather, text: formatWeather(weather) };
}
