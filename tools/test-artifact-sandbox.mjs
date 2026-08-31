// The artifact sandbox's security invariants. AI-generated HTML/JS must never run with
// extension privileges — these assertions are the guard rail on that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const artifacts = read('js/artifacts.js');
const runner = read('js/sandbox-runner.js');
const sandboxPage = read('sandbox.html');
const markdown = read('js/markdown.js');

// 1. The sandbox page is declared as a MANIFEST SANDBOX page → opaque origin, no chrome.*.
assert.deepEqual(manifest.sandbox?.pages, ['sandbox.html'], 'sandbox.html is a manifest sandbox page');
assert.ok(manifest.content_security_policy?.sandbox, 'the sandbox has its own CSP entry');

// 2. NEVER allow-same-origin — that would hand the artifact our origin and defeat isolation.
// Check the ACTUAL grants, not the prose: these files explain why allow-same-origin is
// forbidden, so a substring search would match their comments. Every sandbox attribute
// value that is set anywhere must exclude it.
const grants = [
  ...artifacts.matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'/g),
  ...sandboxPage.matchAll(/sandbox="([^"]*)"/g),
  ...runner.matchAll(/sandbox="([^"]*)"/g),
].map((m) => m[1]);
assert.ok(grants.length >= 2, 'found the sandbox attribute grants');
for (const g of grants) {
  assert.ok(!/allow-same-origin/.test(g), `a sandbox grant includes allow-same-origin: "${g}"`);
  assert.match(g, /allow-scripts/, `a sandbox grant should allow scripts (and little else): "${g}"`);
}
// The panel frame must NOT re-sandbox the page: sandbox.html is already a manifest sandbox
// page, and sandboxing it again re-opaques the origin so `script-src 'self'` stops matching
// and the runner never loads (the "Preview is empty" bug). Isolation comes from the manifest.
assert.ok(!/frame\.setAttribute\('sandbox'/.test(artifacts),
  'the panel must not add a sandbox attribute to the already-sandboxed page');
assert.match(sandboxPage, /sandbox="allow-scripts"/, 'nested artifact frame is allow-scripts only');

// 3. The panel itself never executes artifact HTML: no innerHTML of the source, no eval.
assert.ok(!/\beval\(|new Function\(/.test(artifacts), 'artifacts.js never evals');
assert.ok(!/innerHTML\s*=\s*html/.test(artifacts), 'artifacts.js never injects the artifact into the panel DOM');

// 4. markdown.js emits the artifact as ESCAPED source in a placeholder — not live markup.
assert.match(markdown, /md-artifact-html/, 'html blocks become an upgradeable placeholder');
assert.ok(!/unescapeHtml\(buf/.test(markdown), 'the html block source is never unescaped into the page');

// 5. The runner only accepts drive messages from its embedder (parent), not any window.
// `host` is the parent frame when embedded, or the opener when opened as a tab — the runner
// accepts drive messages from that window only.
assert.match(runner, /ev\.source !== host/, 'runner ignores messages that are not from its host');
assert.match(runner, /window\.parent !== window\) \? window\.parent : window\.opener/, 'host is parent-or-opener');

// 6. EXECUTABLE artifacts are never run through a blob: URL made here — such a document
// inherits the panel's CSP (script-src 'self'), so inline scripts silently never run. A blob
// is still fine for an inert SVG IMAGE (no scripts involved), so the rule is about type.
for (const m of artifacts.matchAll(/new Blob\(\[[^\]]*\],\s*\{\s*type:\s*'([^']+)'/g)) {
  assert.equal(m[1], 'image/svg+xml', `a blob: URL may only carry an inert SVG image, got ${m[1]}`);
}
assert.ok(!/new Blob\(\[html\]/.test(artifacts), 'artifact HTML is never turned into a blob: document');
assert.match(artifacts, /window\.open\(url, '_blank'\)/, 'the HTML pop-out goes through the sandbox page');

// 7. The EDITABLE source view must not become an injection path: a textarea can only hold
// text, so pasted markup stays inert characters. A contenteditable region would put
// attacker-shaped nodes straight into the panel's DOM.
assert.match(artifacts, /el\('textarea', 'artifact-editor'\)/, 'the editor is a textarea');
// Check the code, not the prose (the file explains WHY contenteditable is avoided).
const artifactCode = artifacts.replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/contentEditable|contenteditable/.test(artifactCode), 'never a contenteditable source view');
// Edited text follows the same path as the model's: into the sandbox, never into the panel.
assert.match(artifacts, /const currentHtml = \(\) => editor\.value/, 'the edited value is read as text');
assert.ok(!/innerHTML\s*=\s*(currentHtml|editor)/.test(artifacts), 'edited source is never injected into the panel');

console.log('ok — artifacts run only in an opaque-origin sandbox; never same-origin, never in-panel, never blob:; editing stays text');
