// The Privacy & Gateway panel, navigable — and a sub-tab that shows ONE thing.
//
// It was eight collapsible sections, three of them nested two deep inside a container that
// only exists once the gateway connects. Collapsed is right; the problem was that finding a
// feature meant opening summaries one at a time until the right one appeared.
//
// The bar is generic (js/subtabs.js) and the panel only declares its groups, so this checks
// the mechanism where it can and the declaration where it must.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('settings.js');
const html = read('settings.html');
const css = read('settings.css');
const mod = read('js/subtabs.js');

// ── every declared tab must point at a section that exists ───────────────────────
const decl = /const PRIVACY_SUBTABS = \[[\s\S]*?\n\];/.exec(js)?.[0] || '';
assert.ok(decl, 'PRIVACY_SUBTABS not found');
const targets = [...decl.matchAll(/target: '([^']+)'/g)].map((m) => m[1]);
assert.ok(targets.length >= 8, `expected the panel's sections to be covered, got ${targets.length}`);
for (const id of targets) {
  assert.ok(html.includes(`id="${id}"`), `sub-tab points at #${id}, which is not in the markup`);
}
// Every ws-section in the privacy panel should be reachable — a section with no tab is a
// feature that just became unreachable, which is worse than the scroll it replaced.
const panel = html.slice(html.indexOf('data-panel="privacy"'), html.indexOf('data-panel="channels"'));
const sections = [...panel.matchAll(/<details class="ws-section" id="([^"]+)"/g)].map((m) => m[1]);
for (const id of sections) {
  assert.ok(targets.includes(id), `#${id} has no sub-tab — it is now unreachable`);
}
// Tabs whose content lives inside the gateway config must say so, or selecting one shows
// an empty panel.
for (const id of ['gw-sec-redaction', 'gw-sec-routing', 'pv-models', 'gw-sec-monitor', 'gw-sec-test']) {
  assert.ok(
    new RegExp(`target: '${id}', requires: 'gw-config'`).test(decl),
    `#${id} lives inside #gw-config and must declare requires`,
  );
}
assert.ok(html.includes('id="gw-config"'), 'the required container must exist');

// ── the escape hatches the panel depends on ──────────────────────────────────────
assert.match(mod, /const KEEP = '\[data-subtab-keep\]';/);
for (const marked of ['card pv-intro', 'gw-savebar', 'id="pv-subtabs"']) {
  const line = panel.split('\n').find((l) => l.includes(marked)) || '';
  assert.match(line, /data-subtab-keep/, `${marked} must survive a tab switch`);
}

// ── a pass-through container must not add a second title ─────────────────────────
// #pv-gateway is an ancestor of five tabs. Its <summary> would otherwise render above every
// one of them as a redundant heading — and it has a tab of its own.
assert.ok(
  /if \(child\.tagName === 'SUMMARY'\) \{[\s\S]{0,400}?hide\(child\);/.test(mod),
  'the summary of a container being passed through must be hidden',
);
assert.ok(
  /if \(child !== target\) walk\(child\);/.test(mod),
  'walk must never descend into the target — its own subtree is the tab',
);
// …and the heading itself must not use positional language a tab bar makes false.
// Comments stripped: the note explaining WHY the wording changed necessarily quotes the old
// wording, and a check that cannot tell a comment from the page is not a check.
const panelText = panel.replace(/<!--[\s\S]*?-->/g, '');
assert.doesNotMatch(panelText, /extends all of the above/, '"above" means nothing in a tab bar');

// ── hiding must be reversible, and must not fight another owner ──────────────────
assert.ok(/const hidden = new Set\(\);/.test(mod), 'what was hidden must be remembered');
assert.ok(
  /for \(const el of hidden\) el\.hidden = false;/.test(mod),
  'switching tabs must restore everything the previous tab hid',
);
assert.ok(
  /else if \(!ownerHidden\(child\)\) \{[\s\S]{0,220}?hide\(child\)/.test(mod),
  'an element hidden by someone else must stay hidden when we put things back',
);

// ── an unavailable tab is disabled, not deleted ──────────────────────────────────
assert.match(mod, /btn\.disabled = !ok;/, 'a gateway-only tab must be shown as unavailable');
assert.doesNotMatch(mod, /btn\.remove\(\)/, 'a tab that vanishes teaches nothing');
assert.match(mod, /Connect the gateway to use this/, 'and must say what would make it available');
// The gateway connecting or dropping has to re-evaluate the bar.
assert.equal(
  (js.match(/privacySubtabs\?\.refresh\(\)/g) || []).length, 2,
  'both gw-config visibility changes must refresh the bar',
);

// ── deep links must land on a visible section ────────────────────────────────────
const jump = /function jumpToSection\([\s\S]*?\n\}/.exec(js)?.[0] || '';
assert.match(
  jump, /panelSubtabs\.values\(\)[\s\S]{0,80}?revealFor\(el\)/,
  '#gateway and the panel\'s deep links must switch to the tab holding the target — on ANY '
  + 'panel, since every long panel now has a bar',
);

// ── keyboard, and theme-correct styling ──────────────────────────────────────────
assert.match(mod, /role', 'tablist/, 'the bar is a tablist');
assert.match(mod, /ArrowRight/, 'arrow keys must move between tabs');
const subtabCss = /\.subtab \{[\s\S]*?\}/.exec(css)?.[0] || '';
assert.ok(subtabCss, '.subtab must be styled');
assert.doesNotMatch(subtabCss, /#[0-9a-f]{3,8}\b/i, 'built from tokens, so both themes are right');
// The selected tab must be the most obvious thing in the row — an underline was too easy to
// scroll past, which is the whole failure a navigation control exists to prevent.
const activeCss = /\.subtab\.active,\n\.subtab\.active:hover \{[^}]*\}/.exec(css)?.[0] || '';
assert.ok(activeCss, '.subtab.active must be styled');
assert.match(activeCss, /background: var\(--accent\)/, 'the selected tab is filled, not underlined');
assert.match(activeCss, /color: var\(--accent-ink\)/, 'and its label must stay readable in both themes');
assert.doesNotMatch(activeCss, /#[0-9a-f]{3,8}\b/i, 'built from tokens, so both themes are right');
assert.match(css, /\.subtabs \{[^}]*overflow-x: auto/, 'the bar scrolls rather than wrapping');
assert.match(css, /\.subtabs \{[^}]*background: var\(--field\)/, 'the bar reads as a control, not bare text');

console.log('privacy subtabs: ok');
