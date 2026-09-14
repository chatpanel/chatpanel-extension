// U1 — one "ChatPanel local" status: the bridge (agents + skills) and the gateway (an
// optional upgrade). The framing is the deliverable: bridge up + gateway absent is the
// normal, complete state, never a warning.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/settings.css', import.meta.url), 'utf8');

// it sits atop the Agents tab (the common local-runtime entry point)
assert.match(html, /local-runtime-card/, 'the runtime card exists');
assert.match(html, /id="local-runtime"/, 'with a container the JS fills');
assert.match(html, /ChatPanel local/, 'named as one runtime, not two services');
assert.ok(html.indexOf('local-runtime-card') < html.indexOf('data-panel="agents"') + 400, 'and lives in the agents panel');

// it renders both, detecting each
const fn = js.match(/async function renderLocalRuntime\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(fn, 'renderLocalRuntime should exist');
assert.match(fn, /checkBridge/, 'detects the bridge');
assert.match(fn, /checkGateway/, 'detects the gateway');
assert.match(fn, /rt-bridge/, 'renders a bridge row');
assert.match(fn, /rt-gateway/, 'renders a gateway row');

// the framing: gateway-off is optional/complete, not an error
// Since gateway 0.6.92 the gateway CARRIES the bridge: it is the one thing to install, and
// the bridge row says it comes with it. A stopped gateway is "not installed", never an error;
// a bridge running on its own is a complete state (the light path), described, not warned.
assert.match(fn, /Not installed/, 'a stopped gateway reads as not installed — the step to take');
assert.match(fn, /const showBridge = \(bridgeOn && !bridgeIsGateways\) \|\| \(gwOn && !bridgeOn\);/, 'a bridge the gateway runs gets no row of its own — one install, one row; the row appears only on the light path or when the gateway\'s bridge is missing');
assert.match(fn, /bridgeIsGateways && counts/, 'the agents/skills count moves into the gateway row when the gateway runs the bridge');
assert.match(fn, /brings the bridge with it/, 'the summary says where the bridge comes from');
assert.match(fn, /The bridge runs on its own here/, 'bridge-up + gateway-off is a complete state, described as the light path');
assert.doesNotMatch(fn, /gateway.*not running.*error|✕ gateway/i, 'a stopped gateway is never an error');

// wired to render on tab open and on recheck
assert.match(js, /renderLocalRuntime\(\); \/\/ the unified/, 'renders when the Agents tab opens');
assert.match(js, /\$\('local-recheck'\)\.onclick = \(\) => renderLocalRuntime\(\{ recheck: true \}\)/, 'Recheck re-probes both');
// The Gateway is a SECTION of the Privacy tab now, not a tab of its own — the link still
// moves within the page (opens that tab + expands the section), it never navigates away.
assert.match(js, /openGatewaySection\(\)/, 'the gateway link jumps in-page, does not navigate');
assert.match(
  js,
  /function openGatewaySection\(\) \{[\s\S]*?data-tab="privacy"[\s\S]*?jumpToSection\('pv-gateway'\)/,
  'openGatewaySection opens the Privacy tab and expands the gateway section',
);

// styled: a running row gets the ok accent, off is neutral (not red)
assert.match(css, /\.runtime-row\.on \{[^}]*--ok/, 'a running row uses the ok color');
assert.doesNotMatch(css, /\.runtime-row[^{]*\{[^}]*var\(--danger\)/, 'no danger styling on the runtime rows');

console.log('local runtime tests passed');
