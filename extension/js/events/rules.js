// GENERATED — do not edit.
// Source of truth: chatpanel-events/rules.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Class-R automation — value without a model.
//
// Everything ChatPanel does today needs a model, which means everything costs tokens,
// latency and a network. But a great deal of what users actually want is a RULE: when a
// meeting ends, save the notes; when a page matches, offer to act on it; when a note gains
// a heading, index it. Those are deterministic, instant, free, and provable — and until
// there is somewhere to declare them, each is hand-written into whichever file noticed the
// need first.
//
// A rule fires FROM THE EVENT LOG, which is what finally makes the log a bus rather than a
// record. That is the whole reason the log came first: a rule that had to be called
// explicitly by the code that might interest it is not automation, it is a function call
// with extra steps.
//
// THREE PROPERTIES THAT ARE NOT NEGOTIABLE, because automation is where a mistake is
// unattended:
//   • A rule may NARROW authority, never widen it. It runs with the scope it was granted
//     and cannot request more at fire time.
//   • A non-pure action carries an idempotency key, so a rule that fires twice on a redelivered
//     event does its thing once (I3).
//   • Every decision is recorded — fired AND suppressed — because an automation you cannot
//     see is one you cannot trust, and 'it did nothing' has many causes worth telling apart.

export class RuleError extends Error {
  constructor(code, message) { super(message); this.name = 'RuleError'; this.code = code; }
}

/** Why a rule did not fire. Each is a different problem, so each has a name. */
export const SUPPRESSED = Object.freeze({
  DISABLED: 'disabled',              // switched off in Plugins
  CONDITION: 'condition-false',      // the trigger matched, the condition did not
  DUPLICATE: 'already-fired',        // same event, same rule — redelivery, not a new cause
  RATE_LIMITED: 'rate-limited',      // fired too recently
  NO_PERMISSION: 'no-permission',    // the guard refused
  ERROR: 'error',                    // the rule itself threw
});

/**
 * @param on    event type, or array of them. Matching on TYPE first is what keeps a busy
 *              log cheap: a predicate is only run for events that could possibly match.
 * @param when  (event, ctx) => boolean. Pure and synchronous, deliberately — a condition
 *              that could do I/O would make "did this rule match" unanswerable without
 *              side effects, and untestable without mocks.
 * @param then  async (event, ctx) => result. The action. Receives `ctx.invoke`, so a rule
 *              cannot reach a capability except through the guarded path.
 * @param classUsed the execution class this rule actually uses — 'R' for a pure rule, 'M'
 *              for a small model, 'C' for a cloud one. Declared rather than inferred,
 *              because the honest answer to "did this cost anything" cannot be guessed.
 * @param everyMs minimum gap between fires. 0 means every matching event.
 */
export function defineRule({
  id, label, on, when = null, then, classUsed = 'R',
  everyMs = 0, requiresApproval = false, description = '', effects = 'idempotent',
}) {
  if (!id) throw new RuleError('BAD_RULE', 'rule.id required');
  if (typeof then !== 'function') throw new RuleError('BAD_RULE', `rule '${id}': then required`);
  const types = Array.isArray(on) ? on : [on];
  if (!types.length || types.some((t) => typeof t !== 'string' || !t)) {
    throw new RuleError('BAD_RULE', `rule '${id}': on must name at least one event type`);
  }
  if (when && typeof when !== 'function') throw new RuleError('BAD_RULE', `rule '${id}': when must be a function`);
  // A rule that changes the world without an idempotency story will eventually do it twice.
  if (effects === 'non-replayable' && !requiresApproval && classUsed === 'R') {
    // Not an error — some rules genuinely must act — but it has to be stated, so the
    // decision is visible in the declaration rather than discovered from behaviour.
  }
  return Object.freeze({
    id, label: label || id, on: types, when, then, classUsed,
    everyMs, requiresApproval, description, effects,
  });
}

export function createRuleEngine({ emit = () => {}, now = () => 0, admit = null, approve = null } = {}) {
  const rules = [];
  const lastFired = new Map();
  const seen = new Set();   // `${ruleId}:${eventId}` — redelivery is not a new cause

  return {
    add(rule) {
      rules.push(rule);
      return () => { const i = rules.indexOf(rule); if (i >= 0) rules.splice(i, 1); };
    },
    list: () => [...rules],

    /**
     * Offer one event to every rule. Returns what happened, so a caller can assert on it —
     * an engine whose only output is side effects cannot be tested without mocks.
     *
     * Never throws. A rule that fails must not take down the thing that emitted the event:
     * automation is a passenger, not a driver.
     */
    async dispatch(event, ctx = {}) {
      const out = [];
      for (const rule of rules) {
        if (!rule.on.includes(event?.type)) continue;

        const suppress = (reason, detail) => {
          emit('automation.suppressed', { ruleId: rule.id, reason, eventId: event.id, ...detail });
          out.push({ ruleId: rule.id, fired: false, reason });
        };

        if (admit && !admit(rule)) { suppress(SUPPRESSED.DISABLED); continue; }

        const key = `${rule.id}:${event.id}`;
        if (seen.has(key)) { suppress(SUPPRESSED.DUPLICATE); continue; }

        if (rule.everyMs > 0 && lastFired.has(rule.id)) {
          // `has`, not truthiness: a rule that fired at timestamp 0 HAS fired, and treating
          // that as "never" gives it one free pass through its own rate limit. Only a test
          // clock starts at 0, but a guard that is wrong for one value is wrong.
          if (now() - lastFired.get(rule.id) < rule.everyMs) { suppress(SUPPRESSED.RATE_LIMITED); continue; }
        }

        let matched = true;
        try { matched = rule.when ? !!rule.when(event, ctx) : true; } catch (e) {
          // A condition that throws is a condition that did not match. Firing on an
          // unanswered question is how automation does something nobody asked for.
          suppress(SUPPRESSED.ERROR, { message: e.message });
          continue;
        }
        if (!matched) { suppress(SUPPRESSED.CONDITION); continue; }

        if (rule.requiresApproval) {
          const ok = approve ? await approve(rule, event) : false;
          if (!ok) { suppress(SUPPRESSED.NO_PERMISSION); continue; }
        }

        seen.add(key);
        lastFired.set(rule.id, now());
        try {
          const result = await rule.then(event, ctx);
          emit('automation.fired', { ruleId: rule.id, classUsed: rule.classUsed, eventId: event.id });
          out.push({ ruleId: rule.id, fired: true, result });
        } catch (e) {
          emit('automation.suppressed', { ruleId: rule.id, reason: SUPPRESSED.ERROR, eventId: event.id, message: e.message });
          out.push({ ruleId: rule.id, fired: false, reason: SUPPRESSED.ERROR, error: e.message });
        }
      }
      return out;
    },
  };
}
