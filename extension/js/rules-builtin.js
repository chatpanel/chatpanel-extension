// The rules that ship, and the wiring that lets the log drive them.
//
// This is the first thing in ChatPanel that acts WITHOUT a model: no tokens, no latency, no
// network, and an outcome you can predict by reading the rule. That is the point of class R
// — a great deal of what people want from "automation" is a conditional, and paying a
// language model to evaluate one is slow, expensive and less reliable than the conditional.
//
// Rules fire from the event log, which is what turns the log from a record into a bus. A
// rule that had to be called by the code that might interest it would be a function call
// with extra steps.
//
// SAFETY POSTURE. These built-ins are read-only or storage-local by design: they notice
// things and record them. Nothing here sends, clicks, or spends. Rules that act on the
// world are exactly the ones that must be user-authored and approved (A2/A3), and that
// path does not exist yet — so this ships the engine and the harmless rules, not a way to
// automate away someone's afternoon by accident.

import { defineRule, createRuleEngine } from './events/rules.js';
import { declarePlugins, pluginManifest } from './plugins.js';

/**
 * A turn that repeated the same failing call is nearly always ChatPanel's problem, not the
 * model's — the loop guard already knows this at tool level, but nothing ever said it where
 * a user would see it. Free, instant, and correct by construction.
 */
export const repeatedFailureRule = defineRule({
  id: 'rule:repeated-failure',
  label: 'Flag repeated identical failures',
  description: 'Notices when a turn made the same failing call several times, and says so.',
  on: 'turn.ended',
  classUsed: 'R',
  when: (event, ctx) => (ctx?.repeats?.length || 0) > 0,
  then: async (event, ctx) => ({ note: `${ctx.repeats[0].name} failed ${ctx.repeats[0].count}× with the same input` }),
});

/**
 * Setup dominating a turn is a fixable problem with a specific cause, and the number is
 * already recorded — it just needed something watching for it.
 */
export const slowSetupRule = defineRule({
  id: 'rule:slow-setup',
  label: 'Flag slow turn setup',
  description: 'Notices when connecting to tools took longer than the model did.',
  on: 'turn.ended',
  classUsed: 'R',
  // Rate-limited because a broken MCP server makes EVERY turn slow, and a warning on all
  // of them is noise that trains the user to ignore it.
  everyMs: 5 * 60_000,
  when: (event) => {
    const p = event?.payload || {};
    return Number(p.prepMs) > 3000 && Number(p.prepMs) > Number(p.ms || 0) / 2;
  },
  then: async (event) => ({ note: `Setup took ${(event.payload.prepMs / 1000).toFixed(1)}s — a tool or MCP server is slow to connect` }),
});

export const BUILTIN_RULES = [repeatedFailureRule, slowSetupRule];

let engine = null;

export async function ruleEngine() {
  if (engine) return engine;
  const manifest = await pluginManifest();
  engine = createRuleEngine({
    now: () => Date.now(),
    // Rules are plugins: switchable, listed, and off means off.
    admit: (rule) => manifest.isEnabled(rule.id),
    // No approver is wired yet, so an approval-requiring rule cannot fire. That is the
    // correct failure: a missing approver means nobody can consent, not that consent is
    // implied. User-authored rules land with the approval path, not before it.
    approve: null,
    // A rule's own decisions are events like any other. Fire-and-forget so automation can
    // never fail the thing it is observing.
    emit: (type, payload) => {
      import('./event-log.js').then((m) => m.emitAsync(type, payload)).catch(() => {});
    },
  });
  for (const r of BUILTIN_RULES) engine.add(r);
  await declarePlugins(BUILTIN_RULES.map((r) => ({
    id: r.id, kind: 'rule', label: r.label, description: r.description,
  })));
  return engine;
}

/** Offer an event to the rules. Never throws — automation is a passenger, not a driver. */
export async function dispatchToRules(event, ctx = {}) {
  try {
    return await (await ruleEngine()).dispatch(event, ctx);
  } catch {
    return [];
  }
}
