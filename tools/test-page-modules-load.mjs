// Do the dashboard entry points actually EVALUATE?
//
// test-modules-parse.mjs proves every module is syntactically valid, and that is a
// different question. `let a = B; const B = 8;` parses perfectly and throws
// "Cannot access 'B' before initialization" the moment it runs — a temporal dead zone
// error at module scope, which means the page never initialises at all. That shipped, and
// it presented as "briefs.html takes forever to load": nothing was slow, nothing had
// loaded.
//
// So this evaluates each page module against a minimal DOM and chrome stub and fails on any
// module-SCOPE throw. A page's own init() may still fail against a stub this thin — every
// one of them catches that itself — so only load-time errors are asserted here.

import assert from 'node:assert/strict';

function stubDom() {
  const el = () => {
    const node = {
      style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
      dataset: {}, children: [], value: '', textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { node.children.push(c); return c; },
      prepend() {}, remove() {}, closest: () => null, focus() {}, click() {},
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      insertAdjacentHTML() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    };
    return node;
  };
  globalThis.document = {
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
    createElement: () => el(),
    createElementNS: () => el(),
    createTextNode: () => el(),
    addEventListener() {}, removeEventListener() {},
    body: el(), head: el(), documentElement: el(),
    readyState: 'complete',
  };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { hash: '', pathname: '/x.html', href: 'chrome-extension://test/x.html', assign() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800,
  };
  globalThis.location = window.location;
  globalThis.history = { replaceState() {}, pushState() {} };
  // Node ships a read-only `navigator`; define over it rather than assigning.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', language: 'en-US', clipboard: { writeText: async () => {} } },
    configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.requestIdleCallback = (fn) => setTimeout(() => fn({ timeRemaining: () => 0 }), 0);
  globalThis.matchMedia = window.matchMedia;
  globalThis.getComputedStyle = window.getComputedStyle;
  // Real in every browser; notes.js reads its UI config from it at module scope.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  globalThis.sessionStorage = globalThis.localStorage;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
}

function stubChrome() {
  const area = () => ({ async get() { return {}; }, async set() {}, async remove() {}, async clear() {} });
  globalThis.chrome = {
    runtime: {
      id: 'test', getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async () => ({}), onMessage: { addListener() {} },
      openOptionsPage() {}, lastError: null, getManifest: () => ({ version: '0.0.0' }),
    },
    storage: { local: area(), session: area(), sync: area(), onChanged: { addListener() {} } },
    tabs: { create() {}, query: (_q, cb) => cb && cb([]), sendMessage: async () => ({}), onUpdated: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 1 }) },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    permissions: { contains: async () => true, request: async () => true },
  };
}

// A page's init() runs after its module evaluates, and against a stub this thin it will
// often fail — that is not what this file tests, and letting it crash the process would
// hide the result. Only module-SCOPE failures are collected, below.
const late = [];
process.on('uncaughtException', (e) => late.push(e));
process.on('unhandledRejection', (e) => late.push(e));

stubDom();
stubChrome();

// The dashboards. sidepanel.js and settings.js are deliberately not here: they touch far
// more of the platform at load, so a stub thin enough to be maintainable would fail for
// reasons that are not bugs. These four are the pages whose module scope is plain code.
const PAGES = ['briefs.js', 'notes.js', 'history.js', 'meetings.js'];

let failures = 0;
for (const page of PAGES) {
  try {
    await import(`../extension/${page}`);
    console.log(`  ok   ${page}`);
  } catch (err) {
    // A page's own init() catches its failures; anything reaching here is module scope.
    failures += 1;
    console.error(`  FAIL ${page}: ${err?.message || err}`);
    if (/before initialization|is not defined|Cannot read properties of undefined \(reading/.test(String(err?.message))) {
      console.error('       ^ this is a load-time error — the page would never initialise');
    }
  }
}
// Give any init() a moment to finish (and fail) so it lands in `late` rather than escaping
// after the assertion below has already passed.
await new Promise((r) => setTimeout(r, 50));
if (late.length) console.log(`  (${late.length} post-load init error(s) from the thin DOM stub — not asserted)`);

// EXIT EXPLICITLY, do not throw. The handlers above catch unhandled rejections, and an
// assertion at the top level of an async module IS one — so `assert.equal` here reported
// the failure and then exited 0, disarming the very check this file exists to make.
if (failures) {
  console.error(`\n✕ ${failures} dashboard page(s) throw at module load`);
  process.exit(1);
}
assert.equal(failures, 0);

console.log('page modules load tests passed');
