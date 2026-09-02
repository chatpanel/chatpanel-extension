// The tag controls, and the wiring that has to exist on every surface.
//
// Two halves:
//   1. js/tag-bar.js against a small DOM — the chip editor and the facet row are ONE
//      component used by four surfaces, so a keyboard behaviour that breaks here breaks
//      in all four at once.
//   2. Static assertions that each surface actually mounts it and offers a rename. A
//      component nothing renders is the failure mode that a component test cannot see.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = (p) => readFileSync(join(root, 'extension', p), 'utf8');

// ── a DOM small enough to reason about, big enough for the component ─────────
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.style = { cssText: '' };
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    };
    this.dataset = {};
    this._text = '';
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  // Like the real thing: assigning text REPLACES the children with one text node — which
  // is what makes an inline editor's save-and-restore testable at all.
  set textContent(v) {
    this.children = [];
    if (String(v)) this.appendChild({ nodeType: 3, textContent: String(v), all: () => [], matches: () => false });
  }
  set innerHTML(v) { if (!v) { this.children = []; this._text = ''; } }
  get childNodes() { return this.children; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceWith(next) {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children[i] = next, (next.parentNode = this.parentNode);
  }
  setAttribute(k, v) { this[`attr:${k}`] = String(v); }
  getAttribute(k) { return this[`attr:${k}`] ?? null; }
  focus() { this.ownerDocument._focused = this; }
  select() {}
  querySelector(sel) { return this.all().find((e) => e.matches(sel)) || null; }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((s) => (s.startsWith('.')
      ? this.classList.contains(s.slice(1))
      : this.tagName === s.toUpperCase()));
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}
const doc = {
  head: null,
  createElement(tag) { return new El(tag, doc); },
  getElementById() { return null; },
  defaultView: { getComputedStyle: () => ({ fontSize: '14px', fontWeight: '600', letterSpacing: 'normal' }) },
};
doc.head = new El('head', doc);
globalThis.document = doc;

const { mountTagEditor, mountTagFilter } = await import('../extension/js/tag-bar.js');
const { editTitleInline } = await import('../extension/js/editable-title.js');

const host = () => new El('div', doc);
const chipsOf = (h) => h.children.filter((c) => c.classList.contains('cp-tag')).map((c) => c.textContent.replace('×', '').trim());
const addBtn = (h) => h.children.find((c) => c.classList.contains('cp-tag-add'));
const key = (el, k, extra = {}) => el.onkeydown({ key: k, preventDefault() {}, stopPropagation() {}, ...extra });

// ── chip editor ──────────────────────────────────────────────────────────────
{
  const h = host();
  const saved = [];
  mountTagEditor(h, { tags: ['Design Review', 'q3'], onChange: (next) => saved.push(next) });
  assert.deepEqual(chipsOf(h), ['#design-review', '#q3'], 'chips render the canonical form');

  // Remove via the ×.
  const x = h.children[0].children.find((c) => c.classList.contains('cp-tag-x'));
  x.onclick();
  assert.deepEqual(saved.at(-1), ['q3'], 'removing a chip reports the new list');
  assert.deepEqual(chipsOf(h), ['#q3'], 'and repaints without waiting for the caller');
}

{
  // Typing a tag: Enter commits, and the value is normalized on the way in.
  const h = host();
  const saved = [];
  mountTagEditor(h, { tags: [], onChange: (next) => saved.push(next) });
  addBtn(h).onclick();
  const input = h.children.find((c) => c.classList.contains('cp-tag-entry')).children[0];
  input.value = '  Design Review ';
  key(input, 'Enter');
  assert.deepEqual(saved.at(-1), ['design-review']);
}

{
  // Escape cancels — nothing is written.
  const h = host();
  let calls = 0;
  mountTagEditor(h, { tags: ['a'], onChange: () => { calls += 1; } });
  addBtn(h).onclick();
  const input = h.children.find((c) => c.classList.contains('cp-tag-entry')).children[0];
  input.value = 'b';
  key(input, 'Escape');
  assert.equal(calls, 0, 'Escape must not commit');
  assert.deepEqual(chipsOf(h), ['#a'], 'and the chips come back');
}

