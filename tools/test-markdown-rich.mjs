// Rich markdown: embedded images + SVG, with the unsafe cases neutralized.
import assert from 'node:assert/strict';
import { renderMarkdown } from '../extension/js/markdown.js';

// https + data:image render as <img>
{
  const h = renderMarkdown('![a cat](https://example.com/cat.png)');
  assert.match(h, /<img class="md-img" src="https:\/\/example\.com\/cat\.png" alt="a cat"/);
}
{
  const h = renderMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)');
  assert.match(h, /<img class="md-img" src="data:image\/png;base64,iVBORw0KGgo="/);
}
// javascript: / http: / other schemes are refused → fall back to alt text, NO img, NO scheme
{
  const h = renderMarkdown('![catpic](javascript:evil)');
  assert.ok(!/<img/.test(h), 'no img for javascript: src');
  assert.ok(!/javascript:/i.test(h), 'javascript: scheme never emitted');
  assert.match(h, /catpic/, 'falls back to alt text');
}
{
  const h = renderMarkdown('![x](http://insecure/img.png)');
  assert.ok(!/<img/.test(h), 'plain http image refused (https/data only)');
}
// ```svg → an <img> data URL (scripts inside are inert in <img> context)
{
  const h = renderMarkdown('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>\n```');
  assert.match(h, /md-artifact-svg/);
  assert.match(h, /<img class="md-svg"[^>]*src="data:image\/svg\+xml/);
  assert.ok(!/<svg/.test(h), 'the raw <svg> is inside the data URL, not live in the DOM');
}
// a ```svg carrying a <script> still renders only as an inert <img> — no live <script> tag
{
  const h = renderMarkdown('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/x")</script></svg>\n```');
  assert.match(h, /<img class="md-svg"/);
  assert.ok(!/<script/i.test(h), 'no live <script> element reaches the panel DOM');
}
// non-svg fenced block is untouched (still a code block)
{
  const h = renderMarkdown('```js\nconsole.log(1)\n```');
  assert.match(h, /<pre><code class="lang-js">/);
}
console.log('ok — images (https/data only) + inert SVG rendering, unsafe schemes refused');

// STREAMING: an UNCLOSED fence must stay a plain code block. Upgrading it on every token
// made the message flicker and could mount half a document as an artifact.
{
  const partial = renderMarkdown('```html\n<html><body><canvas id="c">');
  assert.ok(!/md-artifact-html/.test(partial), 'an open fence is not yet an artifact');
  assert.match(partial, /<pre><code class="lang-html">/, 'it renders as an ordinary code block');
  const complete = renderMarkdown('```html\n<html><body><canvas id="c"></canvas></body></html>\n```');
  assert.match(complete, /md-artifact-html/, 'the closed block becomes an artifact');
}
{
  const partialSvg = renderMarkdown('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><circle');
  assert.ok(!/md-artifact-svg/.test(partialSvg), 'a half-written svg is not rendered as an image');
}
console.log('ok — rich rendering waits for the closing fence (no streaming flicker)');
