import assert from 'node:assert/strict';

import {
  relTime, escapeHtml, highlight, escapeMdText, tagify, snippetOf,
  sourceKind, researchSnippet, compactInput, prettyTools, toolTitle, stepIcon,
  parseSkillMention, mergeSkillPrompt, findSkillByName,
} from '../extension/js/notes-util.js';

// ── time ──
assert.equal(relTime(0), '');
assert.equal(relTime(Date.now() - 5_000), 'just now');
assert.equal(relTime(Date.now() - 5 * 60_000), '5m ago');
assert.equal(relTime(Date.now() - 3 * 3_600_000), '3h ago');
assert.equal(relTime(Date.now() - 2 * 86_400_000), '2d ago');

// ── escaping / highlight ──
assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
assert.equal(highlight('Hello world', 'world'), 'Hello <mark>world</mark>');
assert.equal(highlight('<b>hi</b>', ''), '&lt;b&gt;hi&lt;/b&gt;'); // no query → just escape
assert.equal(escapeMdText('[link] a'), '\\[link\\] a');

// ── tags / snippet ──
assert.equal(tagify('  Hello, World! '), 'hello-world');
assert.equal(snippetOf('Title line\nbody **bold** and `code` here'), 'body bold and code here');
assert.equal(snippetOf('Only a title'), ''); // nothing after the first line

// ── research / source ──
assert.equal(sourceKind('note:abc'), 'note');
assert.equal(sourceKind('meeting:1'), 'meeting');
assert.equal(sourceKind('chat:1'), 'chat');
assert.equal(sourceKind(''), 'chat');
assert.equal(researchSnippet('NOTE: header\nActual content here'), 'Actual content here');

// ── tool-trace helpers ──
assert.equal(compactInput({ a: 1, b: 2 }), '{"a":1,"b":2}');
assert.equal(compactInput('x'.repeat(80), 10), `${'x'.repeat(10)}…`);
assert.equal(compactInput(null), '');
assert.equal(prettyTools(['web_search', 'mcp_srv__do']), 'web_search, srv/do');
assert.equal(prettyTools(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e, f, +1 more');
assert.equal(toolTitle('task'), 'subagent');
assert.equal(toolTitle('mcp_srv__do'), 'srv / do');
assert.equal(toolTitle('web_search'), 'web_search');
assert.equal(stepIcon({ tool: 'task' }), '🪆');
assert.equal(stepIcon({ tool: 'web_search' }), '🌐');
assert.equal(stepIcon({ tool: 'history_search' }), '🌐'); // /search/ wins before /^history_/
assert.equal(stepIcon({ tool: 'history_get' }), '🗂');
assert.equal(stepIcon({ tool: 'read' }), '📄');
assert.equal(stepIcon({ tool: 'whatever' }), '🔧');

// ── #skill mentions ──
assert.deepEqual(parseSkillMention('#[Deep Research] find X'), { name: 'Deep Research', text: 'find X' });
assert.deepEqual(parseSkillMention('summarize #[Brief] this'), { name: 'Brief', text: 'summarize this' });
assert.deepEqual(parseSkillMention('no skill here'), { name: '', text: 'no skill here' });
assert.equal(mergeSkillPrompt('Answer as a {{input}} expert', 'security'), 'Answer as a security expert');
assert.equal(mergeSkillPrompt('Do the research.', 'on AI'), 'Do the research.\n\non AI');
assert.equal(mergeSkillPrompt('', 'just the task'), 'just the task');
const skills = [{ name: 'Deep Research' }, { title: 'Legacy', prompt: 'x' }];
assert.equal(findSkillByName(skills, 'deep research')?.name, 'Deep Research'); // exact, case-insensitive
assert.equal(findSkillByName(skills, 'legacy')?.title, 'Legacy');             // matches title too
assert.equal(findSkillByName(skills, 'nope'), null);

console.log('notes-util tests passed');
