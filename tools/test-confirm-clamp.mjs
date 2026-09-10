// A confirm dialog is never sized by the thing it is asking about.
//
// Every delete on this page names its subject — "“{title}” will be deleted" — and a chat's
// title can be the first thing someone dictated into it, which is as long as they kept
// talking. One of those filled the whole side panel with transcript and pushed the Cancel and
// Delete buttons off-screen, so the only way out of "are you sure?" was to guess.
//
// Two lines of defence, because either alone is not enough: the text is clamped (a character
// count cannot help a single unbroken 300-character token), and the card scrolls with its
// buttons pinned (a clamp cannot help a caller that passes markup-free but very tall text).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const modal = read('js/confirm-modal.js');
const store = read('js/store.js');

// ── the dialog clamps what it is given ───────────────────────────────────────────
assert.match(modal, /const clamp = \(text, max\) =>/, 'the modal must clamp, not trust its callers');
assert.match(modal, /const MAX_TITLE = 80;/);
assert.match(modal, /const MAX_BODY = 220;/);
assert.match(modal, /t\.textContent = clamp\(title, MAX_TITLE\)/, 'the title must be clamped');
assert.match(modal, /const bodyText = clamp\(body, MAX_BODY\);/, 'and so must the body');
// Clamping at the ONE place, not at a dozen call sites that will not remember. Both fields
// go through the same helper — the side panel's dialog was unbounded while the history
// dashboard's had its own private truncation, which is exactly how one of them got missed.
// EVERY dialog in the module, not just the first one written: the destructive confirm, the
// passphrase ask and the text prompt each clamp both fields. A new dialog that forgets is
// exactly how the side panel got a card taller than the viewport the first time.
const dialogs = (modal.match(/^export function /gm) || []).length;
assert.equal((modal.match(/clamp\(title, MAX_TITLE\)/g) || []).length, dialogs, 'every dialog clamps its title');
assert.equal((modal.match(/clamp\(body, MAX_BODY\)/g) || []).length, dialogs, 'and its body');
assert.doesNotMatch(modal, /t\.textContent = title;/, 'nothing may bypass it');
assert.doesNotMatch(modal, /b\.textContent = body;/, 'nor for the body');
assert.doesNotMatch(modal, /\.textContent = title;/, 'nor in any other dialog');
// The full text stays reachable rather than being destroyed.
assert.match(modal, /b\.title = String\(body\)/, 'the untruncated text belongs on hover');

// ── and the buttons stay reachable whatever happens ──────────────────────────────
assert.match(modal, /\.cp-confirm-card\{max-height:86vh;overflow-y:auto\}/, 'the card must never exceed the viewport');
assert.match(modal, /\.cp-confirm-body\{[^}]*max-height:38vh;overflow-y:auto\}/, 'a long body scrolls inside itself');
assert.match(modal, /\.cp-confirm-row\{position:sticky;bottom:0/, 'a confirm you cannot click is worse than no confirm');
assert.match(modal, /\.cp-confirm-title\{overflow-wrap:anywhere\}/, 'an unbroken token must wrap, not overflow');

// ── the source: a title is bounded wherever it is set ────────────────────────────
assert.match(store, /export const MAX_TITLE_LEN = 48;/);
assert.match(store, /export function clampTitle\(text, fallback = 'New chat'\)/);
// Auto-titling already clamped. These are the three paths that did not.
assert.match(store, /title: clampTitle\(title\),/, 'createConversation — a job name comes from speech');
assert.match(store, /conv\.title = clampTitle\(title, conv\.title \|\| 'New chat'\);/, 'renameConversation');
assert.match(read('sidepanel.js'), /conv\.title = clampTitle\(event\?\.title/, 'a meeting/job thread name');

// clampTitle itself: the behaviour the callers rely on.
globalThis.chrome = { storage: { onChanged: { addListener() {} } } };
const { clampTitle, MAX_TITLE_LEN } = await import('../extension/js/store.js');
assert.equal(clampTitle(''), 'New chat', 'empty falls back');
assert.equal(clampTitle(null), 'New chat');
assert.equal(clampTitle('   '), 'New chat', 'whitespace is empty');
assert.equal(clampTitle('Short one'), 'Short one', 'a normal title is untouched');
assert.equal(clampTitle('x'.repeat(500)).length, MAX_TITLE_LEN, 'a dictated paragraph is cut to size');
assert.ok(clampTitle('x'.repeat(500)).endsWith('…'), 'and says it was cut');
assert.equal(clampTitle('a\n\nb   c'), 'a b c', 'newlines collapse — a title is one line');
assert.equal(clampTitle('', 'Keep this'), 'Keep this', 'the fallback is honoured');

console.log('confirm clamp: ok');
