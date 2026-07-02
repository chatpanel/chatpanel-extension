// editor-cm.js — the Notes live-preview editor (CodeMirror 6), Notion/Obsidian-style.
//
// Markdown stays the SOURCE OF TRUTH — CM6 renders it inline (big headings, real bold with
// the `**` hidden, styled code/links) while keeping a plain-text document, so everything the
// rest of Notes does on markdown (provenance diffing, autosave, streaming inserts) keeps
// working. Lazy-loaded on note-open: the CM6 bundle is ~500 KB and stays OFF first paint.
//
// Reusable capability: createLiveEditor() returns a small facade (value / selection /
// replaceRange / focus / readonly / destroy + onChange/onSelection/onKey callbacks). No
// Notes state leaks in here, so a gateway/bridge preview could reuse it. The markdown→
// decoration scan (scanMarkdown) is PURE over an EditorState, so it's unit-testable without
// a browser.

import {
  EditorState, StateField, StateEffect, Compartment, Prec,
  EditorView, Decoration, WidgetType, ViewPlugin, keymap, drawSelection, placeholder as cmPlaceholder,
  history, historyKeymap, defaultKeymap, indentWithTab,
  syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput,
  markdown, markdownLanguage, tags as t,
} from './vendor/codemirror.js';
import { agentRegionsExtension, agentAuthorOf } from './notes-regions.js';
import { renderMarkdown } from './markdown.js'; // reuse the read-mode renderer for live table blocks

// Markdown token → CSS class (colors/weights live in notes.css so themes control them).
const HL = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-tok-h1' },
  { tag: t.heading2, class: 'cm-tok-h2' },
  { tag: t.heading3, class: 'cm-tok-h3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'cm-tok-h' },
  { tag: t.strong, class: 'cm-tok-strong' },
  { tag: t.emphasis, class: 'cm-tok-em' },
  { tag: t.strikethrough, class: 'cm-tok-strike' },
  { tag: t.monospace, class: 'cm-tok-code' },
  { tag: [t.link, t.url], class: 'cm-tok-link' },
  { tag: t.quote, class: 'cm-tok-quote' },
  { tag: t.list, class: 'cm-tok-list' },
]);

// Formatting marks to CONCEAL (so text reads clean): heading #s, emphasis/code/strike marks,
// link brackets + the raw URL, and the blockquote `>` (the left bar comes from a line class).
// Plain bullets are kept (just styled); task bullets + their `[ ]`/`[x]` are handled specially.
const CONCEAL = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL', 'QuoteMark']);
// Marks that also swallow the run of spaces after them, so hiding `### ` / `> ` leaves no gap.
const EAT_SPACE = new Set(['HeaderMark', 'QuoteMark']);

// Bullet glyphs by nesting depth — a real • / ◦ / ▪ replaces the raw `-`/`*`/`+` marker
// (Notion/Obsidian-style) so a list reads as a list, not a column of dashes. Ordered lists
// keep their `1.`/`2.` (meaningful) and the mark stays raw on the cursor's own line for editing.
const BULLET_GLYPHS = ['•', '◦', '▪'];
class BulletWidget extends WidgetType {
  constructor(glyph) { super(); this.glyph = glyph; }
  eq(o) { return o.glyph === this.glyph; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = this.glyph; return s; }
}

// A rendered task checkbox that replaces the raw `[ ]`/`[x]`. Clicking it flips the marker in
// the doc (markdown stays the source of truth). Position is re-derived at click time via
// posAtDOM, so it survives edits/remaps without carrying a stale offset.
class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-check';
    box.setAttribute('aria-label', 'toggle task');
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const cur = view.state.doc.sliceString(pos, pos + 3);
      if (/\[[ xX]\]/.test(cur)) {
        view.dispatch({ changes: { from: pos, to: pos + 3, insert: /[xX]/.test(cur) ? '[ ]' : '[x]' } });
      }
    });
    return box;
  }
}

// A whole block (GFM table, fenced code) rendered off-cursor via the SAME read-mode
// renderMarkdown, so Live and Read match exactly — a table becomes a real grid, a ```code
// fence becomes a styled <pre> with its fences hidden (was shown raw). Clicking drops the
// caret into the source and the block re-renders raw for editing (Obsidian-style). renderMarkdown
// HTML-escapes everything first, so this innerHTML is CSP-safe.
class RenderedBlockWidget extends WidgetType {
  constructor(md, cls) { super(); this.md = md; this.cls = cls; }
  eq(o) { return o.md === this.md && o.cls === this.cls; }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = this.cls;
    wrap.innerHTML = renderMarkdown(this.md);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target.closest('a, input')) return; // let links / task checkboxes work
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; } // our mousedown handles the caret; keep CM from double-acting
}

