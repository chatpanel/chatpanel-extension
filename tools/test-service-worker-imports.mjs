import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// THE BUG THIS PREVENTS. `import()` inside an MV3 service worker does not work:
//
//   TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification
//   https://github.com/w3c/ServiceWorker/issues/1356
//
// It fails at runtime, on an alarm, with no window open — so the feature simply never
// happens and the only trace is a caught error string somewhere. That is how scheduled
// backup, the job scheduler and background warm sync all shipped broken: each had been
// made lazy for a real first-paint reason, and laziness is unavailable in a worker.
//
// A worker can only reach a module it imported statically. So: nothing on the service
// worker's static graph may contain a dynamic import(), unless it is listed below with a
// reason it is provably off every worker code path. Keep a heavy module off the worker by
// injecting it from the caller (js/backup-payload.js is the pattern), never by import().

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(ROOT, 'extension');
const read = (rel) => readFileSync(path.join(extDir, rel), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const entry = manifest.background?.service_worker;
assert.ok(entry, 'manifest.json should declare a background.service_worker');
assert.equal(manifest.background?.type, 'module',
  'The worker is an ES module; this test walks its static import graph on that assumption.');

// Modules the worker reaches through `import ... from` / `export ... from` only. A
// dynamic import is deliberately NOT followed: it is the thing under test, and in a
// worker it resolves to nothing anyway.
function staticGraph(entryRel) {
  const seen = new Set();
  const stack = [entryRel];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = read(rel); } catch { continue; }
    const from = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
    const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
    for (const re of [from, bare]) {
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue; // vendored packages resolve to files already in the tree
        stack.push(path.relative(extDir, path.resolve(path.dirname(path.join(extDir, rel)), spec))
          .split(path.sep).join('/'));
      }
    }
  }
  return seen;
}

// Sites that sit on the graph but cannot run in the worker. Each needs a reason, and the
// reason has to be "no worker code path calls this function" — not "it is probably fine".
const ALLOWED = [
  {
    file: 'js/store.js',
    spec: './events/skill-manifest.js',
    why: 'Skill write path (normalizeSkillForSave / saveSettings / resetSkillsToDefaults). '
      + 'The worker only ever reads settings via getSettings(); nothing in its graph writes skills.',
  },
  {
    file: 'js/meeting-platforms.js',
    spec: './plugins.js',
    why: 'declareMeetingPlatforms(), called from the settings page to populate the Plugins '
      + 'list. The worker imports meetingMatches() only.',
  },
];
const allowed = new Set(ALLOWED.map((a) => `${a.file} -> ${a.spec}`));

const graph = staticGraph(entry);
assert.ok(graph.size > 10, `Expected to walk the worker's graph, found ${graph.size} modules.`);

const offenders = [];
for (const rel of [...graph].sort()) {
  let src;
  try { src = read(rel); } catch { continue; }
  src.split('\n').forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return; // the prose above talks about import()
    const m = /(?<![\w$.])import\s*\(\s*['"]([^'"]+)['"]/.exec(line);
    if (!m) return;
    const key = `${rel} -> ${m[1]}`;
    if (allowed.has(key)) return;
    offenders.push(`${rel}:${i + 1}  import('${m[1]}')`);
  });
}

assert.deepEqual(offenders, [],
  'Dynamic import() on the service worker\'s static graph — it throws at runtime and the '
  + 'feature silently never runs:\n  ' + offenders.join('\n  ')
  + '\n\nImport it statically, or have the caller pass the module in (see js/backup-payload.js). '
  + 'If the site is genuinely unreachable from the worker, add it to ALLOWED in this file with why.');

// The worker's own entry is held to the stricter rule: no exceptions, ever. Every dynamic
// import that has ever been written here was an alarm handler that did nothing.
assert.ok(!/(?<![\w$.])import\s*\(/.test(read(entry).split('\n')
  .filter((l) => !l.trimStart().startsWith('//')).join('\n')),
  `${entry} must not use dynamic import() at all — it is the service worker entry point.`);

// The three that were broken in the field. Named so a refactor that re-lazies one fails
// here with the history rather than in a user's unattended backup.
for (const [rel, needed] of Object.entries({
  'background.js': ['./js/jobs.js', './js/warm-sync.js', './js/backup-payload.js'],
  'js/auto-backup.js': ['./store.js'],
})) {
  const src = read(rel);
  for (const spec of needed) {
    assert.match(src, new RegExp(`from\\s*['"]${spec.replace(/[.\\/]/g, '\\$&')}['"]`),
      `${rel} should statically import ${spec} — a worker cannot load it any other way.`);
  }
}

console.log(`service worker import tests passed (${graph.size} modules on the worker graph, ${ALLOWED.length} allowed exceptions)`);