{
  // Backspace on an empty field deletes the last chip — what everyone tries first.
  const h = host();
  const saved = [];
  mountTagEditor(h, { tags: ['a', 'b'], onChange: (n) => saved.push(n) });
  addBtn(h).onclick();
  const input = h.children.find((c) => c.classList.contains('cp-tag-entry')).children[0];
  input.value = '';
  key(input, 'Backspace');
  assert.deepEqual(saved.at(-1), ['a']);
}

{
  // Suggestions offer what the user has already coined, never what's on the record.
  const h = host();
  mountTagEditor(h, { tags: ['design'], suggestions: [{ tag: 'design', count: 9 }, { tag: 'q3', count: 2 }] });
  addBtn(h).onclick();
  const entry = h.children.find((c) => c.classList.contains('cp-tag-entry'));
  const opts = entry.children[1].children.map((b) => b.textContent);
  assert.equal(opts.some((t) => t.includes('#q3')), true, 'an unused tag is offered');
  assert.equal(opts.some((t) => t.includes('#design')), false, 'one already on the record is not');
}

{
  // A key pressed inside the field must not reach the page's shortcut handlers.
  const h = host();
  mountTagEditor(h, { tags: [] });
  addBtn(h).onclick();
  const input = h.children.find((c) => c.classList.contains('cp-tag-entry')).children[0];
  let propagated = false;
  input.onkeydown({ key: 'n', preventDefault() {}, stopPropagation() { propagated = true; } });
  assert.equal(propagated, true, 'typing "n" in a tag field must not trigger "new note"');
}

{
  // Read-only chips (a list row) offer no × and no add button.
  const h = host();
  mountTagEditor(h, { tags: ['a'], editable: false });
  assert.equal(addBtn(h), undefined);
  assert.equal(h.children[0].children.some((c) => c.classList.contains('cp-tag-x')), false);
}

// ── facet row ────────────────────────────────────────────────────────────────
{
  const h = host();
  const toggled = [];
  const bar = mountTagFilter(h, {
    facets: [{ tag: 'design', count: 3 }, { tag: 'q3', count: 1 }],
    selected: ['design'],
    onToggle: (t) => toggled.push(t),
  });
  const pills = h.children.filter((c) => c.classList.contains('cp-facet'));
  assert.equal(pills[0].getAttribute('aria-pressed'), 'true', 'a selected tag reads as pressed');
  assert.equal(pills[1].getAttribute('aria-pressed'), 'false');
  assert.equal(pills.some((p) => p.textContent.includes('Clear')), true, 'a selection can always be cleared');
  pills[1].onclick();
  assert.deepEqual(toggled, ['q3']);

  bar.update({ facets: [], selected: [] });
  assert.equal(h.hidden, true, 'no tags anywhere → no filter row at all');
}

{
  // Truncation must not hide the tag currently filtering the list.
  const h = host();
  const facets = Array.from({ length: 20 }, (_, i) => ({ tag: `t${i}`, count: 20 - i }));
  mountTagFilter(h, { facets, selected: ['t19'], visible: 5, onToggle: () => {} });
  const shown = h.children.filter((c) => c.classList.contains('cp-facet')).map((c) => c.textContent);
  assert.equal(shown.some((t) => t.includes('#t19')), true);
  assert.equal(shown.some((t) => t.includes('more')), true, 'and the rest are reachable');
}

// ── inline rename ────────────────────────────────────────────────────────────
{
  const h = host();
  h.textContent = 'Zoom Meeting';
  const committed = [];
  const input = editTitleInline(h, { value: 'Zoom Meeting', onCommit: (t) => committed.push(t) });
  input.value = '  Q3 pricing call  ';
  key(input, 'Enter');
  assert.deepEqual(committed, ['Q3 pricing call'], 'the title is trimmed, then committed');
  assert.equal(h.textContent, 'Zoom Meeting', 'the element is restored; the caller repaints');
}

