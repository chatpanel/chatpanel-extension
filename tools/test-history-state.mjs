import assert from 'node:assert/strict';

import { initialHistoryView } from '../extension/js/history-state.js';

assert.deepEqual(initialHistoryView(''), { view: 'graph', id: '' });
assert.deepEqual(initialHistoryView('#'), { view: 'graph', id: '' });
assert.deepEqual(initialHistoryView('#abc123'), { view: 'chat', id: 'abc123' });
assert.deepEqual(initialHistoryView('#chat%201'), { view: 'chat', id: 'chat 1' });
assert.deepEqual(initialHistoryView('', 'meeting'), { view: 'graph', id: '' });
assert.deepEqual(initialHistoryView('#meeting%201', 'meeting'), { view: 'meeting', id: 'meeting 1' });

console.log('history state tests passed');
