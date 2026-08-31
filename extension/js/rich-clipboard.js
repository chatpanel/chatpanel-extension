// Copy what you're LOOKING AT, not the source behind it.
//
// The Notes live editor keeps a Markdown document and only decorates it, so a plain copy —
// button or Cmd+C — puts `**bold**` and `| a | b |` on the clipboard. Pasted into Google
// Docs, Slack or an email that means reformatting by hand, which is exactly the thing the
// live view was supposed to save.
//
// So the copy carries BOTH flavours: text/html (rendered) for anything rich, and text/plain
// (the Markdown) for anything else. The target app picks — Docs and Slack take the HTML, a
// Markdown editor takes the source.
//
// Shared by both copy paths (the toolbar button and the editor's own copy event) so they can
// never drift into producing different output for the same note.

import { renderMarkdown } from './markdown.js';

// Those apps apply no stylesheet of their own, so anything that should survive the paste has
// to ride along as inline attributes on the markup itself.
export function markdownToRichHtml(md) {
  const html = renderMarkdown(md)
    .replace(/<table>/g, '<table style="border-collapse:collapse;border:1px solid #ccc" cellpadding="6">')
    .replace(/<(th|td)([ >])/g, '<$1 style="border:1px solid #ccc;text-align:left"$2')
    .replace(/<pre>/g, '<pre style="background:#f5f5f5;padding:10px;border-radius:6px;white-space:pre-wrap;font-family:ui-monospace,Menlo,Consolas,monospace">')
    .replace(/<blockquote>/g, '<blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555">');
  return `<meta charset="utf-8">${html}`;
}

/**
 * Put `md` on a ClipboardEvent as rich text + Markdown. Returns true if it handled the event
 * (the caller should then preventDefault). Used by the editor's copy/cut handlers, where the
 * synchronous DataTransfer is the only way to override what CodeMirror would otherwise write.
 */
export function writeRichToEvent(event, md) {
  const text = String(md || '');
  if (!text.trim() || !event?.clipboardData) return false;
  try {
    event.clipboardData.setData('text/html', markdownToRichHtml(text));
    event.clipboardData.setData('text/plain', text);
    return true;
  } catch {
    return false; // let the browser do its normal thing
  }
}

/**
 * Async clipboard write for a button press. Falls back to plain Markdown wherever
 * ClipboardItem isn't available. Resolves true if the rich flavour made it.
 */
export async function writeRichToClipboard(md) {
  const text = String(md || '');
  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([markdownToRichHtml(text)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    } catch { /* fall through */ }
  }
  await navigator.clipboard.writeText(text);
  return false;
}
