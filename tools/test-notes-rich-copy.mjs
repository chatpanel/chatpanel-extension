// Copy what you're looking at. BOTH copy paths must produce rich text in Live/Read:
// the toolbar button AND Cmd+C on a selection in the editor (the one people actually use).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdownToRichHtml, writeRichToEvent } from '../extension/js/rich-clipboard.js';

// The rendered flavour carries the formatting inline, because Docs/Slack apply no CSS.
{
  const html = markdownToRichHtml('| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold**\n\n- bullet\n\n```\ncode\n```\n\n> quote');
  assert.match(html, /<table style="[^"]*border/, 'tables keep visible borders');
  assert.match(html, /<t[hd] style="[^"]*border/, 'and so do their cells');
  assert.match(html, /<strong>bold<\/strong>/, 'bold survives');
  assert.match(html, /<ul>/, 'bullets survive');
  assert.match(html, /<pre style="[^"]*monospace/, 'code stays monospace, not prose');
  assert.match(html, /<blockquote style="[^"]*border-left/, 'quotes stay quoted');
  assert.match(html, /^<meta charset="utf-8">/, 'declares its encoding for the target app');
}

// writeRichToEvent sets BOTH flavours, so the target app chooses.
{
  const written = {};
  const ev = { clipboardData: { setData: (k, v) => { written[k] = v; } } };
  assert.equal(writeRichToEvent(ev, '**bold**'), true, 'it handled the event');
  assert.match(written['text/html'], /<strong>bold<\/strong>/, 'rich flavour for Docs/Slack');
  assert.equal(written['text/plain'], '**bold**', 'Markdown alongside for plain targets');
  // Nothing selected → let the browser do its normal thing.
  assert.equal(writeRichToEvent(ev, '   '), false);
  assert.equal(writeRichToEvent(null, 'x'), false);
}

// The EDITOR intercepts copy/cut — this is the Cmd+C path, and the reason a fix to only the
// toolbar button still felt broken.
{
  const cm = readFileSync(new URL('../extension/js/editor-cm.js', import.meta.url), 'utf8');
  assert.match(cm, /copy: \(e, v\) => copyRich\(e, v\)/, 'copy is intercepted');
  assert.match(cm, /cut: \(e, v\)/, 'and cut');
  assert.match(cm, /if \(!sel\.length\) return false/, 'an empty selection falls through to CodeMirror');
  assert.match(cm, /writeRichToEvent/, 'using the shared implementation');
}

// The BUTTON uses the same module, so the two paths cannot drift.
{
  const notes = readFileSync(new URL('../extension/notes.js', import.meta.url), 'utf8');
  assert.match(notes, /writeRichToClipboard/, 'the button uses the shared writer');
  assert.match(notes, /classList\.contains\('live'\) \|\| panes\.classList\.contains\('read'\)/,
    'rich only in the rendered modes; source modes stay Markdown');
  assert.ok(!/richHtmlForClipboard/.test(notes), 'no second, local copy of the renderer');
}

console.log('ok — button AND Cmd+C both copy formatted from Live/Read, Markdown from Source');
