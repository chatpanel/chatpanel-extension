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
