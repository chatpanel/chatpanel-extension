// Entry point for the vendored CodeMirror 6 bundle. esbuild resolves the @codemirror/*
// + @lezer/* imports and bundles them into a single self-contained ESM file at
// extension/js/vendor/codemirror.js (see tools/build-editor.mjs). The extension loads
// THAT file (lazy, on note-open) — it never imports node_modules at runtime. Re-export
// only the API the Notes live-preview editor uses; add here + rebuild to grow it.
export {
  EditorState, EditorSelection, StateField, StateEffect, Compartment, RangeSetBuilder, Text, Prec,
} from '@codemirror/state';
export {
  EditorView, Decoration, WidgetType, ViewPlugin, keymap, placeholder, drawSelection,
} from '@codemirror/view';
export {
  history, historyKeymap, defaultKeymap, indentWithTab, undo, redo,
} from '@codemirror/commands';
export {
  syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput,
} from '@codemirror/language';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { tags } from '@lezer/highlight';
