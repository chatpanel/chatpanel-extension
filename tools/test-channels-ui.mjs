// Message your own agent from your phone — set up from Settings, not from a terminal.
//
// The property under test is the one that makes this shippable to someone non-technical: two
// steps, one paste, one link — and a bot token that this page never keeps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const html = read('settings.html');
const js = read('settings.js');
const css = read('settings.css');
const client = read('js/channels.js');

// ── the screen exists and is reachable ───────────────────────────────────────────
assert.match(html, /data-tab="channels"/, 'Channels needs its own tab — it is a setup flow, not a checkbox.');
assert.match(html, /data-panel="channels"/, 'the Channels panel must exist');
assert.match(js, /if \(name === 'channels'\) renderChannels\(\);/, 'render lazily, on first open of the tab');
assert.match(js, /wireChannels\(\);/, 'controls must be bound during init, so no button is ever dead');

// ── the two steps, and nothing else to learn ─────────────────────────────────────
assert.match(html, /t\.me\/BotFather/, 'step 1 must LINK to BotFather, not describe it');
assert.match(html, /id="ch-token"/, 'step 2 is a paste');
assert.match(html, /id="ch-connect"/, 'and a button');
assert.match(html, /id="ch-pair"/, 'pairing a phone must be one click');
assert.match(html, /id="ch-pair-link"/, 'the one-tap t.me link is the path most people take');
assert.match(html, /type="password"/, 'a bot token is a bearer credential — do not render it in the clear');

// ── the token is typed here and kept nowhere ─────────────────────────────────────
// The bridge verifies and stores it 0600. If this page ever put it in extension storage, a
// compromised profile would hand over the bot.
assert.doesNotMatch(js, /chrome\.storage[^;]*ch-token/, 'the bot token must never reach extension storage');
assert.doesNotMatch(js, /settings\.(telegram|botToken)/, 'the bot token is not a setting this page owns');
assert.match(js, /input\.value = '';/, 'clear the field once the bridge has it');
assert.doesNotMatch(client, /chrome\.storage|localStorage|sessionStorage/, 'the channels client must persist nothing in the browser');

// ── an old or absent bridge is a sentence, not an error ──────────────────────────
// The Tesla rule in the direction that actually bites: a NEW panel meets an OLD bridge.
assert.match(client, /res\.status === 404/, 'a bridge that predates channels must be told apart from a broken one');
assert.match(client, /too old for channels/, 'and the message must name the fix');
// "Too old" without a number sends the user to run an update that may already be current —
// the bridge ships on its own version line and reaches this machine by two different routes.
assert.match(client, /MIN_BRIDGE_VERSION = '\d+\.\d+\.\d+'/, 'the compatibility floor must be a stated version, not folklore');
assert.match(client, /need v\$\{MIN_BRIDGE_VERSION\} or newer/, 'the sentence must name the version channels require');
assert.match(client, /\/health/, 'and the version the bridge is actually on, so the claim can be checked');

// ── the extension must stay recognisable to its own bridge ───────────────────────
// The panel holds <all_urls>, so its fetches bypass CORS and Origin rides only on non-GET
// methods: a status GET arrives anonymous no matter what headers we set. 0.11.0 shipped
// GET /channels as a privileged route and the card could only ever say the bridge refused
// it. The floor therefore has to be the release that de-privileged it, not the one that
// added the route.
assert.match(client, /MIN_BRIDGE_VERSION = '0\.11\.1'/,
  'the floor is the first bridge on which channels actually work from the panel');
assert.match(client, /Fetch spec attaches `Origin` only to requests whose method is not GET/,
  'the reason a GET cannot be authenticated must stay written down, or it gets "fixed" again');
assert.doesNotMatch(client, /const headers = \{ 'content-type': 'application\/json' \};/,
  'a content-type on a bodyless GET buys nothing here — no preflight fires at all');
assert.match(client, /if \(token\) headers\.authorization = `Bearer \$\{token\}`/,
  'a hand-entered bridge token is the fallback for a bridge on another machine');
assert.match(client, /e\.code === 'unsupported' \|\| e\.code === 'forbidden'/,
  'a 403 from an old bridge is the same "update it" story as a 404, not a raw error');

// ── every sentence must point at the tab the field is actually on ────────────────
// The Bridge card lives under Agents. "Settings → API → Bridge" sent the user hunting.
assert.doesNotMatch(client, /API → Bridge/, 'the Bridge card is not on the API tab');
assert.match(client, /Settings → Agents → Bridge/, 'name the tab the field is really on');
const agentsPanel = html.slice(html.indexOf('data-panel="agents"'), html.indexOf('data-panel="mcp"'));
assert.ok(agentsPanel.includes('id="bridge-token"'),
  'the token field must be on the Agents tab, which is what the message tells the user');

