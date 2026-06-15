// Package the MV3 extension into a Web Store-ready zip.
//
//   node tools/package-extension.mjs
//
// Produces dist/chatpanel-extension.zip (stable name for CI) and a versioned
// copy dist/chatpanel-extension-v<version>.zip. Zips the CONTENTS of extension/
// so manifest.json sits at the archive root (required by the Web Store).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');

const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`manifest.json version "${version}" is not a valid Chrome version.`);
}

// Sanity: the Web Store caps the manifest description at 132 chars.
if ((manifest.description || '').length > 132) {
  throw new Error(
    `manifest.json description is ${manifest.description.length} chars; the Web Store limit is 132.`,
  );
}

// Sanity: the icons referenced by the manifest must exist.
for (const p of Object.values(manifest.icons || {})) {
  if (!existsSync(path.join(extDir, p))) throw new Error(`Missing icon referenced by manifest: ${p}`);
}

mkdirSync(distDir, { recursive: true });
const stable = path.join(distDir, 'chatpanel-extension.zip');
const versioned = path.join(distDir, `chatpanel-extension-v${version}.zip`);
for (const f of [stable, versioned]) if (existsSync(f)) rmSync(f);

// `zip` is present on macOS and ubuntu CI runners.
execFileSync('zip', ['-r', '-X', stable, '.', '-x', '*.DS_Store', '-x', '__MACOSX*'], {
  cwd: extDir,
  stdio: 'inherit',
});
copyFileSync(stable, versioned);

console.log(`\n✓ Packaged extension v${version}`);
console.log(`  ${path.relative(root, stable)}`);
console.log(`  ${path.relative(root, versioned)}`);