// The [firstLine, lastLine] a block node covers, plus the doc offsets of those line bounds. A
// block node's `to` can sit at the start of the following (blank) line; back up so the widget
// doesn't swallow it. Shared by the view-plugin scan and the block-decoration field below.
function tableLineRange(state, node) {
  const firstLine = state.doc.lineAt(node.from).number;
  const end = Math.min(node.to, state.doc.length);
  let lastLine = state.doc.lineAt(end).number;
  if (lastLine > firstLine && state.doc.line(lastLine).from === end) lastLine--;
  return { firstLine, lastLine, from: state.doc.line(firstLine).from, to: state.doc.line(lastLine).to };
}

// PURE: given an EditorState (markdown), the ranges to scan, and the line the cursor is on,
// decide which spans get a heading line-class and which formatting marks get hidden. Marks on
// the CURSOR's line are left visible so the raw syntax stays editable when you're on it
// (Obsidian "live preview"). Returns plain descriptors; the view maps them to decorations.
export function scanMarkdown(state, ranges, cursorLine) {
  const out = [];
  const tree = syntaxTree(state);
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const h = /^ATXHeading([1-6])$/.exec(node.name);
        if (h) { out.push({ kind: 'line', from: state.doc.lineAt(node.from).from, cls: `cm-line-h${h[1]}` }); return; }
        // Blockquote: bar every line via a line class; the `>` marks conceal as CONCEAL below.
        if (node.name === 'Blockquote') {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
          for (let n = first; n <= last; n++) out.push({ kind: 'line', from: state.doc.line(n).from, cls: 'cm-line-quote' });
          return;
        }
        // Fenced / indented code: shade + monospace every line of the block. Don't descend —
        // the ``` fences stay visible (clearer than half-hiding them) but read as a code block.
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
          for (let n = first; n <= last; n++) out.push({ kind: 'line', from: state.doc.line(n).from, cls: 'cm-line-code' });
          return false; // skip children (no inner CodeMark concealing)
        }
        // Table: rendered as a block widget by blockField when the cursor is elsewhere. On the
        // cursor's own line-range we leave it raw (editable) but monospace-align it so the pipe
        // columns line up. Either way, don't descend — the block widget owns the whole span, and
        // concealing inner cell marks would overlap it.
        if (node.name === 'Table') {
          const { firstLine, lastLine } = tableLineRange(state, node);
          if (cursorLine >= firstLine && cursorLine <= lastLine) {
            for (let n = firstLine; n <= lastLine; n++) out.push({ kind: 'line', from: state.doc.line(n).from, cls: 'cm-line-table' });
          }
          return false;
        }
        const onCursorLine = state.doc.lineAt(node.from).number === cursorLine;
        // Horizontal rule (`---` / `***` / `___`) → a real divider line; hide the marks (unless
        // the cursor is on the line, so it stays editable).
        if (node.name === 'HorizontalRule') {
          out.push({ kind: 'line', from: state.doc.lineAt(node.from).from, cls: 'cm-line-hr' });
          if (!onCursorLine) out.push({ kind: 'conceal', from: node.from, to: node.to });
          return;
        }
        // Lists: task items hide the bullet (the checkbox renders instead); unordered items get a
        // real • (depth-aware); ordered items keep their `1.`. On the cursor line, show raw syntax.
        if (node.name === 'ListMark') {
          const line = state.doc.lineAt(node.to);
          if (/^\s*\[[ xX]\]/.test(state.doc.sliceString(node.to, line.to))) { // task item
            if (!onCursorLine) {
              let end = node.to; while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end++;
              out.push({ kind: 'conceal', from: node.from, to: end });
            }
            return;
          }
          const mark = state.doc.sliceString(node.from, node.to);
          if (!onCursorLine && /^[-*+]$/.test(mark)) { // unordered bullet → •/◦/▪ by nesting depth
            const indent = line.text.length - line.text.trimStart().length;
            out.push({ kind: 'bullet', from: node.from, to: node.to, glyph: BULLET_GLYPHS[Math.floor(indent / 2) % BULLET_GLYPHS.length] });
          }
          return; // ordered markers (`1.`) stay visible, styled via cm-tok-list
        }
        if (node.name === 'TaskMarker') {
          if (onCursorLine || node.to <= node.from) return;
          out.push({ kind: 'check', from: node.from, to: node.to, checked: /[xX]/.test(state.doc.sliceString(node.from, node.to)) });
          return;
        }
        // A URL node is concealed ONLY when it's the address of a [text](url) Link/Image — there
        // the visible [text] label stands in for it. A BARE / pasted URL (or one inside literal
        // parens) is also a URL node but has NO label, so concealing it would leave nothing (or an
        // empty "()"). Keep those visible: they're styled as a link (cm-tok-link) and stay
        // clickable via linkTargetAt. Same reasoning for a raw autolink.
        if (node.name === 'URL') {
          const parent = node.node?.parent?.name;
          if (parent !== 'Link' && parent !== 'Image') return;
        }
        if (!CONCEAL.has(node.name) || node.to <= node.from) return;
        if (onCursorLine) return; // editing this line → show marks
        let end = node.to;
        if (EAT_SPACE.has(node.name)) { while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end++; } // eat the space after ### / >
        out.push({ kind: 'conceal', from: node.from, to: end });
      },
    });
  }
  return out;
}

