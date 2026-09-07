// A live monitor's requirement is the OPPOSITE of a chat turn's: speed first, quality second.
//
// A monitor is a standing question re-answered every time the transcript grows, read at a
// glance beside a call that is still happening. An answer that is right but arrives after the
// moment has passed is a wrong answer.
//
// What it did instead: took the SAME toolset as a full chat turn — web search, the history
// RAG, every connected MCP server, the note and memory writers — plus fifteen minutes of
// transcript, the running summary and every prior finding, and sent all of it to whichever
// model the conversation happened to be pointed at. Every unused tool is still a block of
// schema in the prompt, and a large model chosen for a coding chat is not what should answer
// "did anyone mention pricing?" mid-sentence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  monitorProfile, monitorWindowMs, monitorNeedsTools, filterMonitorTools,
  recentFindings, describeMonitorProfile, DEFAULT_MONITOR_PROFILE, MONITOR_SOURCES,
} = await import('../extension/js/monitor-profile.js');

// ── the default is LEAN, and that is the point ───────────────────────────────────
{
  const p = monitorProfile({});
  assert.equal(p.sources.transcript, true);
  assert.equal(p.sources.summary, true);
  assert.equal(p.sources.web, false, 'web search costs a tool call before it can answer');
  assert.equal(p.sources.history, false);
  assert.equal(p.sources.mcp, false, 'every MCP server is described in the prompt whether used or not');
  assert.equal(
    monitorNeedsTools(p), false,
    'the default must build NO toolset — assembling one costs the MCP handshakes and every '
    + 'schema, which is the single biggest thing between the question and its answer',
  );
  assert.equal(p.windowMin, 5, 'was 15 minutes, which is three times the prompt');
  assert.equal(monitorWindowMs(p), 5 * 60_000);
}

// ── partial config resolves key by key ───────────────────────────────────────────
{
  // Set only a model → keep the lean sources.
  const p = monitorProfile({ ui: { monitors: { targetId: 'fast-model' } } });
  assert.equal(p.targetId, 'fast-model');
  assert.equal(p.sources.web, false);
  // Set only sources → keep the conversation's model.
  const q = monitorProfile({ ui: { monitors: { sources: { web: true } } } });
  assert.equal(q.targetId, '', '"" means: same model as the conversation');
  assert.equal(q.sources.web, true);
  assert.equal(q.sources.summary, true, 'an unmentioned source keeps its default');
  assert.equal(monitorNeedsTools(q), true);
}

// The transcript is what a monitor IS — a question with nothing to answer against is not a
// faster monitor, it is a broken one.
assert.equal(monitorProfile({ ui: { monitors: { sources: { transcript: false } } } }).sources.transcript, true);

// Nonsense values clamp rather than propagate into a prompt size.
for (const [given, expect] of [[0, 1], [-5, 1], [999, 60], ['abc', 5], [null, 5]]) {
  assert.equal(monitorProfile({ ui: { monitors: { windowMin: given } } }).windowMin, expect, `windowMin ${given}`);
}
assert.equal(monitorProfile(undefined).windowMin, DEFAULT_MONITOR_PROFILE.windowMin, 'must not throw on absent settings');

// ── tools are filtered by NAME, and default-deny ─────────────────────────────────
{
  const toolset = {
    specs: [
      { name: 'web_search' }, { name: 'history_search' }, { name: 'mcp_github_issues' },
      { name: 'meeting_live_transcript' }, { name: 'note_write' }, { name: 'page_click' },
      { name: 'memory_remember' },
    ],
    execute: () => {},
  };
  const lean = filterMonitorTools(toolset, monitorProfile({}));
  assert.deepEqual(
    lean.specs.map((s) => s.name), ['meeting_live_transcript'],
    'a lean profile keeps only the transcript reader — note/page/memory writers have no place '
    + 'in a background question, and were never asked for',
  );
  const withWeb = filterMonitorTools(toolset, monitorProfile({ ui: { monitors: { sources: { web: true } } } }));
  assert.deepEqual(withWeb.specs.map((s) => s.name).sort(), ['meeting_live_transcript', 'web_search']);
  const all = filterMonitorTools(toolset, monitorProfile({ ui: { monitors: { sources: { web: true, history: true, mcp: true } } } }));
  assert.ok(all.specs.some((s) => s.name === 'mcp_github_issues'));
  // Default-DENY: a provider that starts emitting a new tool cannot quietly widen a monitor.
  const surprise = filterMonitorTools({ specs: [{ name: 'brand_new_tool' }] }, monitorProfile({}));
  assert.deepEqual(surprise.specs, [], 'an unknown tool is not a tool a monitor may use');
  // The execute/route map survives — only what is ADVERTISED is trimmed.
  assert.equal(typeof lean.execute, 'function');
  assert.equal(filterMonitorTools(null, monitorProfile({})), null, 'no toolset, no crash');
}

