// "How do I install this?" belongs in the card that says it is missing.
//
// The bridge and gateway install commands used to live in a <details> further down the
// Agents tab, and the status card said "install it with the commands below" — one more thing
// to find at the exact moment someone has been told something is not working. Worse, the
// first command they met was a macOS `curl` line, on Windows.
//
// Now the commands are in the runtime rows themselves: host OS first, open when the thing is
// not running, collapsed when it is, and the one step worth doing next is highlighted in
// colours that work in BOTH themes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('settings.js');
const html = read('settings.html');
const css = read('settings.css');

// ── the commands are here, for both components, and only here ────────────────────
for (const [what, probe] of [
  ['bridge', /dl\.chatpanel\.net\/bridge\/install\.sh/],
  ['bridge', /dl\.chatpanel\.net\/bridge\/install\.ps1/],
  ['bridge', /npx @chatpanel\/bridge/],
  ['gateway', /dl\.chatpanel\.net\/gateway\/install\.sh/],
  ['gateway', /dl\.chatpanel\.net\/gateway\/install\.ps1/],
]) {
  assert.match(js, probe, `the ${what} install command must be in the status card`);
}
assert.doesNotMatch(
  html, /id="bridge-install-help"/,
  'the duplicated static install block must be gone — two copies of a command drift apart',
);
// Scoped to the Agents tab: the Gateway tab has its own configuration walkthrough further
// down its own page, and "below" is accurate there.
const agentsPanel = /<section class="panel[^"]*" data-panel="agents">[\s\S]*?<\/section>/.exec(html)?.[0] || '';
assert.ok(agentsPanel, 'agents panel not found');
assert.doesNotMatch(
  agentsPanel, /commands below/i,
  'nothing on the Agents tab may send the reader "below" for commands that are now above',
);
assert.match(
  agentsPanel, /ChatPanel local/,
  'the Agents tab should point at the card that now carries the commands',
);
// Both rows render one.
assert.match(js, /install: 'bridge'/);
assert.match(js, /install: 'gateway'/);

// ── open when missing, collapsed when running ────────────────────────────────────
assert.match(
  js, /wrap\.open = !running;/,
  'the block must open itself exactly when the component is NOT installed',
);

// ── the host OS leads ────────────────────────────────────────────────────────────
// The BODY, not the file: the prose above it names navigator.platform to explain why it is
// not used, and a check that cannot tell an explanation from a call is not a check.
const hostOsFn = /function hostOs\(\)\s*\{[\s\S]*?\n\}/.exec(js)?.[0] || '';
assert.ok(hostOsFn, 'hostOs() not found');
assert.match(hostOsFn, /userAgentData\?\.platform/, 'prefer userAgentData over the UA string');
assert.doesNotMatch(
  hostOsFn, /navigator\.platform/,
  'navigator.platform misreports Apple Silicon — it must not decide which command shows first',
);
assert.match(js, /\(b\.os === os\) - \(a\.os === os\)/, 'this machine\'s command must sort first');

// ── the commands must survive being rendered ─────────────────────────────────────
// They contain `&&` and `|`. Interpolated into innerHTML they come back HTML-escaped, and a
// Copy button then hands the user something that does not run.
assert.match(js, /code\.textContent = cmd;/, 'the command must be set as text, not markup');
assert.match(js, /navigator\.clipboard\.writeText\(cmd\)/, 'Copy must copy the raw command');
assert.ok(
  /catch \{[\s\S]{0,400}?copy\.textContent = 'Press Ctrl\/⌘\+C';/.test(js),
  'a refused clipboard must say so — never report a copy that did not happen',
);

// ── exactly ONE next step, and it is the one that unblocks the other ─────────────
assert.match(js, /next: !bridgeOn,/, 'nothing local works without the bridge');
assert.match(
  js, /next: bridgeOn && !gwOn,/,
  'the gateway becomes the next step only once the bridge is up — it needs the bridge running',
);

// ── the highlight must read in BOTH themes ───────────────────────────────────────
// Brace-matched rather than regex-sliced: the dark block nests a :root inside the media
// query, and a lazy `[\s\S]*?\n\}` stops at whichever closing brace happens to be first.
const blockAt = (source, needle) => {
  const start = source.indexOf(needle);
  if (start < 0) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
};
const root = blockAt(css, ':root {');
const dark = blockAt(css, '@media (prefers-color-scheme: dark)');
assert.ok(root && dark, 'could not find the light/dark token blocks');
for (const token of ['--accent', '--accent-weak', '--accent-line', '--accent-ink']) {
  assert.ok(root.includes(`${token}:`), `${token} must be defined for the light theme`);
  assert.ok(dark.includes(`${token}:`), `${token} must be redefined for the dark theme`);
}
// A solid accent fill needs a foreground that flips — white on the light theme's indigo is
// right, and unreadable on the dark theme's much lighter one.
assert.notEqual(
  /--accent-ink:\s*([^;]+);/.exec(root)?.[1]?.trim(),
  /--accent-ink:\s*([^;]+);/.exec(dark)?.[1]?.trim(),
  'the ink on the accent must differ between themes, or one of them is unreadable',
);

const nextBadge = /\.runtime-next\s*\{[\s\S]*?\}/.exec(css)?.[0] || '';
assert.ok(nextBadge, '.runtime-next must be styled');
assert.match(nextBadge, /background:\s*var\(--accent\)/);
assert.match(nextBadge, /color:\s*var\(--accent-ink\)/);
assert.doesNotMatch(
  nextBadge, /#[0-9a-f]{3,8}\b/i,
  'no hardcoded colour in the badge — it would be wrong in one theme or the other',
);

const nextRow = /\.runtime-row\.next\s*\{[\s\S]*?\}/.exec(css)?.[0] || '';
assert.ok(nextRow, '.runtime-row.next must be styled');
assert.doesNotMatch(nextRow, /#[0-9a-f]{3,8}\b/i, 'the highlighted row must be built from tokens');
// Colour alone is not a signal. The row carries a border and a badge too.
assert.match(nextRow, /border-left-color/, 'the highlight must not rely on hue alone');
assert.match(js, /Next step<\/span>/, 'the badge must say what it means in words');

// A long install command must scroll inside its own box, never widen the card.
const cmdBox = /\.install-cmd code\s*\{[\s\S]*?\}/.exec(css)?.[0] || '';
assert.match(cmdBox, /overflow-x:\s*auto/, 'a long curl line must scroll, not stretch the page');

// ── the failing-bridge path points AT the commands, rather than describing them ──
const testBridge = /async function testBridge\(\)[\s\S]*?\n\}/.exec(js)?.[0] || '';
assert.ok(testBridge, 'testBridge() not found');
assert.match(testBridge, /help\.open = true;/, 'a failed Test must reveal the install commands');
assert.match(testBridge, /scrollIntoView/, 'and scroll to them — this is the whole point');

console.log('local runtime install: ok');
