// First paint, as a number that fails the build rather than a principle people remember.
//
// The rule already exists — "absolute-lowest initial load is a HARD requirement", action-only
// modules get `await import()` at the call site — and nothing checked it. So a static import
// added for a good reason (a service worker CANNOT dynamic-import, so anything it must run has
// to be static) grew the worker from 221 KB to 488 KB, and the first anyone knew was a user
// saying loading "takes forever".
//
// What this measures: the STATIC module graph reachable from each entry point — `import … from`
// only, never `import()`, because a dynamic import is exactly the thing that keeps weight OFF
// this number. Bytes of source, which is what the engine must fetch, parse and instantiate
// before the entry point runs.
//
// A budget going UP needs a reason in the commit message. A budget going DOWN should be
// tightened here in the same change, so the ratchet only turns one way.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'extension');

// KB. Ceilings, not targets — every one of these is above what the tree costs today.
const BUDGET = {
  // Chat first: providers.js and the turn harness behind it (169 KB) load on the first turn,
  // not to paint the box. Tightened the moment that landed — the ratchet only turns one way.
  'sidepanel.js': 770,
  'settings.js': 1120,
  'notes.js': 910,
  // The worker is the one that regressed. It carries jobs, warm sync and unattended backup
  // because a worker cannot reach a module it did not import statically, and all three were
  // silently dead before. This ceiling is deliberately close to today's cost so the next
  // addition has to be argued for rather than absorbed.
  'background.js': 500,
};

function staticGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(path.join(extDir, rel), 'utf8'); } catch { continue; }
    const from = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
    const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
    for (const re of [from, bare]) {
      let m;
      while ((m = re.exec(src))) {
        if (!m[1].startsWith('.')) continue;
        stack.push(path.relative(extDir, path.resolve(path.dirname(path.join(extDir, rel)), m[1]))
          .split(path.sep).join('/'));
      }
    }
  }
  return seen;
}
const kb = (files) => [...files].reduce((n, f) => {
  try { return n + statSync(path.join(extDir, f)).size; } catch { return n; }
}, 0) / 1024;

const report = [];
for (const [entry, budget] of Object.entries(BUDGET)) {
  const graph = staticGraph(entry);
  const size = kb(graph);
  report.push(`  ${entry.padEnd(15)} ${size.toFixed(1).padStart(7)} KB / ${String(budget).padStart(4)} KB  (${graph.size} modules)`);
  assert.ok(size <= budget,
    `${entry} first paint is ${size.toFixed(1)} KB, over its ${budget} KB budget.\n`
    + '  Anything used only on a user action or after the first turn belongs behind an\n'
    + '  `await import()` at its call site — not a static import at module top. If the weight\n'
    + '  is genuinely required to paint, raise the budget here and say why in the commit.');
}

// The heaviest thing a first paint can carry is a module nobody needs yet. These are the ones
// most recently argued about; each must stay OFF the graphs that do not use it.
const OFF_LIMITS = {
  // The model layer. A chat interface has to PAINT before it can run a turn, and running one
  // is an async user action that cannot tell the difference. Three modules used to pull this
  // statically (sidepanel, suggestions, assist) — deferring any two of them saved nothing,
  // which is why this is asserted rather than remembered.
  'js/providers.js': ['sidepanel.js'],
  'js/qr.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/bridge-update.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/channels.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/backup-payload.js': ['sidepanel.js', 'notes.js', 'settings.js'], // the worker needs it; no document does
};
for (const [mod, entries] of Object.entries(OFF_LIMITS)) {
  for (const entry of entries) {
    assert.ok(!staticGraph(entry).has(mod),
      `${mod} is statically reachable from ${entry}. It is only needed on a user action — `
      + 'import it at the call site so it costs nothing until then.');
  }
}

console.log('first-paint budgets:\n' + report.join('\n'));