// ── prior findings are budgeted ──────────────────────────────────────────────────
{
  const findings = Array.from({ length: 30 }, (_, i) => ({ text: `f${i}` }));
  const p = monitorProfile({});
  const kept = recentFindings(findings, p);
  assert.equal(kept.length, DEFAULT_MONITOR_PROFILE.maxFindings, 'an hour-old monitor must not replay everything');
  assert.equal(kept.at(-1).text, 'f29', 'and it must be the NEWEST that survive');
  assert.deepEqual(
    recentFindings(findings, monitorProfile({ ui: { monitors: { sources: { findings: false } } } })), [],
    'switching the source off means none',
  );
  assert.deepEqual(recentFindings(undefined, p), []);
}

// ── the settings screen must name the TRADE, not the abstraction ─────────────────
{
  assert.match(describeMonitorProfile(monitorProfile({})), /no tools, fastest/);
  assert.match(describeMonitorProfile(monitorProfile({ ui: { monitors: { sources: { mcp: true } } } })), /with tools, slower/);
  assert.match(describeMonitorProfile(monitorProfile({})), /last 5 min of transcript/);
  // Every source the profile knows about must be offered a label, or the UI silently omits one.
  for (const k of Object.keys(DEFAULT_MONITOR_PROFILE.sources)) {
    assert.ok(MONITOR_SOURCES[k], `${k} has no human label`);
  }
}

// ── and the turn must actually use all of it ─────────────────────────────────────
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const run = /async function runMonitor\([\s\S]*?\n\}/.exec(panel)?.[0] || '';
assert.ok(run, 'runMonitor not found');
assert.match(run, /monitorWindowMs\(profile\)/, 'the window must come from the profile');
assert.doesNotMatch(run, /15 \* 60_000/, 'the hardcoded 15-minute window must be gone');
assert.match(run, /profile\.sources\.summary \? await getLiveNotesText/, 'the summary is a source, not a given');
assert.match(
  run, /monitorNeedsTools\(profile\)\s*\n?\s*\? monitorProfileMod\.filterMonitorTools/,
  'the toolset must not be BUILT when the profile needs none — building it to discard it '
  + 'still pays for every MCP handshake',
);
assert.match(run, /profile\.targetId && findTarget/, 'a monitor may have its own, faster model');
// The prompt must not promise tools it does not have.
assert.match(panel, /function monitorPrompt\(m, summary, transcript, prior = '', \{ hasTools = false \} = \{\}\)/);
assert.match(panel, /hasTools \? ' You MAY use available tools/, 'told to use tools only when it has some');

// Settings must expose all of it, and say what it costs.
const html = readFileSync(new URL('../extension/settings.html', import.meta.url), 'utf8');
for (const id of ['pref-monitor-model', 'pref-monitor-window', 'pref-monitor-summary',
  'pref-monitor-findings', 'pref-monitor-web', 'pref-monitor-history', 'pref-monitor-mcp', 'pref-monitor-cost']) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
}
const st = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
assert.match(st, /settings\.ui\.monitors = \{/, 'the profile must save');
assert.match(st, /Each monitor answer reads: \$\{describeMonitorProfile\(p\)\}/, 'and say what it costs');
assert.match(st, /no longer configured/, 'a deleted model must not read as "same as the conversation"');

console.log('monitor profile: ok');
