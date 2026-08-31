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

// 6. Artifacts are never executed through a blob: URL made here — such a document inherits
// the panel's CSP (script-src 'self'), so inline scripts silently never run.
assert.ok(!/createObjectURL/.test(artifacts), 'artifacts are not run via a blob: URL from the panel');
assert.match(artifacts, /window\.open\(url/, 'the pop-out goes through the sandbox page');

console.log('ok — artifacts run only in an opaque-origin sandbox; never same-origin, never in-panel, never blob:');
