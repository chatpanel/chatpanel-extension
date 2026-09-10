// Asking the user to TYPE something is a ChatPanel dialog, never an OS one.
//
// `prompt()` puts up a box titled "The extension ChatPanel says", unstyled, with no character
// budget, no example of a good answer and no second field — and in a side panel or a sandboxed
// frame the browser may decline to show it at all, which turns the button that called it into
// a dead button. So every ask goes through `promptText` in js/confirm-modal.js, next to the
// destructive `confirmDelete`, and this test holds both halves: the component behaves, and no
// surface has quietly gone back to the native box.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = (p) => readFileSync(join(root, 'extension', p), 'utf8');

// ── a DOM small enough to reason about, big enough for the dialog ────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.scrollHeight = 0;
    this._listeners = {};
    this._text = '';
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    };
  }
  get className() { return [...this.classList._s].join(' '); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(v) { this._text = String(v ?? ''); }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this._html = String(v ?? ''); }
  get innerHTML() { return this._html || ''; }
  get childElementCount() { return this.children.length; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
  setAttribute(k, v) { this[`attr:${k}`] = String(v); }
  getAttribute(k) { return this[`attr:${k}`] ?? null; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  focus() {}
  select() {}
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(cls) { return this.all().find((e) => e.classList.contains(cls)) || null; }
}
// A <select> reports the value of the option marked selected — the one behaviour of the real
// element the dialog actually leans on.
class SelectEl extends El {
  get value() { return (this.children.find((o) => o.selected) || this.children[0])?.value ?? ''; }
  set value(v) { if (v !== '') for (const o of this.children) o.selected = o.value === v; }
}

const keyHandlers = [];
const doc = {
  head: null,
  body: null,
  createElement: (tag) => (String(tag).toLowerCase() === 'select' ? new SelectEl(tag) : new El(tag)),
  getElementById: () => null,
  addEventListener: (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); },
  removeEventListener: (type, fn) => {
    const i = keyHandlers.indexOf(fn);
    if (i >= 0) keyHandlers.splice(i, 1);
  },
};
doc.head = new El('head');
doc.body = new El('body');
globalThis.document = doc;

const { promptText } = await import('../extension/js/confirm-modal.js');