// Resolve a click position to a link target so Live mode opens links (Read/Split mode already
// does via its own handler). A markdown [text](url) / <autolink> → its URL; a [[wikilink]] on
// the line → its title (the host resolves it to a note). Returns a descriptor or null.
export function linkTargetAt(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'URL') return { kind: 'url', url: state.doc.sliceString(n.from, n.to) };
    if (n.name === 'Link' || n.name === 'Image') {
      const u = n.getChild('URL');
      if (u) return { kind: 'url', url: state.doc.sliceString(u.from, u.to) };
    }
    if (n.name === 'Autolink' || n.name === 'URL') return { kind: 'url', url: state.doc.sliceString(n.from, n.to).replace(/^<|>$/g, '') };
  }
  const line = state.doc.lineAt(pos);
  const re = /\[\[([^\]\n]+)\]\]/g; let m;
  while ((m = re.exec(line.text))) {
    const s = line.from + m.index;
    if (pos >= s && pos <= s + m[0].length) return { kind: 'wikilink', title: m[1].trim() };
  }
  return null;
}

// Inline citation markers <sup>[1]</sup> that the read-mode renderer (markdown.js) turns into
// real superscripts. CM's markdown grammar leaves the raw <sup> tags as text, so Live mode
// showed a literal "<sup>[1]</sup>". Mirror read mode: hide the two tags and superscript the
// inner marker — EXCEPT on the cursor's own line, where raw syntax stays editable like every
// other live-preview mark. Regex-based (not tree-based): the markers are inline HTML the
// markdown grammar doesn't model as a citation. Inner shape matches markdown.js safeSupText.
const SUP_RE = /<sup>([\s\d,\-[\]]{1,40})<\/sup>/gi;
function scanCitations(state, ranges, cursorLine, out) {
  for (const { from, to } of ranges) {
    const text = state.doc.sliceString(from, to);
    SUP_RE.lastIndex = 0;
    let m;
    while ((m = SUP_RE.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (state.doc.lineAt(start).number === cursorLine) continue; // editing this line → show raw
      const innerFrom = start + 5; // after "<sup>"
      const innerTo = end - 6;     // before "</sup>"
      out.push({ kind: 'conceal', from: start, to: innerFrom });
      out.push({ kind: 'sup', from: innerFrom, to: innerTo });
      out.push({ kind: 'conceal', from: innerTo, to: end });
    }
  }
}

// Clicking a rendered citation <sup>[N]</sup> jumps to its source — like a footnote/bookmark.
// citationNumberAt: the N under `pos` (or null). findSourceAnchor: the doc offset of the Sources
// entry for N — scanned from the BOTTOM (the Sources list lives at the end) for a line that opens
// with that number (`1.` / `[1]` / `1)` / `- [1]`), skipping the citation markers themselves.
function citationNumberAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const rel = pos - line.from;
  SUP_RE.lastIndex = 0;
  let m;
  while ((m = SUP_RE.exec(line.text))) {
    if (rel >= m.index && rel <= m.index + m[0].length) {
      const num = (m[1].match(/\d+/) || [])[0];
      return num ? Number(num) : null;
    }
  }
  return null;
}
function findSourceAnchor(state, n) {
  const re = new RegExp(`^\\s*(?:[-*]\\s+)?\\[?${n}\\]?[.):]?\\s`);
  const doc = state.doc;
  for (let ln = doc.lines; ln >= 1; ln--) {
    const line = doc.line(ln);
    if (/<sup>/i.test(line.text)) continue; // the citation marker line, not the source entry
    if (re.test(line.text)) return line.from;
  }
  return null;
}

