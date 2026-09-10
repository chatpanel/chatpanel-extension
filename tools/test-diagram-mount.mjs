// A ```mermaid block has to become a PICTURE in every surface that renders our markdown —
// and it has to cost nothing in the surfaces that don't contain one.
//
// It used to be true in exactly one place. artifacts.js owned the mounting, only sidepanel.js
// called artifacts.js, and so a flowchart written into a NOTE stayed a wall of `flowchart TB`
// source in both the reading view and the CodeMirror live editor — the two places a person
// actually writes diagrams. This test pins the three properties that fix has to keep:
//
//   1. ONE implementation. The renderer is reached through js/diagram-artifact.js from every
//      call site; a second copy of the mounting code is how the three surfaces drift apart.
//   2. LAZY, every time. Nothing may static-import the module (or the ~14 KB renderer behind
//      it): a note or a chat with no diagram in it must load neither.
//   3. Guarded. Each call site checks for a placeholder before it imports anything at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const diagram = read('extension/js/diagram-artifact.js');
const editor = read('extension/js/editor-cm.js');
const notes = read('extension/notes.js');
const artifacts = read('extension/js/artifacts.js');
const markdown = read('extension/js/markdown.js');

// ── 1. one implementation, and it is the shared renderer ────────────────────────────
assert.match(markdown, /md-artifact-mermaid/, 'markdown.js still emits the placeholder these mount');
assert.match(diagram, /await import\('\.\/events\/flowchart\.js'\)/,
  'the picture comes from the shared @chatpanel/events renderer, not a copy');
for (const [name, src] of [['editor-cm.js', editor], ['notes.js', notes], ['artifacts.js', artifacts]]) {
  assert.ok(!/renderFlowchartSvg/.test(src),
    `${name} must reach the renderer through diagram-artifact.js, not call it directly`);
}

// ── 2. nothing static-imports it ────────────────────────────────────────────────────
// Static `import … from './diagram-artifact.js'` would put the card — and, the first time
// anything touched it, the renderer — on the first-paint graph of the panel AND of Notes.
const STATIC_IMPORT = /^\s*import\s[^(]*from\s+['"][^'"]*diagram-artifact\.js['"]/m;
for (const [name, src] of [['editor-cm.js', editor], ['notes.js', notes], ['artifacts.js', artifacts]]) {
  assert.ok(!STATIC_IMPORT.test(src), `${name} must import diagram-artifact.js dynamically`);
  assert.match(src, /import\('\.{1,2}\/(?:js\/)?diagram-artifact\.js'\)/,
    `${name} does reach it, at its call site`);
}
assert.ok(!/^\s*import\s[^(]*from\s+['"]\.\/events\/flowchart\.js['"]/m.test(diagram),
  'diagram-artifact.js loads the renderer dynamically too — the card is not the renderer');

// ── 3. every call site checks for a placeholder first ───────────────────────────────
assert.match(diagram, /export function hasDiagrams/, 'the presence check is shared, not retyped');
assert.match(diagram, /if \(!hasDiagrams\(root\)\) return;/,
  'mountDiagrams bails before loading the renderer when there is nothing to draw');
assert.match(editor, /if \(!wrap\.querySelector\('\.md-artifact-mermaid'\)\) return;/,
  'the live editor checks the rendered block before importing anything');
assert.match(notes, /querySelector\('\.md-artifact-mermaid:not\(\[data-artifact-ready\]\)'\)/,
  'the reading view checks its preview before importing anything');

// ── the live editor's own hazards ───────────────────────────────────────────────────
// A block widget is re-created on cursor moves and on scroll. Re-rendering the SVG each time
// would lay the whole graph out again, so the module caches by source text and offers a
// synchronous mount for the case where it is already warm.
assert.match(diagram, /const SVG_CACHE = new Map\(\)/, 'rendered SVGs are cached by source');
assert.match(diagram, /export function mountDiagramsSync/, 'a warm mount can happen in the same frame');
assert.match(editor, /diagramMod\?\.mountDiagramsSync\(wrap, \{ onEdit \}\)/,
  'the live editor takes the synchronous path once the module is warm');
assert.match(editor, /view\.requestMeasure\(\)/,
  'after an async mount the block is a different height — CM has to be told');
// Clicking the card must not place the caret: that destroys the widget mid-click, so its
// buttons would never fire. The way back to the source is the card's own Edit button.
assert.match(editor, /closest\('a, input, \.md-artifact-mermaid'\)/,
  'clicks inside the diagram card do not move the caret');
assert.match(diagram, /onEdit \? el\('button', 'artifact-btn', 'Edit'\) : null/,
  'a host that owns the source gets an Edit button; a chat bubble does not');

// ── the stylesheet is shared, and lazy where it matters ─────────────────────────────
// The card's CSS lives in one file: the panel links it (it always has bubbles that can carry
// a card), and any other page has it injected the first time it actually shows one.
const artifactCss = read('extension/artifacts.css');
assert.match(artifactCss, /\.md-artifact-mermaid/, 'the card chrome lives in artifacts.css');
assert.match(read('extension/sidepanel.html'), /href="artifacts\.css"/, 'the panel links it');
assert.ok(!/\.artifact-diagram\s*\{/.test(read('extension/sidepanel.css')),
  'and sidepanel.css no longer carries a second copy of those rules');
assert.ok(!/artifacts\.css/.test(read('extension/notes.html')),
  'Notes does NOT link it — a note with no diagram must not pay for the stylesheet');
assert.match(diagram, /chrome\.runtime\.getURL\(CSS_FILE\)/, 'it is injected on first mount instead');

console.log('ok — one diagram renderer, reached lazily from the panel, the reading view and Live mode');
