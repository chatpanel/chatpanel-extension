// Wiring guard for the Notes authoring features (find/replace, outline, format keys,
// smart lists, new-note panel default).
//
// The RULES are unit-tested in @chatpanel/events (text-search + markdown-authoring). What
// can still break here is the wiring: an id that exists in the JS but not the HTML, a
// shortcut silently stolen back by the list filter, or the shared core being re-implemented
// locally instead of imported. All of those are invisible until someone opens the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../extension/notes.html');
const js = read('../extension/notes.js');
const css = read('../extension/notes.css');
const editor = read('../extension/js/editor-cm.js');

// ── Every element the find bar drives must exist in the markup ──────────────────
const FIND_IDS = [
  'n-find', 'n-find-q', 'n-find-r', 'n-find-count', 'n-find-case', 'n-find-word',
  'n-find-re', 'n-find-prev', 'n-find-next', 'n-find-toggle', 'n-find-close',
  'n-find-one', 'n-find-all', 'n-find-replace-row', 'n-outline',
];
for (const id of FIND_IDS) {
  assert.match(html, new RegExp(`id="${id}"`), `notes.html must define #${id}`);
  assert.match(js, new RegExp(`'${id}'`), `notes.js must reference #${id}`);
}

// ── The shared cores are IMPORTED, not reimplemented ────────────────────────────
assert.match(js, /import\('\.\/js\/events\/text-search\.js'\)/, 'find must use the shared text-search core');
assert.match(js, /import\('\.\/js\/events\/markdown-authoring\.js'\)/, 'authoring must use the shared markdown core');
// Both are dynamic — a static import would drag them onto first paint.
assert.doesNotMatch(js, /^import .*events\/text-search\.js/m, 'text-search must not be statically imported');
assert.doesNotMatch(js, /^import .*events\/markdown-authoring\.js/m, 'markdown-authoring must not be statically imported');
// And the logic must not have been copied back in locally.
assert.doesNotMatch(js, /function\s+(findMatches|replaceAll|outlineOf|continueList|toggleWrap)\s*\(/,
  'search/authoring rules belong in @chatpanel/events, not re-declared in notes.js');

// ── ⌘F is find-in-note; the notes-list filter moved to ⌘⇧F ──────────────────────
assert.match(js, /k === 'f' && e\.altKey.*openFind\(\{ replace: true \}\)/, '⌘⌥F opens replace');
assert.match(js, /k === 'f' && e\.shiftKey.*\$\('n-search'\)\.focus\(\)/, '⌘⇧F focuses the notes-list filter');
assert.match(js, /else if \(k === 'f'\) \{ e\.preventDefault\(\); openFind\(\); \}/, '⌘F opens find-in-note');
// The old binding must be gone, or ⌘F silently keeps filtering the list.
assert.doesNotMatch(js, /k === 'f' && !e\.shiftKey.*n-search/, 'the old ⌘F → list-filter binding must be removed');
assert.match(js, /k === 'g' &&/, '⌘G / ⌘⇧G step between matches');
assert.match(js, /k === 'o' && e\.shiftKey.*setSideTab\('outline'\)/, '⌘⇧O opens the outline');

// ── Outline is a real side tab, wired end to end ────────────────────────────────
assert.match(js, /const SIDE_TABS = \[[^\]]*'outline'/, 'outline must be a registered side tab');
assert.match(js, /outline: 'n-outline'/, 'outline must map to its pane');
assert.match(js, /t === 'outline'\) renderOutline\(\)/, 'selecting the outline tab must render it');
assert.match(html, /data-side="outline"/, 'outline needs a tab button');
assert.match(css, /\.outline-item/, 'outline items need styling');

// ── Find highlighting reaches CodeMirror through the editor facade ──────────────
assert.match(editor, /setFindMatches\(/, 'the CM facade must expose setFindMatches');
assert.match(editor, /findField/, 'CM must register the find decoration field');
assert.match(css, /\.cm-find-match/, 'match highlight needs a style');
assert.match(css, /\.cm-find-current/, 'the current match needs a distinct style');

// ── Smart lists run on BOTH surfaces ────────────────────────────────────────────
const listCalls = js.match(/listKey\(e\)/g) || [];
assert.ok(listCalls.length >= 2, 'smart lists must be wired for the textarea AND the live editor');

// ── New notes hide the assistant panel, once, reversibly ────────────────────────
assert.match(js, /collapseSideForNewNote\(\)/, 'new notes must collapse the assistant panel');
assert.match(js, /chatpanel\.notes\.sideOnNew/, 'the always-open preference must be persisted');
assert.match(js, /'Always open'/, 'the user must be offered a way to keep the panel open');
// The preference has to actually short-circuit the collapse, not just be stored.
assert.match(js, /getItem\(SIDE_ON_NEW_KEY\) === 'open'\) return/, 'the preference must suppress the auto-collapse');

// ── Format shortcuts cover the set, and only fire in the body ───────────────────
for (const fmt of ['bold', 'italic', 'link', 'code', 'strike', 'ul', 'ol', 'task', 'quote']) {
  assert.match(js, new RegExp(`'${fmt}'`), `format shortcut table must include ${fmt}`);
}
assert.match(js, /inBody\(\) && FMT_KEYS/, 'format keys must require the body to have focus');
assert.match(js, /applyHeading\(Number\(e\.code\.slice\(5\)\)\)/, '⌘⌥1..⌘⌥6 must set heading level');
// Shift rewrites e.key, so digit/punctuation bindings must key off e.code or they are dead.
assert.match(js, /'shift\+Digit8': 'ul'/, 'list shortcuts must be keyed on e.code, not the shifted glyph');
assert.match(js, /test\(e\.code[^)]*\) \? e\.code : k/, 'fmtKey must prefer e.code for non-letter chords');
// Chrome owns plain ⌘1..⌘8 (tab switching) — the heading chord must require Alt.
assert.match(js, /inBody\(\) && e\.altKey && \/\^Digit\[1-6\]/, 'heading chord must require Alt');
// ⌘K must not be swallowed by omni search while the caret is in the body.
assert.match(js, /k === 'k' && !inBody\(\)/, '⌘K in the body is link, not omni search');

console.log('notes-authoring tests passed');
