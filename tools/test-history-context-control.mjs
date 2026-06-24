import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HISTORY_CONTEXT_MODES,
  historyContextForMode,
  historyContextLabel,
  normalizeHistoryContextMode,
} from '../extension/js/history-context.js';

assert.equal(normalizeHistoryContextMode(undefined), HISTORY_CONTEXT_MODES.OFF);
assert.equal(normalizeHistoryContextMode('both'), HISTORY_CONTEXT_MODES.ALL);
assert.equal(normalizeHistoryContextMode('meetings'), HISTORY_CONTEXT_MODES.MEETINGS);

assert.deepEqual(
  historyContextForMode('off', { canMeetings: true }),
  { enabled: false, scope: 'all', includeMeetings: false, mode: 'off' },
  'History context should default to off for privacy.',
);
assert.deepEqual(
  historyContextForMode('chats', { canMeetings: false }),
  { enabled: true, scope: 'chats', includeMeetings: false, mode: 'chats' },
  'Chat history context should be available without meeting access.',
);
assert.deepEqual(
  historyContextForMode('meetings', { canMeetings: false }),
  { enabled: false, scope: 'meetings', includeMeetings: false, mode: 'meetings', locked: true },
  'Meeting history context should be gated.',
);
assert.deepEqual(
  historyContextForMode('all', { canMeetings: false }),
  { enabled: true, scope: 'chats', includeMeetings: false, mode: 'all', downgraded: true },
  'Combined context should safely downgrade to chats without meeting access.',
);
assert.equal(historyContextLabel('all', { canMeetings: true }), 'History: Chats + meetings');

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const store = readFileSync(new URL('../extension/js/store.js', import.meta.url), 'utf8');

assert.match(html, /id="btn-history-context"/, 'Composer should expose a history context button.');
assert.match(html, /id="history-context-menu"/, 'Composer should include a history context popover.');
assert.match(store, /historyContextMode:\s*'off'/, 'History context should default off for privacy.');
assert.match(js, /renderHistoryContextBtn/, 'Sidepanel should render the history context button state.');
assert.match(js, /renderHistoryContextMenu/, 'Sidepanel should render history context choices.');
assert.match(js, /historyContextForMode/, 'Send path should use the shared history context policy.');
assert.match(js, /inferHistoryScopeFromQuery/, 'Send path should infer clear history intent before auto-attaching the current page.');
assert.match(js, /skipLivePageForHistoryIntent/, 'Clear history searches should not also attach the unrelated current page.');
assert.match(js, /retrieveHistory\(text,\s*\{[^}]*scope:\s*autoHistoryContext\.scope/s, 'Normal sends should retrieve selected history context.');
assert.match(css, /\.composer-tools \.tool-btn\.history-toggle/, 'History context button should be styled with composer tools.');

console.log('history context control tests passed');
