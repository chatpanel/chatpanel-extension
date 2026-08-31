// Syntax highlighting: readable tokens, and — critically — it can never introduce markup.
import assert from 'node:assert/strict';
import { highlight, normalizeLang } from '../extension/js/highlight.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Languages we know vs. ones we don't
assert.equal(normalizeLang('javascript'), 'js');
assert.equal(normalizeLang('lang-py'), 'py');
assert.equal(normalizeLang('brainfuck'), '', 'unknown languages are left alone');

// JS: keywords, strings, comments, numbers, calls
{
  const h = highlight(esc('const x = 42; // note\nfoo("hi");'), 'js');
  assert.match(h, /<span class="tok-kw">const<\/span>/);
  assert.match(h, /<span class="tok-num">42<\/span>/);
  assert.match(h, /<span class="tok-com">\/\/ note<\/span>/);
  assert.match(h, /<span class="tok-fn">foo<\/span>/);
  assert.match(h, /tok-str/, 'the string is highlighted');
}
// A keyword INSIDE a string must not be re-highlighted (single left-to-right pass)
{
  const h = highlight(esc('const s = "const const";'), 'js');
  const strSpan = h.match(/<span class="tok-str">[\s\S]*?<\/span>/)[0];
  assert.ok(!strSpan.includes('tok-kw'), 'no nested keyword spans inside a string');
}
// Python uses # comments, not //
{
  const h = highlight(esc('def go():  # start\n    return True'), 'py');
  assert.match(h, /<span class="tok-com"># start<\/span>/);
  assert.match(h, /<span class="tok-kw">def<\/span>/);
}
// HTML: tag names and attributes
{
  const h = highlight(esc('<a href="x">hi</a>'), 'html');
  assert.match(h, /<span class="tok-tag">a<\/span>/);
  assert.match(h, /<span class="tok-atr">href<\/span>/);
}
// SECURITY: the escaped source stays escaped — highlighting only adds our own spans, so
// nothing in the code can become live markup.
{
  const hostile = esc('<img src=x onerror=alert(1)>');
  const h = highlight(hostile, 'js');
  assert.ok(!/<img/.test(h), 'no live element');
  assert.ok(h.includes('&lt;img'), 'still escaped');
  const spans = h.match(/<span class="tok-[a-z]+">/g) || [];
  const closes = h.match(/<\/span>/g) || [];
  assert.equal(spans.length, closes.length, 'balanced spans only');
  // The only tags present are our spans.
  const tags = (h.match(/<[^>]+>/g) || []).filter((t) => !/^<\/?span/.test(t));
  assert.deepEqual(tags, [], 'no tags other than the highlighter spans');
}
// Unknown language returns the input untouched
assert.equal(highlight(esc('whatever <x>'), 'nope'), esc('whatever <x>'));

console.log('ok — highlighting by language; escaped source stays escaped');
