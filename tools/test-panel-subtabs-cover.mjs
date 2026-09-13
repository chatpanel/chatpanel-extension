// A card without a sub-tab is a card nobody can reach.
//
// js/subtabs.js shows ONE target at a time and hides everything else under the bar, so a
// card added to a panel that has a bar — Recipes, then Teams, under Skills — rendered fine
// and was hidden on every selection. Two features shipped invisible, in two separate
// releases, and the report was "I don't see Teams". This walks every panel that declares a
// bar and requires each top-level card in it to be a tab's target, a tab's `requires`, or
// marked data-subtab-keep.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const js = read('settings.js');
const html = read('settings.html');

const table = /const PANEL_SUBTABS = \{[\s\S]*?\n\};/.exec(js)?.[0];
assert.ok(table, 'PANEL_SUBTABS not found');
const panels = [...table.matchAll(/\n  (\w+): \{ bar: '([^']+)', groups: \[([\s\S]*?)\n  \] \}/g)];
assert.ok(panels.length >= 5, `expected the panels with bars, got ${panels.length}`);

const problems = [];
for (const [, panel, bar, groups] of panels) {
  const covered = new Set([...groups.matchAll(/(?:target|requires): '([^']+)'/g)].map((m) => m[1]));
  const start = html.indexOf(`data-panel="${panel}"`);
  assert.ok(start >= 0, `panel ${panel} not in the markup`);
  const end = html.indexOf('<section class="panel', start + 1);
  const body = html.slice(start, end < 0 ? undefined : end);
  assert.ok(body.includes(`id="${bar}"`), `${panel}: bar #${bar} not in its panel`);
  // Walk the panel's tags with a stack: a card is unreachable when none of its ancestors
  // (inside the panel) is a tab's target or `requires`, and it is not itself one, nor kept.
  const stack = [];
  const VOID = /^(br|hr|img|input|meta|link)$/i;
  for (const m of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    const [, close, tag, attrs] = m;
    if (VOID.test(tag) || /\/\s*$/.test(attrs)) continue;
    if (close) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } continue; }
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    const reachable = (id && covered.has(id)) || /data-subtab-keep/.test(attrs) || stack.some((e) => e.reachable);
    if (/class="card[\s"]/.test(attrs) && !reachable) problems.push(`${panel}: ${id ? `#${id}` : 'a card with no id'} is not under any sub-tab's target — it is hidden on every selection`);
    stack.push({ tag, reachable });
  }
}
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`panel sub-tabs: every card under a bar is reachable (${panels.length} panels)`);