const open = (opts) => {
  const done = promptText(opts);
  const ov = doc.body.children.at(-1);
  return {
    done,
    ov,
    input: ov.find('cp-prompt-input'),
    ok: ov.find('cp-prompt-ok'),
    cancel: ov.find('cp-confirm-cancel'),
    count: ov.find('cp-prompt-count'),
    select: ov.find('cp-prompt-select'),
    type(text) {
      this.input.value = text;
      this.input.oninput();
    },
    enter(extra = {}) { this.input.onkeydown({ key: 'Enter', preventDefault() {}, ...extra }); },
    esc() { keyHandlers.at(-1)({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); },
  };
};

// ── the value comes back, and the dialog goes away ───────────────────────────
{
  const d = open({ title: 'Remember something', confirmLabel: 'Remember' });
  assert.ok(d.ok.disabled, 'an empty field cannot be submitted');
  d.type('Prefers terse answers');
  assert.equal(d.ok.disabled, false, 'typing enables the button');
  d.ok.onclick();
  assert.deepEqual(await d.done, { text: 'Prefers terse answers', choice: '' });
  assert.equal(doc.body.children.length, 0, 'the overlay is removed');
  assert.equal(keyHandlers.length, 0, 'and its key handler with it');
}

// ── Enter submits; Shift+Enter is a newline ──────────────────────────────────
{
  const d = open({ multiline: true });
  d.type('Deploys on Fridays');
  d.enter({ shiftKey: true });
  assert.equal(doc.body.children.length, 1, 'Shift+Enter keeps the dialog open');
  d.enter();
  assert.equal((await d.done).text, 'Deploys on Fridays');
}

// ── every dismissal resolves null, so a caller can test one thing ────────────
for (const dismiss of ['cancel', 'escape', 'backdrop']) {
  const d = open({});
  d.type('typed but abandoned');
  if (dismiss === 'cancel') d.cancel.onclick();
  if (dismiss === 'escape') d.esc();
  if (dismiss === 'backdrop') d.ov._listeners.mousedown[0]({ target: d.ov });
  assert.equal(await d.done, null, `${dismiss} resolves null, never the typed text`);
  assert.equal(doc.body.children.length, 0);
}

// ── the bounds the store would enforce are enforced BEFORE the round trip ────
{
  const d = open({ maxLength: 20, minLength: 3 });
  d.type('ab');
  assert.ok(d.ok.disabled, 'under the minimum stays disabled');
  assert.equal(d.count.textContent, '2/20', 'the counter says why');
  d.type('x'.repeat(21));
  assert.ok(d.ok.disabled, 'over the cap is disabled too');
  assert.ok(d.count.classList.contains('over'), 'and the counter marks itself');
  // Over the cap the keystrokes are NOT eaten — the text stays, so the user can edit it down.
  assert.equal(d.input.value.length, 21, 'typing past the cap is not silently swallowed');
  d.enter();
  assert.equal(doc.body.children.length, 1, 'Enter cannot bypass the bounds either');
  d.type('within bounds');
  d.ok.onclick();
  assert.equal((await d.done).text, 'within bounds');
}

// ── the optional second field: a value that has a type as well as a text ─────
{
  const d = open({
    choice: {
      label: 'Kind',
      value: 'preference',
      options: [
        { value: 'identity', label: 'Identity', hint: 'Who the user is.' },
        { value: 'preference', label: 'Preference', hint: 'How they want things done.' },
        { value: 'fact', label: 'Fact', hint: 'A durable fact.' },
      ],
    },
  });
  assert.equal(d.select.value, 'preference', 'the caller\'s default is preselected');
  const hint = d.ov.find('cp-prompt-hint');
  assert.equal(hint.textContent, 'How they want things done.', 'the chosen kind explains itself');
  d.select.value = 'fact';
  d.select.onchange();
  assert.equal(hint.textContent, 'A durable fact.', 'and keeps explaining itself when changed');
  d.type('Skip manager is Jordan Blake');
  d.ok.onclick();
  assert.deepEqual(await d.done, { text: 'Skip manager is Jordan Blake', choice: 'fact' });
}

// ── a value passed in is the starting point (rename, not retype) ─────────────
{
  const d = open({ value: 'Old name  ' });
  assert.equal(d.input.value, 'Old name  ', 'the current value is prefilled');
  assert.equal(d.ok.disabled, false, 'and is submittable as-is');
  d.ok.onclick();
  assert.equal((await d.done).text, 'Old name', 'trimmed on the way out');
}

// ── the title is clamped by the same helper the destructive dialog uses ──────
{
  const d = open({ title: 'T'.repeat(300) });
  assert.ok(d.ov.find('cp-confirm-title').textContent.length <= 80, 'a long title cannot size the card');
  d.cancel.onclick();
  await d.done;
}

// ── nothing anywhere falls back to the OS box ────────────────────────────────
const surfaces = [
  ...readdirSync(join(root, 'extension')).filter((f) => f.endsWith('.js')).map((f) => f),
  ...readdirSync(join(root, 'extension/js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
];
const NATIVE = /(?<![\w.$])(?:window\.)?(?:prompt|alert)\s*\(/;
for (const file of surfaces) {
  const src = ext(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments explain the rule; they aren't calls
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, NATIVE, `${file} must ask through promptText, not a native prompt()/alert()`);
}
// The page scripts own their own dialogs — an injected `confirm` callback is a js/ module
// contract, but a top-level page calling confirm() is the native box.
for (const page of ['settings.js', 'sidepanel.js', 'notes.js', 'meetings.js', 'history.js']) {
  const src = ext(page).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /(?<![\w.$])(?:window\.)?confirm\s*\(/, `${page} must use confirmDelete, not native confirm()`);
}

// ── and the memory pane, the ask that prompted all this, uses it properly ────
const settings = ext('settings.js');
assert.match(settings, /const \[\{ promptText \}[\s\S]{0,200}?import\('\.\/js\/confirm-modal\.js'\)/, 'memory adds through the modal');
assert.match(settings, /maxLength: MAX_MEMORY_CHARS/, 'bounded by the contract, not by a number typed here');
assert.match(settings, /minLength: MIN_MEMORY_CHARS/);
assert.match(settings, /options: MEMORY_KIND_NAMES\.map/, 'the kinds come from the contract too');
// Off first paint: the modal is 3 KB of styles nobody needs until they click Add.
assert.doesNotMatch(settings, /^import .*confirm-modal\.js/m, 'confirm-modal stays dynamic-imported');

console.log('prompt modal: ok');
