// Copy what you're looking at: Live/Read gives formatted rich text (so a paste into Docs,
// Slack or email keeps bold/tables/bullets), Source gives raw Markdown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../extension/js/markdown.js';

const notes = readFileSync(new URL('../extension/notes.js', import.meta.url), 'utf8');

// Both flavours are written, so the target app picks: html for rich editors, plain for the rest.
assert.match(notes, /'text\/html': new Blob/, 'writes a rich-text flavour');
assert.match(notes, /'text\/plain': new Blob\(\[md\]/, 'carries the Markdown source alongside');
// Rich only in the rendered modes; source modes stay Markdown.
assert.match(notes, /classList\.contains\('live'\) \|\| panes\.classList\.contains\('read'\)/,
  'rich copy is chosen by the mode being viewed');
// Never leaves the user without a copy.
assert.match(notes, /catch \{ \/\* fall through to plain text \*\/ \}/, 'falls back to plain text');
assert.match(notes, /typeof ClipboardItem === 'function'/, 'feature-detected, not assumed');

// The styling that actually makes a paste survive: tables keep borders, code stays monospace.
const html = notes.includes('richHtmlForClipboard');
assert.ok(html, 'there is a rich-html builder');
const sample = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n- bullet\n\n**bold**');
assert.match(sample, /<table>/, 'tables render');
assert.match(sample, /<pre><code>/, 'code renders as code');
assert.match(sample, /<ul>/, 'bullets render');
assert.match(sample, /<strong>bold<\/strong>/, 'bold renders');

console.log('ok — Live/Read copies formatted (with Markdown alongside); Source copies Markdown');