// ── the token has somewhere to go, and visible instructions for finding it ───────
assert.match(html, /id="bridge-token"/, 'the token needs a field, not a support thread');
assert.match(html, /type="password"/, 'a credential field must not render in cleartext');
assert.match(html, /cat ~\/\.chatpanel\/bridge-token/, 'say where the token actually is on disk');
assert.match(html, /Get-Content/, 'and on Windows, where the path is different');
assert.doesNotMatch(html.slice(html.indexOf('id="bridge-token"'), html.indexOf('id="bridge-status"')),
  /<details/, 'the instructions must be on the page, not folded away behind a summary');
assert.match(js, /settings\.bridgeToken = /, 'the field must persist what is typed into it');
assert.match(js, /bridgeConn\(\)/, 'every channels call takes url+token together, not just the url');

// ── the card that finds the problem must also offer the fix ─────────────────────
// "This bridge is v0.11.0, update it under Settings → Agents → Bridge" is a correct
// sentence and still leaves a non-technical user hunting on another tab. The button that
// performs the update belongs on the screen that detected the need for it.
assert.match(html, /id="ch-fix"/, 'the Channels card needs somewhere to put the fix');
assert.match(js, /renderChannelsFix/, 'and something to put there');
assert.match(js, /Update bridge now/, 'a self-updating bridge is one click, not a terminal');
assert.match(js, /Re-check/, 'after installing by hand, the user must be able to retry in place');

const upd = read('js/bridge-update.js');
assert.match(upd, /export async function updateBridgeAndWait/, 'update+restart+wait is one capability');
assert.match(upd, /export function bridgeInstallCommands/, 'one copy of the install commands, not one per screen');
assert.match(upd, /dl\.chatpanel\.net\/bridge\/install\.sh/, 'the documented installer, not an invented one');
// The swap succeeding but the restart being slow is not a failure — reporting it as one
// sends the user to reinstall something that is already updated.
assert.match(upd, /slow: true/, 'a slow restart must not be reported as a failed update');
// Deliberately not gated on updateAvailable: that flag comes from a 6h cache that can be
// stale or rate-limited, while the update itself re-checks with force.
assert.doesNotMatch(js.slice(js.indexOf('renderChannelsFix'), js.indexOf('async function renderChannels()')),
  /up\?\.updateAvailable &&\s*up\?\.canSelfUpdate/, 'do not hide the button behind a cached flag');
