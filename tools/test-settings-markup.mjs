import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');
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
assert.match(html, /class="ba-stablemcp"/, 'Custom bridge agents should expose a stable MCP setup command field.');
assert.match(html, /class="ba-trusttoolsarg"/, 'Custom bridge agents should expose a trusted tool names argument field.');
assert.match(js, /q\('\.ba-stablemcp'\)\.value = agent\.stableMcpSetupCommand \|\| ''/, 'Settings should load custom stable MCP setup commands.');
assert.match(js, /q\('\.ba-trusttoolsarg'\)\.value = agent\.trustToolsArg \|\| ''/, 'Settings should load custom trust-tools arguments.');
assert.match(js, /stableMcpSetupCommand: q\('\.ba-stablemcp'\)\.value\.trim\(\)/, 'Settings should save custom stable MCP setup commands.');
assert.match(js, /trustToolsArg: q\('\.ba-trusttoolsarg'\)\.value\.trim\(\)/, 'Settings should save custom trust-tools arguments.');
assert.match(js, /requiresStableMcp: Boolean\(q\('\.ba-stablemcp'\)\.value\.trim\(\)\)/, 'Settings should mark custom agents as stable-MCP based on the setup command.');
assert.match(css, /\.skill-mcp-pick-list\s*\{[^}]*overflow-y:\s*auto/s, 'Skills MCP selector should have an explicit scroll container');
assert.match(css, /\.skill-mcp-pick-list\.scrollable\s*\{[^}]*overflow-y:\s*scroll/s, 'Long Skills MCP selector lists should show a persistent scrollbar');
assert.match(css, /\.skill-mcp-pick-list::\-webkit-scrollbar-thumb/, 'Skills MCP selector should style the scrollbar thumb so scrolling is visible');

const accountPanel = html.match(/<section class="panel hidden" data-panel="license">([\s\S]*?)<\/section>/)?.[1] || '';
// Notes/Meetings/History are now sections of the merged "Workspace" tab (not separate
// panels); the Meetings section still surfaces local storage health.
const workspacePanel = html.match(/<section class="panel hidden" data-panel="workspace">([\s\S]*?)<\/section>/)?.[1] || '';
const meetingsSection = workspacePanel.match(/id="ws-meetings"[\s\S]*?(?=id="ws-history"|$)/)?.[0] || '';
assert.match(meetingsSection, /id="meeting-storage-health"/, 'Meetings (Workspace tab) should show local storage health.');
assert.match(js, /renderStorageHealth/, 'Settings should refresh the local storage health summary.');
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
assert.match(css, /--panel-2:\s*var\(--field\)/, 'Legacy plugin surfaces should inherit the active light or dark theme instead of falling back to dark.');
assert.match(css, /--line:\s*var\(--border\)/, 'Legacy plugin borders should inherit the active theme.');
assert.match(css, /\.routing-model\s*\{[^}]*grid-template-columns:[^}]*repeat\(5,/s, 'Each routing model should keep its five selectors in one compact row.');
assert.match(css, /\.routing-model\s*>\s*select\s*\{[^}]*grid-column:\s*auto/s, 'Routing selectors should no longer be forced onto separate rows.');
assert.match(css, /\.routing-caps\s*\{[^}]*flex-wrap:\s*nowrap/s, 'Model capability toggles should stay inline.');
assert.match(js, /CAP_SHORT_LABELS/, 'Dense model rows should use compact capability labels while preserving their full tooltip text.');
assert.match(accountPanel, /id="autobackup-destination"/, 'Automatic backup should offer a destination selector.');
assert.doesNotMatch(accountPanel, /id="backup-export"/, 'Account should not offer a separate plaintext-capable export path.');
assert.doesNotMatch(accountPanel, /Password \(optional\)|leave blank for none|plain browsable/, 'Backup UI should never advertise an unencrypted backup.');
assert.match(accountPanel, /id="backup-password"[^>]*required/, 'Creating and restoring encrypted backups should use one required password field.');
assert.match(accountPanel, /All new backups are compressed and encrypted locally/, 'Account should clearly state that every newly created backup is encrypted.');
assert.match(accountPanel, /Existing legacy ChatPanel ZIP exports can still be restored/, 'Older plaintext exports should remain restorable for migration.');
assert.doesNotMatch(js, /exportDataArchive/, 'Settings should not retain the old plaintext archive export path.');
assert.doesNotMatch(store, /exportDataArchive/, 'The plaintext full-backup archive creator should be removed, not merely hidden.');
assert.match(accountPanel, /value="drive"/, 'Automatic backup should support Drive-only with no local file.');
assert.match(accountPanel, /value="both"/, 'Automatic backup should support local and Drive together.');
assert.match(accountPanel, /id="drive-backup-restore"/, 'Settings should restore encrypted backups directly from Drive.');
assert.match(accountPanel, /id="autobackup-device-name"/, 'Automatic Drive backups should have a user-recognizable device name.');
assert.match(accountPanel, /id="drive-backup-restore-all"/, 'Settings should merge the latest Drive snapshot from every device.');
assert.match(accountPanel, /seven weekday files per device/, 'Settings should explain per-device rotation.');
assert.match(accountPanel, /settings and sign-ins were kept|settings stay local/, 'Settings should explain history-only cross-device restore.');
assert.match(js, /includeSettings:\s*!historyOnly/, 'Drive restore should explicitly prevent machine-local settings from crossing devices.');
assert.match(js, /latestGoogleDriveBackupsByDevice/, 'Settings should merge the latest snapshot from each Drive device.');
assert.doesNotMatch(accountPanel, /id="drive-client-id"/, 'Users should not have to configure a Google OAuth client id.');
assert.match(accountPanel, /No Google developer setup is required/, 'Settings should explain the one-time user authorization flow.');
assert.match(accountPanel, /device-local key/, 'Settings should disclose how unattended backup credentials are stored.');
assert.match(
  css,
  /\.field\s*>\s*:is\(input,\s*select,\s*textarea,\s*\.combo\)\s*\{[^}]*flex:\s*0\s+0\s+auto/s,
  'Controls inside vertical .field layouts should keep natural height instead of stretching to the combobox flex basis.',
);

console.log('settings markup tests passed');
