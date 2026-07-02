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
  EditorState, Compartment, Prec,
  EditorView, Decoration, ViewPlugin, keymap, drawSelection, placeholder as cmPlaceholder,
  history, historyKeymap, defaultKeymap, indentWithTab,
  syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput,
  markdown, markdownLanguage, tags as t,
} from './vendor/codemirror.js';

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
// link brackets + the raw URL. Bullets and quote markers are kept (just styled).
const CONCEAL = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL']);

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
        if (!CONCEAL.has(node.name) || node.to <= node.from) return;
        if (state.doc.lineAt(node.from).number === cursorLine) return; // editing this line → show marks
        let end = node.to;
        if (node.name === 'HeaderMark') { while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end++; } // eat the space after ###
        out.push({ kind: 'conceal', from: node.from, to: end });
      },
    });
  }
  return out;
}

function buildDecorations(view) {
  const ranges = view.visibleRanges.length ? view.visibleRanges : [{ from: 0, to: view.state.doc.length }];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const deco = [];
  for (const d of scanMarkdown(view.state, ranges, cursorLine)) {
    if (d.kind === 'line') deco.push(Decoration.line({ class: d.cls }).range(d.from));
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

// Create the live-preview editor inside `parent`. Callbacks: onChange(value, update) on every
// doc change, onSelection() on cursor moves, onKey(event)->true to mark a key handled (so CM
// won't also act on it). Facade mirrors the textarea verbs the rest of Notes already uses.
export function createLiveEditor({ parent, doc = '', readOnly = false, placeholder = '', onChange, onSelection, onKey } = {}) {
  const editable = new Compartment();
  const exts = [
    history(),
    drawSelection(),
    indentOnInput(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(HL),
    livePreview,
    // Our gesture/autocomplete handler must beat the default keymap (Tab=indent, Enter=newline),
    // so it runs at the HIGHEST precedence — otherwise Tab/Enter get consumed before we can
    // accept an autocomplete item or submit a directed line. Returns true → CM won't also act.
    Prec.highest(EditorView.domEventHandlers({ keydown: (e) => (onKey ? onKey(e) === true : false) })),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    editable.of(EditorView.editable.of(!readOnly)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onChange) onChange(u.state.doc.toString(), u);
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
    // Replace the whole doc (used when opening a note / committing an AI result). Keeps the
    // caret sane; `userEvent:'input.set'` lets the change listener tell programmatic sets apart.
    setValue(v, { cursorToEnd = false } = {}) {
      const cur = view.state.doc.toString();
      if (v === cur) return;
      dispatchChange({ changes: { from: 0, to: cur.length, insert: v }, selection: cursorToEnd ? { anchor: v.length } : undefined, userEvent: 'input.set', scrollIntoView: cursorToEnd });
    },
    getSelection() { const s = view.state.selection.main; return { start: s.from, end: s.to, head: s.head }; },
    setSelection(start, end = start) { dispatchChange({ selection: { anchor: start, head: end } }); },
    replaceRange(text, from, to) { dispatchChange({ changes: { from, to: to ?? from, insert: text } }); },
    replaceSelection(text) { dispatchChange(view.state.replaceSelection(text)); },
    currentLine() { const l = view.state.doc.lineAt(view.state.selection.main.head); return { text: l.text, from: l.from, to: l.to }; },
    lineAt(pos) { const l = view.state.doc.lineAt(pos); return { text: l.text, from: l.from, to: l.to, number: l.number }; },
    coordsAtCursor() { try { return view.coordsAtPos(view.state.selection.main.head); } catch { return null; } },
    focus() { view.focus(); },
    setReadOnly(b) { dispatchChange({ effects: editable.reconfigure(EditorView.editable.of(!b)) }); },
    scrollDocIntoView() { dispatchChange({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) }); },
    destroy() { view.destroy(); },
  };
}
