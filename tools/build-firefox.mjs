// Build the Firefox add-on from the SAME extension/ source tree as the Chrome zip.
//
//   node tools/build-firefox.mjs
//
// Produces:
//   dist/chatpanel-firefox.zip            stable name (CI + AMO upload)
//   dist/chatpanel-firefox-v<version>.zip versioned copy
//   dist/chatpanel-firefox.xpi            same bytes, the name Firefox expects from a
//                                         direct download (dl.chatpanel.net/firefox.xpi)
//   dist/chatpanel-firefox-sources.zip    AMO source-code submission (see below)
//   dist/chatpanel-firefox-sources-v<version>.zip
//                                         versioned copy of the same archive
//
// There is no separate Firefox source tree and there must never be one: everything
// here is derived from extension/ + tools/firefox-manifest.mjs, so a feature lands in
// both browsers at once and the two packages ship from a single `ext-v*` tag.
//
// WHY A SOURCES ZIP: AMO requires the original source whenever a submission contains
// minified, concatenated or otherwise machine-generated code. Two files qualify —
// js/vendor/codemirror.js (built by tools/build-editor.mjs from the @codemirror/*
// packages) and js/vendor/web-llm.js (the published @mlc-ai/web-llm dist bundle).
// Everything else in the package is hand-written, unminified ES modules that a
// reviewer reads as-is.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT, CHROMIUM_ONLY_FILES, readChromeManifest, toFirefoxManifest,
} from './firefox-manifest.mjs';

const extDir = path.join(ROOT, 'extension');
const distDir = path.join(ROOT, 'dist');
const stageDir = path.join(distDir, 'firefox');

const chromeManifest = readChromeManifest(extDir);
const manifest = toFirefoxManifest(chromeManifest);
const version = manifest.version;

// Firefox's version format is stricter than "anything dotted": at most 4 parts, each
// a plain number for our purposes. Catch a bad bump here rather than at AMO upload.
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`manifest.json version "${version}" is not a valid Firefox add-on version.`);
}
// AMO shows the manifest description on the listing; keep the same 132-char budget the
// Chrome packager enforces so one string works for every store.
if ((manifest.description || '').length > 132) {
  throw new Error(`manifest.json description is ${manifest.description.length} chars; the store limit is 132.`);
}

// --- stage: a clean copy of extension/, minus the Chromium-only files -------
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(extDir, stageDir, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(extDir, src);
    if (!rel) return true;
    if (rel === '.DS_Store' || rel.endsWith(`${path.sep}.DS_Store`)) return false;
    return !CHROMIUM_ONLY_FILES.includes(rel.split(path.sep).join('/'));
  },
});
writeFileSync(path.join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Every path the manifest points at must survive the copy — a dropped file that is
// still referenced is how an add-on gets rejected for a broken package.
const referenced = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.sidebar_action?.default_icon || {}),
  manifest.sidebar_action?.default_panel,
  manifest.options_ui?.page,
  ...(manifest.background?.scripts || []),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources || []),
].filter(Boolean);
for (const rel of referenced) {
  if (!existsSync(path.join(stageDir, rel))) throw new Error(`Firefox package is missing a file its manifest references: ${rel}`);
}

// --- AMO's 5 MB source-parse ceiling ---------------------------------------
// addons-linter refuses to parse a non-binary file over 5 MB and reports
//   "This file is not binary and is too large to parse."
// which blocks the submission. A build that produces an unsubmittable package should
// fail HERE, with the offending file named, rather than after an upload round-trip.
// Checked across the whole staged tree so this cannot recur for some future bundle.
const AMO_MAX_PARSE_BYTES = 5 * 1024 * 1024;
const PARSED_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.css', '.html']);
function oversizedFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { oversizedFiles(full, out); continue; }
    if (!PARSED_EXTENSIONS.has(path.extname(e.name))) continue;
    const { size } = statSync(full);
    if (size > AMO_MAX_PARSE_BYTES) out.push({ rel: path.relative(stageDir, full), size });
  }
  return out;
}
const oversized = oversizedFiles(stageDir);
if (oversized.length) {
  throw new Error(
    `AMO will refuse to parse ${oversized.length} file(s) over 5 MB:\n` +
    oversized.map((f) => `  ${f.rel} (${(f.size / 1024 / 1024).toFixed(1)} MB)`).join('\n') +
    '\nEither split the file, or — if it cannot run on Firefox anyway — add it to ' +
    'CHROMIUM_ONLY_FILES in tools/firefox-manifest.mjs so it is left out of this package.',
  );
}