function buildDecorations(view) {
  const ranges = view.visibleRanges.length ? view.visibleRanges : [{ from: 0, to: view.state.doc.length }];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const descriptors = scanMarkdown(view.state, ranges, cursorLine);
  scanCitations(view.state, ranges, cursorLine, descriptors);
  const deco = [];
  for (const d of descriptors) {
    if (d.kind === 'line') deco.push(Decoration.line({ class: d.cls }).range(d.from));
    else if (d.kind === 'check') deco.push(Decoration.replace({ widget: new CheckboxWidget(d.checked) }).range(d.from, d.to));
    else if (d.kind === 'bullet') deco.push(Decoration.replace({ widget: new BulletWidget(d.glyph) }).range(d.from, d.to));
    else if (d.kind === 'sup') deco.push(Decoration.mark({ class: 'cm-sup' }).range(d.from, d.to));
    else deco.push(Decoration.replace({}).range(d.from, d.to));
  }
  return Decoration.set(deco, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = buildDecorations(u.view); }
  },
  { decorations: (v) => v.decorations },
);

// ── AI-draft (ghost) highlight ────────────────────────────────────────────────────
// An un-accepted draft-ahead suggestion is real text in the doc, but it must NOT read as
// committed content — so we tint its span with `.cm-ai-draft`. The range remaps through any
// edit (mapping the mark), and clears on accept/dismiss. `setGhostRange.of(null)` clears it.
const setGhostRange = StateEffect.define();
const ghostField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setGhostRange)) {
        const r = e.value;
        deco = (r && r.to > r.from)
          ? Decoration.set([Decoration.mark({ class: 'cm-ai-draft' }).range(r.from, r.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Rendered blocks (tables + fenced code) ──────────────────────────────────────────
// Block (line-break-spanning) decorations MUST come from a state field, not a view plugin —
// CM needs them before it computes the viewport, so livePreview can't provide them. This field
// replaces each GFM Table / fenced-code block (whose cursor is elsewhere) with its rendered
// form; when the caret is inside the block's lines we skip it so scanMarkdown's `cm-line-table`
// / `cm-line-code` shows the raw source for editing.
// FencedCode only (```…```). Indented CodeBlocks stay raw — renderMarkdown only renders fences.
const BLOCK_RENDER = { Table: 'cm-table', FencedCode: 'cm-codeblock' };
function buildBlockDecos(state) {
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const deco = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      const cls = BLOCK_RENDER[node.name];
      if (!cls) return;
      const { firstLine, lastLine, from, to } = tableLineRange(state, node);
      if (cursorLine < firstLine || cursorLine > lastLine) {
        deco.push(Decoration.replace({ widget: new RenderedBlockWidget(state.doc.sliceString(from, to), cls), block: true }).range(from, to));
      }
      return false;
    },
  });
  return Decoration.set(deco, true);
}
const blockField = StateField.define({
  create: (state) => buildBlockDecos(state),
  update: (deco, tr) => ((tr.docChanged || tr.selection) ? buildBlockDecos(tr.state) : deco.map(tr.changes)),
  provide: (f) => EditorView.decorations.from(f),
});

// Create the live-preview editor inside `parent`. Callbacks: onChange(value, update) on every
// doc change, onSelection() on cursor moves, onKey(event)->true to mark a key handled (so CM
// won't also act on it). Facade mirrors the textarea verbs the rest of Notes already uses.
export function createLiveEditor({ parent, doc = '', readOnly = false, placeholder = '', onChange, onSelection, onKey, onLink, onPaste } = {}) {
  const editable = new Compartment();
  const exts = [
    history(),
    drawSelection(),
    indentOnInput(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(HL),
    livePreview,
    ghostField, // tints an un-accepted AI draft so it never reads as committed text
    blockField, // renders GFM tables + fenced code as blocks (block decorations must be field-provided)
    agentRegionsExtension(), // multi-agent regions: remap + region-scoped lock + working widget
    // Our gesture/autocomplete handler must beat the default keymap (Tab=indent, Enter=newline),
    // so it runs at the HIGHEST precedence — otherwise Tab/Enter get consumed before we can
    // accept an autocomplete item or submit a directed line. Returns true → CM won't also act.
    Prec.highest(EditorView.domEventHandlers({ keydown: (e) => (onKey ? onKey(e) === true : false) })),
    // Click a rendered link → open it (Read/Split mode has its own handler; Live had none, so a
    // click only placed the caret). Skip the line the cursor is on — its raw syntax is shown for
    // editing — and only hijack a click that actually lands on a link, so other clicks still edit.
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        if (view.state.doc.lineAt(pos).number === view.state.doc.lineAt(view.state.selection.main.head).number) return false;
        // Citation <sup>[N]</sup> → jump to its Sources entry within the doc (footnote-style).
        const n = citationNumberAt(view.state, pos);
        if (n != null) {
          const anchor = findSourceAnchor(view.state, n);
          if (anchor != null) {
            e.preventDefault();
            view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
            view.focus();
            return true;
          }
        }
        if (!onLink) return false;
        const target = linkTargetAt(view.state, pos);
        if (!target) return false;
        e.preventDefault();
        onLink(target);
        return true;
      },
      // Paste a bare URL → let the host upgrade it to [Title](url). onPaste calls preventDefault
      // itself when it handles the paste (returning true); otherwise CM's normal paste runs.
      paste: (e) => (onPaste ? onPaste(e) === true : false),
    }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    editable.of(EditorView.editable.of(!readOnly)),
    EditorView.updateListener.of((u) => {
      // agentAuthor set → this change was an agent write (attribute to the agent, not "You").
      if (u.docChanged && onChange) onChange(u.state.doc.toString(), { update: u, agentAuthor: agentAuthorOf(u) });
      if (u.selectionSet && !u.docChanged && onSelection) onSelection();
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'Note body', spellcheck: 'true' }),
  ];
  if (placeholder) exts.push(cmPlaceholder(placeholder));
  const view = new EditorView({ state: EditorState.create({ doc, extensions: exts }), parent });

  const dispatchChange = (spec) => view.dispatch(spec);
  return {
    view,
    get value() { return view.state.doc.toString(); },
    // Set the doc to `v` with a MINIMAL change — skip the common prefix + suffix so a
    // streaming append/edit dispatches a tiny change instead of replacing the whole doc.
    // That's what keeps the live mirror flicker-free and the caret stable during AI writes.
    // `userEvent:'input.set'` lets the change listener tell programmatic sets from user edits.
    setValue(v, { cursorToEnd = false } = {}) {
      const cur = view.state.doc.toString();
      if (v === cur) return;
      const min = Math.min(cur.length, v.length);
      let s = 0; while (s < min && cur.charCodeAt(s) === v.charCodeAt(s)) s++;
      let e = 0; while (e < min - s && cur.charCodeAt(cur.length - 1 - e) === v.charCodeAt(v.length - 1 - e)) e++;
      dispatchChange({
        changes: { from: s, to: cur.length - e, insert: v.slice(s, v.length - e) },
        selection: cursorToEnd ? { anchor: v.length } : undefined,
        userEvent: 'input.set',
        scrollIntoView: cursorToEnd,
      });
    },
    getSelection() { const s = view.state.selection.main; return { start: s.from, end: s.to, head: s.head }; },
    setSelection(start, end = start) { dispatchChange({ selection: { anchor: start, head: end } }); },
    replaceRange(text, from, to) { dispatchChange({ changes: { from, to: to ?? from, insert: text } }); },
    replaceSelection(text) { dispatchChange(view.state.replaceSelection(text)); },
    currentLine() { const l = view.state.doc.lineAt(view.state.selection.main.head); return { text: l.text, from: l.from, to: l.to }; },
    lineAt(pos) { const l = view.state.doc.lineAt(pos); return { text: l.text, from: l.from, to: l.to, number: l.number }; },
    coordsAtCursor() { try { return view.coordsAtPos(view.state.selection.main.head); } catch { return null; } },
    focus() { view.focus(); },
    // Tint [from,to) as an un-accepted AI draft (or clear it when the range is empty/absent).
    setGhost(from, to) {
      const len = view.state.doc.length;
      const f = Math.max(0, Math.min(from ?? 0, len));
      const tt = Math.max(f, Math.min(to ?? f, len));
      dispatchChange({ effects: setGhostRange.of(tt > f ? { from: f, to: tt } : null) });
    },
    clearGhost() { dispatchChange({ effects: setGhostRange.of(null) }); },
    setReadOnly(b) { dispatchChange({ effects: editable.reconfigure(EditorView.editable.of(!b)) }); },
    scrollDocIntoView() { dispatchChange({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) }); },
    destroy() { view.destroy(); },
  };
}
