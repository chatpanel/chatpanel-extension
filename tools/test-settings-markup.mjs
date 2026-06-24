import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/settings.css', import.meta.url), 'utf8');
const template = html.match(/<template id="endpoint-tpl">([\s\S]*?)<\/template>/)?.[1] || '';
assert.ok(template, 'endpoint template should exist');

const header = template.match(/<div class="entity-head">([\s\S]*?)<\/div>/)?.[1] || '';
assert.doesNotMatch(header, /ep-test/, 'endpoint Test button should not be in the card header');

const providerField = template.match(/<div class="field"><label>Provider<\/label>([\s\S]*?)<\/div>/)?.[1] || '';
assert.match(providerField, /input class="ep-provider"/, 'Provider picker should be a searchable input');
assert.doesNotMatch(providerField, /<select class="ep-provider"/, 'Provider picker should not be a plain select');

const modelRow = template.match(/<div class="row">\s*<label>Model<\/label>([\s\S]*?)<\/div>/)?.[1] || '';
assert.match(modelRow, /ep-load/, 'Model row should contain Load models');
assert.match(modelRow, /ep-test/, 'Model row should contain Test beside Load models');
assert.ok(modelRow.indexOf('ep-test') > modelRow.indexOf('ep-load'), 'Test should appear after Load models');

assert.match(js, /skill-mcp-pick-list/, 'Skills MCP selector should render a dedicated pick list class');
assert.match(js, /skill-mcp-pick/, 'Skills MCP selector should render dedicated selectable rows');
assert.match(js, /q\('\.s-mcp-mode'\)\.value = skill\.mcpMode \|\| 'none'/, 'Skills editor should default missing MCP mode to No MCP tools');
assert.match(js, /mcpMode: 'none'/, 'New custom skills should default to No MCP tools');
assert.match(css, /\.skill-mcp-pick-list\s*\{[^}]*overflow-y:\s*auto/s, 'Skills MCP selector should have an explicit scroll container');
assert.match(css, /\.skill-mcp-pick-list\.scrollable\s*\{[^}]*overflow-y:\s*scroll/s, 'Long Skills MCP selector lists should show a persistent scrollbar');
assert.match(css, /\.skill-mcp-pick-list::\-webkit-scrollbar-thumb/, 'Skills MCP selector should style the scrollbar thumb so scrolling is visible');

const accountPanel = html.match(/<section class="panel hidden" data-panel="license">([\s\S]*?)<\/section>/)?.[1] || '';
assert.match(accountPanel, /class="account-secondary-grid"/, 'Account secondary cards should be grouped in a responsive grid');
assert.ok(
  accountPanel.indexOf('account-secondary-grid') < accountPanel.indexOf('id="about-card"'),
  'About card should live inside the Account secondary grid',
);
assert.ok(
  accountPanel.indexOf('id="about-card"') < accountPanel.indexOf('id="backup-card"'),
  'Backup card should remain after About inside the Account secondary grid',
);
assert.match(css, /\.account-secondary-grid\s*\{[^}]*display:\s*grid/s, 'Account secondary cards should use CSS grid');
assert.match(css, /\.account-secondary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax/s, 'Account secondary grid should use available width responsively');
assert.match(css, /\.account-secondary-grid\s+\.card\s*\{[^}]*margin-bottom:\s*0/s, 'Cards inside Account secondary grid should not reserve full-width card spacing');
assert.match(
  css,
  /\.field\s*>\s*:is\(input,\s*select,\s*textarea,\s*\.combo\)\s*\{[^}]*flex:\s*0\s+0\s+auto/s,
  'Controls inside vertical .field layouts should keep natural height instead of stretching to the combobox flex basis.',
);

console.log('settings markup tests passed');
