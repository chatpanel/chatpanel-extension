import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { id: 'abc' } };

const { renderMarkdown } = await import('../extension/js/markdown.js');

const localLink = renderMarkdown('[Open meeting](chrome-extension://abc/meetings.html#m1)');
assert.match(localLink, /<a href="chrome-extension:\/\/abc\/meetings\.html#m1"/);

const foreignLink = renderMarkdown('[Other extension](chrome-extension://other/meetings.html#m1)');
assert.doesNotMatch(foreignLink, /<a href=/);
assert.match(foreignLink, /Other extension/);

const cited = renderMarkdown('Found material.<sup>[1]</sup>');
assert.match(cited, /Found material\.<sup>\[1\]<\/sup>/);
assert.doesNotMatch(cited, /&lt;sup&gt;/);

const unsafeSup = renderMarkdown('Bad <sup onclick="alert(1)">[1]</sup>');
assert.doesNotMatch(unsafeSup, /<sup onclick=/);
assert.match(unsafeSup, /&lt;sup onclick=/);

const rawUrl = renderMarkdown('Source: https://confluence.example.com/confluence/pages/viewpage.action?pageId=20650912079');
assert.match(rawUrl, /<a href="https:\/\/confluence\.example\.com\/confluence\/pages\/viewpage\.action\?pageId=20650912079"/);

const rawLocalUrl = renderMarkdown('Open: chrome-extension://abc/meetings.html#m1');
assert.match(rawLocalUrl, /<a href="chrome-extension:\/\/abc\/meetings\.html#m1"/);

const rawForeignLocalUrl = renderMarkdown('Open: chrome-extension://other/meetings.html#m1');
assert.doesNotMatch(rawForeignLocalUrl, /<a href="chrome-extension:\/\/other/);

const existingMarkdownLink = renderMarkdown('[AI Agent Readiness Pilot](https://confluence.example.com/confluence/pages/viewpage.action?pageId=20650912079)');
assert.equal((existingMarkdownLink.match(/<a href=/g) || []).length, 1);

console.log('markdown link tests passed');
