import assert from 'node:assert/strict';

import {
  mergeExtraBody,
  parseJsonObject,
  sanitizeExtraHeaders,
} from '../extension/js/request-options.js';

assert.deepEqual(parseJsonObject('', 'Extra request JSON'), {});
assert.deepEqual(parseJsonObject('{"top_p":0.9}', 'Extra request JSON'), { top_p: 0.9 });
assert.throws(
  () => parseJsonObject('[]', 'Extra request JSON'),
  /must be a JSON object/,
);
assert.throws(
  () => parseJsonObject('{bad', 'Extra request JSON'),
  /is not valid JSON/,
);

const baseBody = {
  model: 'nvidia/test',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  temperature: 0.4,
};
assert.deepEqual(
  mergeExtraBody(baseBody, {
    top_p: 0.9,
    reasoning_effort: 'low',
    model: 'evil',
    messages: [],
    stream: false,
    tools: [],
  }),
  {
    model: 'nvidia/test',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0.4,
    top_p: 0.9,
    reasoning_effort: 'low',
  },
);

assert.deepEqual(
  sanitizeExtraHeaders({
    'HTTP-Referer': 'https://chatpanel.net',
    'X-Title': 'ChatPanel',
    Authorization: 'Bearer no',
    'content-type': 'text/plain',
    '': 'skip',
    'X-Empty': '',
  }),
  {
    'HTTP-Referer': 'https://chatpanel.net',
    'X-Title': 'ChatPanel',
  },
);

console.log('request option tests passed');
