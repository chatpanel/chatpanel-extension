import assert from 'node:assert/strict';

// jsdom-optional (CI runs `npm test` with no node_modules). Regions need a real EditorView to
// exercise transactions/decorations, so this test SKIPS cleanly when jsdom is absent — the
// pure blocksChange() logic is still asserted via a hand-built transaction stub below.
let hasDom = false;
try {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
  for (const k of ['window', 'document', 'navigator', 'DOMParser', 'Node', 'NodeList', 'Element', 'HTMLElement', 'Range', 'getSelection', 'MutationObserver', 'DOMRect', 'CustomEvent', 'Event']) {
    if (window[k] === undefined) continue;
    try { globalThis[k] = window[k]; } catch { try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); } catch { /* keep Node's */ } }
  }
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  window.requestAnimationFrame = globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(16), 0);
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = window.ResizeObserver;
  hasDom = true;
} catch { /* no jsdom → pure-only */ }

const { EditorState, EditorView } = await import('../extension/js/vendor/codemirror.js');
const R = await import('../extension/js/notes-regions.js');

// ── blocksChange (pure over a transaction) ──
// Build tiny transactions on a bare EditorState (no DOM) and assert the region guard logic.
{
  const base = EditorState.create({ doc: '0123456789', extensions: [R.regionsField] });
  const withRegion = base.update({ effects: R.addRegion.of({ id: 'a', label: 'A', from: 3, to: 7 }) }).state;
  const regions = R.activeRegions(withRegion);
  assert.deepEqual(regions, [{ id: 'a', label: 'A', from: 3, to: 7 }]);

  const editInside = withRegion.update({ changes: { from: 5, to: 5, insert: 'X' } });
  assert.equal(R.blocksChange(editInside, regions), true, 'a user edit INSIDE the region is blocked');

  const editBefore = withRegion.update({ changes: { from: 1, to: 1, insert: 'X' } });
  assert.equal(R.blocksChange(editBefore, regions), false, 'a user edit BEFORE the region passes');

  const editAfter = withRegion.update({ changes: { from: 9, to: 9, insert: 'X' } });
  assert.equal(R.blocksChange(editAfter, regions), false, 'a user edit AFTER the region passes');

  const agentEdit = withRegion.update({ changes: { from: 5, to: 5, insert: 'X' }, annotations: R.agentWrite.of({ id: 'a', label: 'A' }) });
  assert.equal(R.blocksChange(agentEdit, regions), false, 'an AGENT write inside its region passes');
}

// ── remap: a region shifts as text is inserted before it ──
{
  const s0 = EditorState.create({ doc: 'hello world', extensions: [R.regionsField] })
    .update({ effects: R.addRegion.of({ id: 'a', label: 'A', from: 6, to: 11 }) }).state; // "world"
  const s1 = s0.update({ changes: { from: 0, to: 0, insert: 'XYZ ' } }).state; // insert 4 chars at start
  assert.deepEqual(R.activeRegions(s1), [{ id: 'a', label: 'A', from: 10, to: 15 }], 'region remapped by +4');
}

// ── live view: guard blocks in-region typing, allows elsewhere; agent writes land ──
if (hasDom) {
  const host = document.getElementById('host');
  const view = new EditorView({
    state: EditorState.create({ doc: 'AAAA BBBB CCCC', extensions: [R.agentRegionsExtension()] }),
    parent: host,
  });
  R.beginRegion(view, 'j1', 'Claude', 5, 9); // over "BBBB"
  assert.equal(R.activeRegions(view.state).length, 1);

  // user edit inside region → blocked (doc unchanged)
  const before = view.state.doc.toString();
  view.dispatch({ changes: { from: 6, to: 6, insert: 'x' }, userEvent: 'input.type' });
  assert.equal(view.state.doc.toString(), before, 'typing inside the agent region is blocked');

  // user edit elsewhere → allowed
  view.dispatch({ changes: { from: 0, to: 0, insert: 'Z' }, userEvent: 'input.type' });
  assert.ok(view.state.doc.toString().startsWith('Z'), 'typing outside the region is allowed');

  // agent append lands + extends the region
  const r0 = R.activeRegions(view.state).find((r) => r.id === 'j1');
  R.appendRegion(view, 'j1', '!!!');
  const r1 = R.activeRegions(view.state).find((r) => r.id === 'j1');
  assert.equal(r1.to - r1.from, (r0.to - r0.from) + 3, 'appendRegion extended the region by the inserted length');
  assert.ok(view.state.doc.toString().includes('BBBB!!!'), 'agent text landed inside the region');

  // finish → region gone, text stays
  const fin = R.finishRegion(view, 'j1');
  assert.ok(fin && typeof fin.from === 'number');
  assert.equal(R.activeRegions(view.state).length, 0, 'region cleared on finish');
  assert.ok(view.state.doc.toString().includes('BBBB!!!'), 'agent text remains after finish');
  view.destroy();
} else {
  console.log('notes-regions: jsdom not installed — ran pure blocksChange/remap tests, skipped the live-view test');
}

console.log('notes-regions tests passed');