assert.doesNotMatch(js, /for \(let i = 0; i < 8; i\+\+\) \{/, 'the poll loop must not be duplicated per card');

// ── the pairing code has to cross to another device ─────────────────────────────
// It is read on a laptop, it has to reach a phone, and it expires in ten minutes — retyping
// it is the failure mode. So the link is drawn as a QR, locally: a code that enrols a phone
// against this machine must not be posted to a third-party chart renderer, and the CSP would
// block the script regardless.
assert.match(html, /id="ch-pair-qr"/, 'the pairing output needs a QR, not only a link');
assert.match(js, /renderPairQr/, 'and something to draw it');
assert.match(js, /await import\('\.\/js\/qr\.js'\)/, 'drawn locally, and only once someone presses Pair');
assert.doesNotMatch(js, /chart\.googleapis|qrserver|api\.qrcode/, 'a pairing code must not leave the machine to be rendered');
assert.match(html, /id="ch-pair-link"/, 'the link stays — the phone may be the device you are reading on');
// A drawing failure must not take the link with it.
assert.match(js, /ch-qr-fail/, 'if the QR cannot be drawn, the link must still be usable');

// ── a live code, and a screen that knows when it stops being live ───────────────
// The phone talks to the bridge, not to this page, so nothing here learns that a code was
// redeemed or expired. It showed a used QR under a "10 minutes" promise that never counted
// down, while the list below said no phone was paired until someone reloaded.
assert.match(js, /function watchPairing/, 'a live code needs a watcher');
assert.match(js, /expires in \$\{mmss/, 'the ten minutes must actually count down');
assert.match(js, /ch-pair-expired/, 'an expired code must say so');
assert.match(js, /ch-pair-live'\)\?\.classList\.add\('hidden'\)/, 'and the dead QR must come off the screen');
assert.match(js, /\$\('ch-pair-out'\)\.classList\.add\('hidden'\)/, 'a redeemed code must stop being displayed too');
assert.match(js, /toast\(`Paired \$\{fresh\.label \|\| fresh\.actorId\}`\)/, 'and the screen must say which phone it enrolled');
assert.match(js, /function stopPairWatch/, 'the watcher must be stoppable');
for (const site of ['disconnectChannel', 'renderChannelsFix']) {
  assert.ok(js.includes('stopPairWatch()'), `${site} path must be able to stop it`);
}
assert.match(html, /id="ch-pair-countdown"/, 'the countdown needs somewhere to render');

// The label is remote text arriving in the owner's screen; it renders escaped, next to the id
// that authorization is actually keyed on (two phones can share a first name).
assert.match(js, /escapeHtml\(p\.label\)/, 'a display name from Telegram must be escaped');
assert.match(js, /escapeHtml\(p\.actorId\)/, 'and the id it is keyed on must still be shown');

// ── a phone should reach what the user configured, not a subset ─────────────────
// The bridge runs CLI agents; the user's OpenAI/Anthropic/local endpoints live in the
// gateway. Listing only the first made the feature look broken for anyone who had set up
// providers rather than CLIs.
assert.match(client, /export async function channelTargets/, 'one place that answers "what can answer"');
assert.match(client, /\/v1\/models/, 'the gateway knows its own destinations — ask it');
assert.match(client, /AbortSignal\.timeout/, 'a gateway that is not running must not hang the settings page');
assert.match(client, /return \{ agents, providers: \[\], models: \[\], gateway: false \}/,
  'no gateway is the NORMAL case for a bridge-only install, not an error');
assert.match(client, /!agentIds\.has\(m\.id\) && !promoted\.has\(m\.id\)/,
  'an agent the gateway also exposes must not appear twice under two spellings');
assert.match(js, /group\('Agents — on this machine', agents\)/, 'the two kinds fail differently — group them');
assert.match(js, /group\('Your providers — via the gateway', providers\)/);
// Publishing one endpoint makes the gateway list EVERY model that provider offers — 624 on a
// real machine. A flat list of 624 is not a picker; it is a haystack containing the one model
// the user configured. So the provider's own choice is promoted and the catalogue sits below.
assert.match(client, /const providers = \(configured\.length/, 'one entry per provider, not per model');
assert.match(client, /const promoted = new Set\(providers\.map/, 'a promoted model must not also appear in the tail');
assert.match(js, /group\(`All models \(\$\{models\.length\}\)`, models\)/,
  'the long tail stays available, at the bottom, with its size on the label');
const order = ['Agents — on this machine', 'Your providers — via the gateway', 'All models'];
const at = order.map((label) => js.indexOf(label));
assert.ok(at.every((i) => i > 0), 'every group must exist');
assert.deepEqual([...at].sort((a, b) => a - b), at,
  'agents and providers come before the catalogue — that ordering IS the fix');
assert.match(js, /\(unavailable\)/,
  'a configured target that is currently offline must still show as the selection');
assert.match(js, /kind === 'model' \? \{ model: id \} : \{ agent: id \}/, 'one choice, one field');

// ── an API key only leaves the browser with consent, one at a time ──────────────
// A phone answers with the browser closed, so whatever answers it must hold the credential
// outside the browser — that is a constraint, not a preference. Given it, the gateway is the
// right holder (0600 config, SSRF guard, redaction, spend metering). What must NOT happen is
// moving keys on the user's behalf: bulk-migrating every key the moment a gateway appears is
// the easy version and exactly what costs a privacy product its trust.
assert.match(js, /function publishableEndpoints/, 'the user\'s own APIs should be offerable');
assert.match(js, /group\('Your APIs — one tap to enable', toPublish\)/);
assert.match(js, /gatewayReachable \? publishableEndpoints/,
  'do not offer publishing when there is no gateway to publish to — that is a dead option');
assert.match(js, /confirmLabel: 'Publish to gateway'/,
  'publishing a credential must be confirmed, not inferred from a dropdown change');
assert.match(js, /if \(!ok\) \{ await renderChannels\(\); return; \}/,
  'declining must put the picker back, not leave it showing a target that was never enabled');
assert.match(js, /copies the API key/, 'and the dialog must say what actually happens');
assert.match(js, /readable only by your user account/, 'including who can read it afterwards');
assert.doesNotMatch(js, /publishAllEndpoints|migrateAllKeys/, 'one key at a time — least privilege');
// Read-modify-write: a destinations array built from a half-loaded editor would silently drop
// destinations the user already had.
assert.match(js, /const existing = Array\.isArray\(cfg\?\.destinations\)/,
  'publishing must merge into the gateway config, never replace it');

const store = read('js/store.js');
assert.match(store, /const SECRET_FIELDS = \['bridgeToken'\]/,
  'the bridge token grants every privileged route — seal it like an API key');
assert.match(client, /isn’t running/, 'an absent bridge is not a typo the user can fix in this form');
assert.match(js, /if \(!st\.supported\)/, 'the screen must hide its controls rather than let them fail on click');

// ── what a paired phone may do, in words a person can consent to ─────────────────
assert.match(js, /cannot write, run commands or browse/, '"trusted" is a word; a permission is a sentence');
assert.match(html, /not<\/strong> end-to-end encrypted/, 'say plainly that Telegram is a third party');

// ── styled ───────────────────────────────────────────────────────────────────────
for (const rule of [/\.ch-steps/, /\.ch-pair-out/, /\.ch-row/, /\.ch-danger/]) {
  assert.match(css, rule, `Channels styling missing: ${rule}`);
}

console.log('ok — Telegram is set up from Settings in two steps, and the token never lands in the browser');
