// Code must read as code, in EVERY form markdown allows. Markdown inside a code block being
// rendered (bold, headings, bullets) is the bug this guards.
import assert from 'node:assert/strict';
import { renderMarkdown } from '../extension/js/markdown.js';

const isCode = (html, body) => {
  assert.match(html, /<pre><code/, 'renders as a code block');
  assert.ok(!/<strong>|<em>|<h[1-6]>|<ul>|<li>/.test(html), `markdown inside code was rendered: ${html}`);
  if (body) assert.ok(html.includes(body), `keeps the literal source: ${html}`);
};

// Backtick fences — 3 and more, with and without an info string.
isCode(renderMarkdown('```\n**bold** and # heading\n- item\n```'), '**bold**');
isCode(renderMarkdown('````\n**bold**\n````'), '**bold**');
isCode(renderMarkdown('```js title="x"\nconst a = 1;\n```'), 'const a = 1;');
assert.match(renderMarkdown('```js\nx\n```'), /class="lang-js"/, 'the language survives for highlighting');

// Tilde fences — standard CommonMark, and previously not recognised at all.
isCode(renderMarkdown('~~~\n**bold**\n# not a heading\n~~~'), '**bold**');
isCode(renderMarkdown('~~~python\nprint("**hi**")\n~~~'), 'print(');

// A fence is closed only by the SAME character, at least as long.
isCode(renderMarkdown('```\n~~~\n**still code**\n~~~\n```'), '**still code**');
isCode(renderMarkdown('````\n```\n**still code**\n```\n````'), '**still code**');

// Indented code (4 spaces or a tab).
isCode(renderMarkdown('    **bold** indented'), '**bold**');
isCode(renderMarkdown('\t**bold** tabbed'), '**bold**');
isCode(renderMarkdown('intro\n\n    code **x**\n\nafter'), 'code **x**');

// Inline code keeps its content literal too.
{
  const h = renderMarkdown('use `**not bold**` here');
  assert.match(h, /<code>\*\*not bold\*\*<\/code>/);
  assert.ok(!/<strong>/.test(h), 'no emphasis inside inline code');
}

// Lists must NOT become code just because they are indented (the regression risk).
{
  const h = renderMarkdown('- a\n  - b\n    - c');
  assert.match(h, /<ul>/);
  assert.ok(!/<pre>/.test(h), 'a nested list is not a code block');
}

console.log('ok — backtick/tilde/indented/inline code all stay literal; lists unaffected');