{
  const h = host();
  h.textContent = 'Keep me';
  const committed = [];
  const input = editTitleInline(h, { value: 'Keep me', onCommit: (t) => committed.push(t) });
  input.value = '';
  key(input, 'Enter');
  assert.deepEqual(committed, [], 'an empty title is never written');

  const input2 = editTitleInline(h, { value: 'Keep me', onCommit: (t) => committed.push(t) });
  input2.value = 'Keep me';
  input2.onblur();
  assert.deepEqual(committed, [], 'and neither is an unchanged one');
}

{
  const h = host();
  const committed = [];
  const input = editTitleInline(h, { value: 'Old', onCommit: (t) => committed.push(t) });
  input.value = 'New';
  key(input, 'Escape');
  input.onblur(); // blur always follows — it must not resurrect the cancelled edit
  assert.deepEqual(committed, [], 'Escape cancels, and the blur behind it changes nothing');
}

// ── every surface is actually wired ──────────────────────────────────────────
// The side panel reaches both controls through js/meeting-labels.js — one module for
// "name and file a meeting", so the drawer row and the meeting view share it.
const labels = ext('js/meeting-labels.js');
assert.match(labels, /tag-bar\.js/);
assert.match(labels, /editable-title\.js/);

for (const [name, src] of Object.entries({
  'notes.js': ext('notes.js'),
  'meetings.js': ext('meetings.js'),
  'history.js': ext('history.js'),
  'sidepanel.js': ext('sidepanel.js'),
})) {
  assert.match(src, /tag-bar\.js|meeting-labels\.js/, `${name} must mount the shared tag control, not its own`);
}
for (const [name, src] of Object.entries({
  'meetings.js': ext('meetings.js'),
  'history.js': ext('history.js'),
  'sidepanel.js': ext('sidepanel.js'),
})) {
  assert.match(src, /editable-title\.js|meeting-labels\.js/, `${name} must rename through the shared control`);
}
// …and renaming has to be reachable from the LIST, not only after opening a meeting —
// the list is where a bad title is actually noticed.
assert.match(ext('sidepanel.js'), /renameMeetingInline/, 'a meeting row must offer a rename');
// Notes, chats and meetings each need somewhere to PUT the filter row.
for (const [page, id] of [['notes.html', 'n-tagfilter'], ['meetings.html', 'm-tagfilter'], ['history.html', 'h-tagfilter']]) {
  assert.match(ext(page), new RegExp(`id="${id}"`), `${page} needs a host for the tag filter row`);
}
// A meeting must be renamable from the panel as well as the dashboard.
assert.match(ext('sidepanel.html'), /id="meeting-rename"/);
assert.match(ext('meetings.js'), /id="m-rename"/);
assert.match(ext('history.js'), /id="h-rename"/);

// The naming ladder must stay OFF the boot paths — the whole reason it is its own module.
for (const entry of ['sidepanel.js', 'background.js', 'js/store-meetings.js', 'js/store.js']) {
  assert.doesNotMatch(ext(entry), /^\s*import[^\n]*events\/titles\.js/m,
    `${entry} must not statically import the naming ladder — it is 13 KB nothing needs to paint`);
}
// Same for the panel and the controls it only needs on a click.
for (const mod of ['tag-bar.js', 'editable-title.js', 'meeting-labels.js', 'meeting-autotitle.js']) {
  assert.doesNotMatch(ext('sidepanel.js'), new RegExp(`^\\s*import[^\\n]*${mod.replace('.', '\\.')}`, 'm'),
    `sidepanel.js must load ${mod} at its call site, not on first paint`);
}

console.log('✓ tag chips, filter row, inline rename, and the wiring on every surface');
