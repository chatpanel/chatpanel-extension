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
assert.match(fn, /Optional/, 'a stopped gateway reads as Optional');
assert.match(fn, /optional upgrade/i, 'and the copy says so');
assert.match(fn, /You\\'re set for local agents/, 'bridge-up + gateway-off is a complete state');
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