// --- zip -------------------------------------------------------------------
mkdirSync(distDir, { recursive: true });
const stable = path.join(distDir, 'chatpanel-firefox.zip');
const versioned = path.join(distDir, `chatpanel-firefox-v${version}.zip`);
const xpi = path.join(distDir, 'chatpanel-firefox.xpi');
const sources = path.join(distDir, 'chatpanel-firefox-sources.zip');
// The sources archive gets a versioned name too, for the same reason the package does.
// AMO asks for the package and the source SEPARATELY, and a submission is rejected if
// they disagree about the version — so which sources belong to which upload has to be
// readable off the filename, not inferred from a timestamp.
const sourcesVersioned = path.join(distDir, `chatpanel-firefox-sources-v${version}.zip`);
for (const f of [stable, versioned, xpi, sources, sourcesVersioned]) if (existsSync(f)) rmSync(f);

execFileSync('zip', ['-r', '-X', '-q', stable, '.', '-x', '*.DS_Store', '-x', '__MACOSX*'], {
  cwd: stageDir,
  stdio: 'inherit',
});
copyFileSync(stable, versioned);
// AMO accepts either extension; .xpi is what a browser needs to offer "Add to Firefox"
// on a direct download, so dl.chatpanel.net serves this one.
copyFileSync(stable, xpi);

// --- AMO source submission --------------------------------------------------
execFileSync(
  'zip',
  [
    '-r', '-X', '-q', sources,
    'package.json', 'package-lock.json', 'tools', 'extension', 'README.md', 'LICENSE',
    '-x', '*.DS_Store', '-x', '__MACOSX*', '-x', 'extension/js/vendor/*',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
// Tell the reviewer exactly how to reproduce the two generated files.
const buildNotes = `ChatPanel for Firefox — build instructions
==========================================

Requirements: Node.js 20+ and npm. No network access is needed at runtime.

  npm ci
  npm run build:editor      # regenerates extension/js/vendor/codemirror.js
  npm run build:icons       # regenerates extension/js/icons.js
  npm run package:firefox   # regenerates dist/chatpanel-firefox.zip

Both generated files are byte-for-byte reproducible from this archive: the esbuild
bundle is deterministic for the versions pinned in package-lock.json, and the icon
module is generated from the SVGs included under tools/icons/svg/.

The submitted package is dist/chatpanel-firefox.zip, produced by
tools/build-firefox.mjs from the extension/ directory in this archive. That script
copies extension/ verbatim, drops the two Chromium-only files (offscreen.html and
js/offscreen-webllm.js, which serve the chrome.offscreen API that Firefox does not
have), and replaces manifest.json with the Firefox manifest derived by
tools/firefox-manifest.mjs. Nothing else differs between the Chrome and Firefox
packages.

Generated / third-party files in the package
--------------------------------------------
extension/js/vendor/codemirror.js
    THE ONLY MINIFIED FILE IN THE PACKAGE. Built by tools/build-editor.mjs (esbuild,
    bundle + minify) from the @codemirror/* and @lezer/* packages pinned in
    package-lock.json. Deliberately excluded from this archive so it is rebuilt rather
    than read: run \`npm ci && npm run build:editor\` to reproduce it byte-for-byte. The
    unbundled entry point is tools/editor/entry.js.
extension/js/icons.js
    Generated by tools/icons/build-icons.mjs from the 95 Lucide (ISC) SVGs included in
    this archive at tools/icons/svg/. Not minified — readable as shipped. No network
    access is needed: the SVGs are vendored, not fetched from lucide-static.
extension/js/vendor/web-llm.js
    NOT part of the Firefox package at all. It is the unmodified published dist bundle
    of @mlc-ai/web-llm, used only by the Chrome/Edge build: its runtime requires the
    WebGPU limit maxStorageBuffersPerShaderStage = 10, and Firefox reports the spec
    default of 8, so the in-browser model can never initialize on Firefox. It is
    excluded from both the package and this archive.
extension/js/pii-redact.js, pii-detect.js, tool-rank.js, tool-harness.js,
extension/js/sanitize.js, net.js
    Copied verbatim from the @chatpanel/pii package by tools/sync-pii.mjs.
extension/js/events/*
    Copied verbatim from the @chatpanel/events package by tools/sync-events.mjs.

Everything else is hand-written, unminified ES modules.
`;
const notesPath = path.join(distDir, 'BUILD-INSTRUCTIONS.txt');
writeFileSync(notesPath, buildNotes);
execFileSync('zip', ['-X', '-q', '-j', sources, notesPath], { cwd: ROOT, stdio: 'inherit' });
rmSync(notesPath);
copyFileSync(sources, sourcesVersioned);

const kb = (p) => `${Math.round(readFileSync(p).length / 1024)} KB`;
console.log(`\n✓ Packaged Firefox add-on v${version}  (id ${manifest.browser_specific_settings.gecko.id}, Firefox ${manifest.browser_specific_settings.gecko.strict_min_version}+)`);
for (const f of [stable, versioned, xpi]) console.log(`  ${path.relative(ROOT, f).padEnd(44)} ${kb(f)}`);
console.log('\n  Upload the package above to AMO, and THIS as the source code:');
for (const f of [sources, sourcesVersioned]) console.log(`  ${path.relative(ROOT, f).padEnd(44)} ${kb(f)}`);
