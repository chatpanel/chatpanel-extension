// Every widget you kept, on one page, running.
//
// Widgets were reachable only through a side-panel drawer that shows one at a time, so there
// was no answer to "what do I actually have?" — and a list of names is not an answer either,
// because a widget is a thing you look at. A screenshot of a timer is not a timer.
//
// The trust boundary is the part to keep honest: mounting them somewhere new must not grant
// them anything new.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const html = read('settings.html');
const js = read('settings.js');
const css = read('settings.css');
const host = read('js/widget-host.js');

// ── the tab exists and is wired both ways ────────────────────────────────────────
assert.match(html, /data-tab="widgets"/, 'the sidenav needs the tab button');
assert.match(html, /<section class="panel hidden" data-panel="widgets">/, 'and the panel');
assert.match(html, /id="wg-gallery"/, 'the gallery container');
assert.match(html, /id="wg-empty"/, 'and something to say when there are none');
assert.match(js, /if \(name === 'widgets'\) renderWidgetsGallery\(\);/, 'opening the tab must render it');
assert.match(js, /\$\('wg-refresh'\)\.onclick/, 'Refresh must be wired');

// ── lazy: never opened, never mounted ────────────────────────────────────────────
const fn = /async function renderWidgetsGallery\(\)[\s\S]*?\n\}/.exec(js)?.[0] || '';
assert.ok(fn, 'renderWidgetsGallery not found');
for (const mod of ['./js/widgets-store.js', './js/widget-host.js', './js/confirm-modal.js']) {
  assert.ok(
    js.includes(`import('${mod}')`),
    `${mod} must be imported at the call site — a user who never opens the tab pays nothing`,
  );
  assert.ok(
    !new RegExp(`^import[^\\n]*from '${mod.replace('.', '\\.')}'`, 'm').test(js),
    `${mod} must NOT be a static import`,
  );
}

// ── THE TRUST BOUNDARY. A new place to mount is not a new permission. ────────────
assert.match(
  host, /invokeCapability = null/,
  'the host must default to refusing capability calls',
);
assert.doesNotMatch(
  fn, /invokeCapability/,
  'settings must NOT supply a capability invoker — a granted call would then run unattended '
  + 'in a tab the user is only browsing through',
);
assert.match(fn, /mountWidget\(stage, rec\)/, 'and it must mount through the same sandboxed host');
// Grants are shown, not hidden behind a click: "what can this reach" is the question a
// gallery has to answer on sight.
assert.match(fn, /rec\.grants/, 'each tile must show what the widget was granted');
assert.match(fn, /no access to your data/, 'and say so plainly when it was granted nothing');

// ── running iframes must be torn down, not leaked ────────────────────────────────
assert.ok(
  /for \(const m of widgetMounts\) \{[\s\S]{0,120}?destroy\?\.\(\)/.test(fn),
  're-rendering must destroy the previous mounts — an orphaned iframe is a widget whose '
  + 'timers keep ticking in a page nobody is looking at',
);
assert.match(fn, /widgetMounts = \[\];/, 'and the list must be reset with them');

// ── an engine with no sandbox page must degrade, not show a broken frame ─────────
assert.match(host, /return null; \/\/ no sandbox page on this engine/, 'the host returns null there');
assert.match(fn, /if \(mounted\) widgetMounts\.push\(mounted\);/, 'so the caller must check');
assert.match(fn, /does not ship/, 'and explain the blank instead of leaving one');

// ── deleting is destructive, so it asks ──────────────────────────────────────────
assert.match(fn, /confirmDelete\(/, 'delete must confirm — the widget\'s saved state goes with it');
assert.match(fn, /cannot be undone/, 'and say so');

// ── laid out as a gallery, in tokens that work in both themes ────────────────────
const grid = /\.widget-gallery \{[^}]*\}/.exec(css)?.[0] || '';
assert.ok(grid, '.widget-gallery must be styled');
assert.match(grid, /grid-template-columns: repeat\(auto-fill/, 'a responsive grid, not a column of rows');
for (const rule of ['.widget-tile {', '.widget-grant {', '.widget-tile-stage {']) {
  const block = new RegExp(`${rule.replace(/[.{]/g, (c) => '\\' + c)}[^}]*\\}`).exec(css)?.[0] || '';
  assert.ok(block, `${rule} must be styled`);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, `${rule} must use tokens so both themes are right`);
}

console.log('settings widgets tab: ok');
