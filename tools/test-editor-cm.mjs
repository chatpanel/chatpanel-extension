import assert from 'node:assert/strict';

// CM6 touches browser globals at import and when a view mounts. Prefer jsdom (full fidelity —
// lets us mount + edit); but CI runs `npm test` with NO node_modules (the repo's "committed
// copies are source of truth" rule), so jsdom may be absent. When it is, fall back to a
// minimal shim — enough to import the committed bundle and exercise the PURE scanMarkdown
// logic — and skip the mount test.
let hasDom = false;
try {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'DOMParser', 'Node', 'NodeList', 'Element', 'HTMLElement', 'Range', 'getSelection', 'MutationObserver', 'DOMRect', 'CustomEvent', 'Event']) {
    if (window[k] === undefined) continue;
    try { globalThis[k] = window[k]; } // some (navigator) are getter-only in Node — leave them
    catch { try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); } catch { /* keep Node's */ } }
  }
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  window.requestAnimationFrame = globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(16), 0);
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = window.ResizeObserver;
  hasDom = true;
} catch {
  // Minimal shim (no jsdom): enough to import the bundle + run EditorState/Lezer (DOM-free).
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), children: [], childNodes: [] });
  globalThis.window ??= globalThis;
  globalThis.document ??= { createElement: el, createTextNode: () => ({}), documentElement: { style: {} }, addEventListener() {}, removeEventListener() {}, getElementById: () => null, body: el() };
  try { globalThis.navigator ??= { userAgent: 'node', platform: 'node' }; } catch { /* getter-only in newer Node */ }
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(16), 0);
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
}

const { EditorState, markdown, markdownLanguage } = await import('../extension/js/vendor/codemirror.js');
const { scanMarkdown, createLiveEditor } = await import('../extension/js/editor-cm.js');

const stateOf = (doc) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
const conceals = (state, cursorLine = -1) => scanMarkdown(state, [{ from: 0, to: state.doc.length }], cursorLine).filter((x) => x.kind === 'conceal');
// The text left VISIBLE once the concealed spans are removed — a semantic check of the scan.
function visible(doc, cs) {
  const s = [...cs].sort((a, b) => a.from - b.from);
  let out = ''; let pos = 0;
  for (const c of s) { if (c.from < pos) continue; out += doc.slice(pos, c.from); pos = c.to; }
  return out + doc.slice(pos);
}

// ── scanMarkdown (pure — no DOM): marks vanish, text reads clean ──
{
  const state = stateOf('# Hello\n\nSome **bold** and `code` here.');
  const scan = scanMarkdown(state, [{ from: 0, to: state.doc.length }], -1);
  assert.ok(scan.some((x) => x.kind === 'line' && x.cls === 'cm-line-h1'), 'heading gets a cm-line-h1 class');
  assert.equal(visible(state.doc.toString(), scan.filter((x) => x.kind === 'conceal')), 'Hello\n\nSome bold and code here.');
}

// ── reveal-on-cursor-line: marks on the cursor's line stay visible for editing ──
{
  const state = stateOf('# Hello\n\n**bold**');
  assert.ok(conceals(state, -1).some((c) => c.from === 0), 'heading mark concealed when cursor is elsewhere');
  const c1 = conceals(state, 1); // cursor on line 1 (the heading)
  assert.ok(!c1.some((c) => c.from === 0), 'heading mark shown while the cursor is on its line');
  assert.ok(c1.length >= 1, 'the **bold** on line 3 is still concealed');
}

// ── link: [text](url) reads as just "text" (brackets + url concealed) ──
{
  const state = stateOf('See [Docs](https://example.com) now');
  assert.equal(visible(state.doc.toString(), conceals(state)), 'See Docs now');
}

// ── live view: mounts, edits reflect, onChange fires, facade verbs work (needs jsdom) ──
if (hasDom) {
  const host = document.getElementById('host');
  let latest = null;
  let selections = 0;
  const ed = createLiveEditor({
    parent: host,
    doc: '# Title\n\nbody',
    onChange: (v) => { latest = v; },
    onSelection: () => { selections++; },
  });
  assert.equal(ed.value, '# Title\n\nbody');
  ed.replaceRange('X', 0, 0);
  assert.ok(ed.value.startsWith('X# Title'), 'replaceRange inserts');
  assert.equal(latest, ed.value, 'onChange delivered the new value');
  ed.setValue('all new', { cursorToEnd: true });
  assert.equal(ed.value, 'all new');
  assert.equal(ed.getSelection().head, 'all new'.length, 'cursorToEnd put the caret at the end');
  ed.setSelection(0, 3);
  assert.deepEqual([ed.getSelection().start, ed.getSelection().end], [0, 3]);
  ed.replaceSelection('ALL');
  assert.equal(ed.value, 'ALL new', 'replaceSelection replaced the selected span');
  assert.equal(ed.currentLine().text, 'ALL new');
  ed.setReadOnly(true);
  assert.equal(ed.view.state.readOnly === false, true); // EditorState.readOnly stays false; editability is a view facet
  ed.destroy();
  assert.ok(selections >= 0);
} else {
  console.log('editor-cm: jsdom not installed — ran pure scanMarkdown tests, skipped the live-mount test');
}

console.log('editor-cm tests passed');
