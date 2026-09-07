// A skill you just wrote must be schedulable without reopening the panel.
//
// The Jobs form is built ONCE — build() is memoized on `el` and returns early on every call
// after the first — and wireJobsPane() runs from the panel's idle callback at load. So the
// "What to do" dropdown was populated from whatever skills existed at panel open and never
// again: write a skill in Settings → Skills, come back, open Jobs, and it is not offered.
// The getter was already correct (`skills: () => enabledSkills(state.settings?.skills)`, read
// at call time, with a comment saying exactly that) — nothing ever called it a second time.
//
// Source-level, like the other jobs-pane wiring tests: the failure is a missing CALL, and a
// call that is not made is invisible to a unit test of the thing that should have been called.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const pane = read('js/jobs-panel.js');
const panel = read('sidepanel.js');

// ── the premise: the form really is built once ───────────────────────────────────
assert.match(
  pane, /function build\(\)\s*\{\s*\n?\s*if \(el\) return el;/,
  'build() is expected to be memoized — if it stopped being, this whole test is about a '
  + 'problem that no longer exists and should be re-derived rather than adjusted',
);

// ── the fix: opening the pane re-offers the current skills ───────────────────────
const openJobs = /export async function openJobs\(\)[\s\S]*?\n\}/.exec(pane)?.[0] || '';
assert.ok(openJobs, 'openJobs() not found');
assert.match(
  openJobs, /repaintForm\(\)/,
  'openJobs() must repaint the form — build() returns early, so nothing else will',
);

// The repaint has to be the SAME function that fills the dropdown, not a second painter
// that could drift from it.
assert.match(pane, /repaintForm = paint;/, 'repaintForm must be wireForm\'s own paint()');
assert.match(
  pane, /for \(const sk of skills\) what\.add\(new Option\(/,
  'paint() must be what populates the skill options',
);
assert.match(
  pane, /const skills = getSkills\(\);/,
  'paint() must read the skills through the getter, not a captured list',
);

// ── and a skill written while the pane is OPEN still lands ───────────────────────
assert.match(
  pane, /export function refreshJobsSkills\(\)/,
  'the panel needs a way to push a settings change into an already-open pane',
);
assert.ok(
  /export function refreshJobsSkills\(\)[\s\S]{0,200}?if \(el\) repaintForm\(\);/.test(pane),
  'refreshJobsSkills() must no-op before the pane has been built, not throw',
);

// The panel must actually call it, from the branch that already knows settings changed.
const onSettings = /if \(changes\['chatpanel:settings'\]\)[\s\S]*?maybeWarmSync\(\)/.exec(panel)?.[0] || '';
assert.ok(onSettings, "the panel's chatpanel:settings branch not found");
assert.match(
  onSettings, /jobsPane\?\.refreshJobsSkills\(\)/,
  'a settings change must re-offer skills in the Jobs pane',
);
// Optional-chained on purpose: the pane loads at idle and a settings change can beat it.
assert.match(panel, /let jobsPane = null;/, 'jobsPane must be declared, and start empty');
assert.match(
  panel, /\.then\(\(m\) => \{ jobsPane = m; return m; \}\)/,
  'the idle import must record the module so the settings branch can reach it',
);

console.log('jobs skill freshness: ok');
