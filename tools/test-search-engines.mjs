import assert from 'node:assert/strict';
import { migrateEngines, DEFAULT_ENGINES, SEARCH_API } from '../extension/js/web-search.js';

const ids = (list) => list.map((e) => e.id);
const on = (list) => list.filter((e) => e.enabled !== false).map((e) => e.id);

// A user who saved settings while Mojeek was a default still has it stored. The settings
// page kept showing it after removal because it held its own copy of the list — the
// duplication was the bug, so this migration is now the single path both use.
const stored = [
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', enabled: true },
  { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s', enabled: true },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', enabled: false },
];
const migrated = migrateEngines(stored);
assert.ok(!ids(migrated).includes('mojeek'), 'Mojeek survived migration — it returns nothing at all');
assert.ok(ids(migrated).includes('startpage'), 'Startpage was dropped; it works some of the time');
assert.ok(ids(migrated).includes('google'), "a user's own choice was discarded");

// The API is OFF without a key: every query would otherwise leave the device to a vendor
// the user never chose. Keyless requests are also rejected outright (401), so enabling it
// would be both a privacy violation and useless.
assert.ok(!on(migrated).includes(SEARCH_API.id), 'the search API was enabled without consent');
assert.ok(on(migrateEngines(stored, { hasKey: true })).includes(SEARCH_API.id), 'a configured key did not enable the API');

// A stored config that had it ON must still be off without a key — an old setting cannot
// silently start sending queries out.
const sneaky = [{ ...SEARCH_API, enabled: true }, ...stored];
assert.ok(!on(migrateEngines(sneaky)).includes(SEARCH_API.id));

// But a user who explicitly turned it off keeps it off even with a key. "They said no" and
// "it has never been offered" are different states, and a key must not override the first.
const declined = [{ ...SEARCH_API, enabled: false }, ...stored];
assert.ok(!on(migrateEngines(declined, { hasKey: true })).includes(SEARCH_API.id));

// Removing an engine must never leave the user with nothing enabled.
assert.ok(on(migrateEngines([{ id: 'mojeek', enabled: true }])).length > 0, 'migration left search with no engines');

// Defaults are already migrated-clean, and migration is idempotent.
assert.deepEqual(ids(migrateEngines(DEFAULT_ENGINES)), ids(DEFAULT_ENGINES));
assert.deepEqual(ids(migrateEngines(migrateEngines(stored))), ids(migrated));
// Empty or absent settings fall back to the defaults rather than to nothing.
assert.deepEqual(ids(migrateEngines([])), ids(DEFAULT_ENGINES));
assert.deepEqual(ids(migrateEngines(undefined)), ids(DEFAULT_ENGINES));

// MORE THAN ONE ENGINE CONFIGURED BY DEFAULT. Enabled engines are already searched in parallel and
// merged, but a user whose only engine was Startpage saw a query return nothing —
// parallelism across one engine is just that engine, and redundancy is the entire reason
// the fan-out exists.
const defaultsOn = on(migrateEngines(undefined));
// Engines are tried ONE AT A TIME with fallback, so a second enabled engine is the first
// fallback rather than a second simultaneous request. Fanning out to all of them would be
// five times the footprint against services that ban scrapers — and being blocked
// everywhere makes redundancy worth nothing, since every fallback is blocked too.
assert.ok(defaultsOn.length >= 2, `only ${defaultsOn.length} engine on by default`);
assert.ok(!defaultsOn.includes(SEARCH_API.id), 'a keyless third-party API is on by default');
// ...and still within the Free cap of 3, so this costs a Free user nothing.
assert.ok(defaultsOn.length <= 3, `${defaultsOn.length} enabled exceeds the Free cap`);

console.log('✓ search engines: one list, migrated on load, API off without a key');
