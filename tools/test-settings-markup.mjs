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

// Skills use the SAME branded collapsible card as endpoints and agents — one
// visual language for every configuration list, and a long list you can scan.
const skillTpl = html.match(/<template id="skill-tpl">([\s\S]*?)<\/template>/)?.[1] || '';
assert.ok(skillTpl, 'skill template should exist');
for (const cls of ['brand-card', 'card-toggle', 'card-index', 'card-brand', 'card-summary', 'entity-foot', 'card-foot-name']) {
  assert.ok(skillTpl.includes(cls), `Skill cards should carry .${cls}, like endpoint and agent cards.`);
}
assert.match(skillTpl, /class="s-enabled"/, 'A skill should be switchable off without being deleted.');
assert.match(html, /id="toggle-skills"/, 'The Skills list should have an Expand all / Collapse all button.');
assert.match(html, /id="add-skill-bottom"/, 'The Skills list should repeat Add skill under the list.');
assert.match(js, /wireCollapsible\(node, skillKey\(skill\)\)/, 'Skill cards should be collapsible.');
assert.match(js, /wireExpandAll\('toggle-skills'/, 'Expand all should be wired for skills.');
assert.match(js, /setCardIndex\(card, i, list\.length, 'Skill'\)/, 'Skill cards should be numbered "N of M".');
assert.match(js, /forgetCard\(skillKey\(skill\)\)/, 'Deleting a skill should drop its remembered open/closed state.');
// A locked card you cannot open is a prompt a Free user cannot read before
// deciding to upgrade — the chevron is deliberately spared by lockCard.
assert.match(
  js,
  /if \(el\.classList\.contains\('card-toggle'\)\) return;/,
  'Locking the Skills tab on Free should still let cards be expanded and read.',
);

// The long Workspace preference groups are collapsible <details>, so a person can fold
// away Meetings or History rather than scroll past them. Each stays a navigation target:
// a link into a collapsed section opens it first, and the collapse state is remembered
// per viewer without throwing in a private window.
const workspace = html.match(/data-panel="workspace">([\s\S]*?)<section class="panel/)?.[1] || '';
assert.equal((workspace.match(/<details class="ws-section"/g) || []).length, 4, 'Memory, Notes, Meetings and History are collapsible sections');
assert.equal((workspace.match(/<summary class="ws-heading"/g) || []).length, 4, 'each section heading is its summary');
assert.equal((workspace.match(/<details/g) || []).length, (workspace.match(/<\/details>/g) || []).length, 'section details are balanced');
assert.match(
  js,
  /for \(let n = node; n; n = n\.parentElement\) if \(n\.tagName === 'DETAILS'\) n\.open = true;/,
  'navigating to a section opens it — and every section above it — first',
);
assert.match(js, /cp:settings:ws-collapsed/, 'collapse state is remembered');
assert.match(js, /catch \{ \/\* private window/, 'and a blocked localStorage does not throw');
assert.match(css, /details\.ws-section\[open\] > summary\.ws-heading::after/, 'the chevron reflects open/closed');
// Memory puts words in front of a model on the user's behalf on EVERY turn, so it is the one
// feature whose management view is load-bearing: if a person cannot read what is stored, edit a
// wrong one and delete it, the honest advice would be to turn the feature off.
assert.match(workspace, /id="memory-enabled"/, 'memory can be turned off');
assert.match(workspace, /id="memory-offers"/, 'the "remember this?" offers can be turned off separately');
assert.match(workspace, /id="memory-list"/, 'stored memories are listed');
assert.match(workspace, /id="memory-clear"/, 'and can all be forgotten');
assert.match(js, /confirm\(`Forget all/, 'forgetting everything is confirmed — nothing can rebuild it');
assert.match(js, /text\.onblur = async \(\) => \{/, 'each memory is editable in place');
assert.match(js, /createElement\('textarea'\)[\s\S]{0,400}mem-text/, 'memory text is a textarea — shown in full, never truncated to one line');

// Privacy and Gateway are ONE tab. They answer the same question — what leaves this device —
// and split across two tabs they duplicated the NER model catalog outright. The merge is only
// safe while every old entry point still lands where it used to, so this block pins the three
// things that could silently break: the deep-link, the sections, and the single catalog.
const privacy = html.match(/data-panel="privacy">([\s\S]*?)<section class="panel/)?.[1] || '';
assert.doesNotMatch(html, /data-tab="gateway"/, 'the Gateway tab button is gone — it is a section now');
assert.match(html, /data-tab="privacy"[^>]*>[\s\S]{0,120}?Privacy &amp; Gateway/, 'the merged tab names both');
assert.match(
  js,
  /gateway: \{ tab: 'privacy', section: 'pv-gateway' \}/,
  'settings.html#gateway still resolves — to the Privacy tab, gateway section',
);
for (const id of ['pv-redaction', 'pv-boundary', 'pv-gateway', 'pv-models']) {
  assert.match(privacy, new RegExp(`<details class="ws-section" id="${id}"`), `${id} is a collapsible section`);
}
assert.equal(
  (privacy.match(/<summary class="ws-heading"/g) || []).length,
  (privacy.match(/<details class="ws-section"/g) || []).length,
  'every privacy section heading is its summary',
);
assert.equal(
  (privacy.match(/<details/g) || []).length,
  (privacy.match(/<\/details>/g) || []).length,
  'privacy section details are balanced',
);
// One in-process NER, so one catalog. The Privacy detector links to it instead of rendering a
// second copy that could show a different active model than the one actually loaded.
assert.equal((html.match(/id="gw-models"/g) || []).length, 1, 'exactly one NER model catalog');
assert.doesNotMatch(html, /id="priv-models"/, 'the duplicate NER catalog is gone');
assert.doesNotMatch(js, /PRIV_NER/, 'and so is the context that rendered it');
assert.match(privacy, /data-jump="pv-models"/, 'the detector links to the one catalog');
assert.match(js, /function wireSectionJumps\(\)/, 'data-jump links are wired');
// Nothing was dropped in the merge: every control the two tabs owned still exists.
for (const id of ['gw-url', 'gw-check', 'gw-status', 'gw-token', 'gw-warm-search', 'gw-backup-key',
  'gw-preview', 'gw-config', 'gw-tier', 'gw-det-backend', 'gw-dictionary', 'gw-dests', 'gw-tools-data',
  'gw-stt-models', 'gw-diarize-models', 'gw-log', 'gw-logs', 'gw-origins', 'gw-pro-activate', 'gw-save',
  'gw-test-run', 'internal-guard', 'internal-patterns', 'internal-ceiling', 'priv-mode', 'priv-applyto',
  'priv-detection', 'priv-dictionary', 'priv-scope-chat', 'priv-tooldata', 'priv-flow-run']) {
  assert.match(privacy, new RegExp(`id="${id}"`), `${id} survived the merge`);
}

console.log('settings markup tests passed');

// Switching a card's Provider ACROSS the WebLLM boundary rebuilds the card, and it must
// rebuild it around the STORED endpoint. Binding the fresh card to a copy meant every later
// edit — including Save — wrote into an object that was not in settings.endpoints: the card
// answered "✓ Saved" while saveSettings persisted the untouched original, so the endpoint
// stayed "New endpoint" with no model and the side panel never saw a WebLLM endpoint at all
// (hence "the model download seems not happening").
{
  const rebuild = js.match(/if \(nowWebllm !== nodeIsWebllm\) \{([\s\S]*?)\n {4}\}/)?.[1] || '';
  assert.ok(rebuild, 'the WebLLM provider-boundary rebuild should exist');
  // Code only — the comment above the fix names the old broken call on purpose.
  const code = rebuild.replace(/\/\/.*$/gm, '');
  assert.match(code, /Object\.assign\(ep, base\)/, 'the new kind/model is written back onto the stored endpoint');
  assert.match(code, /endpointCard\(ep\)/, 'the rebuilt card is bound to the stored endpoint');
  assert.doesNotMatch(code, /endpointCard\(base\)/, 'never bind a card to a detached copy — Save would write to nothing');
  assert.match(code, /await saveSettings\(settings\)/, 'the switch is persisted, not left only in memory');
}

console.log('ok — a WebLLM provider switch rebuilds the card around the stored endpoint');
