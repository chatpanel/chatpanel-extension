// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-loop-guard.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The loop guard — what stops a model that keeps asking the same thing.
//
// Lived inside the extension's providers.js for a year, which meant the desktop could not
// use it and wrote a smaller one (a `seen` map and a repeat count) that answered the same
// model behaviour differently: the extension blocked a repeated write BEFORE running it,
// the desktop ran it once and replayed it; the extension noticed a whole round repeating,
// the desktop only a single call. Same tools, same model, two outcomes. Now one guard,
// with everything either client had learned:
//
//   • a call repeated past `maxIdenticalCalls` is not executed — a READ is answered from
//     its first result (a pure read asked twice has one answer, and refusing it is how a
//     small model concludes the tool is broken and invents an answer); a WRITE is refused
//     with a result that says why, because replaying a click would be a lie about
//     something that changed the world;
//   • observation tools never count — read → act → read again with the same empty input
//     is correct, not a loop;
//   • a discrete-input tool that SUCCEEDED (a keystroke, a click) is progress and clears
//     its own count — pressing Enter twice is normal; failing to press it twice is not;
//   • a ROUND that repeats the previous round byte for byte, or in which every call was
//     blocked, counts toward `stalled` — and a stalled turn is offered no more tools, so
//     the model has to answer with what it has;
//   • `repeats` counts every replay and refusal across the turn, so a loop can tell when
//     the model has been told enough times (the desktop's rule: three, then a closing
//     request with no tools).
//
// Class R: no I/O, no clock. Names are read through `effectiveToolName` so a dispatched
// action is judged on what it is, not on the dispatcher's name.

import { effectiveToolName } from './tool-traits.js';
import { resultText } from './adaptive-tool-policy.js';

export const DEFAULT_MAX_IDENTICAL_CALLS = 3;
export const DEFAULT_MAX_STALLED_ROUNDS = 2;
export const DEFAULT_MAX_REPEATS = 3;

// Observation/read tools are MEANT to be repeated with the SAME (empty) input.
export const OBSERVATION_TOOLS = new Set(['inspect_page', 'read_canvas', 'screenshot', 'marked_screenshot']);

// Tools whose whole job is ONE discrete physical input. A SUCCESSFUL application counts as
// progress and clears the repeat count; a failing one (unknown key, nothing at point) does
// not, so a genuinely stuck call still trips the guard.
export const INPUT_PROGRESS_TOOLS = new Set([
  'press_key', 'type_text', 'click_at', 'move_mouse', 'click_mark', 'draw_path', 'input_sequence',
  'click_element', 'click_by_text',
]);

/** A tool whose repetition signals a LOOP (search/query/fetch), not one meant to repeat. */
export function isLoopableTool(name) {
  return !OBSERVATION_TOOLS.has(name) && !INPUT_PROGRESS_TOOLS.has(name) && name !== 'scroll';
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** The identity of a call: its name and its arguments with keys in a stable order. */
export function stableToolCallKey(name, input) {
  return `${String(name || '')}\n${stableStringify(input ?? {})}`;
}

/** The identity of a ROUND: its loopable calls, sorted — so a re-read or a scroll never makes two rounds look alike. */
export function roundSignature(calls) {
  return (Array.isArray(calls) ? calls : [])
    .filter((c) => isLoopableTool(effectiveToolName(c?.name, c?.input)))
    .map((c) => stableToolCallKey(c.name, c.input))
    .sort()
    .join('|');
}

/** The result a refused repeat receives — machine-readable, with the way out spelled out. */
export function blockedToolResult(name, message, extra = {}) {
  return JSON.stringify({
    ok: false,
    blocked: true,
    error: 'tool_loop_blocked',
    tool: name || 'tool',
    message,
    retry_hint: 'Answer using the already available conversation context and tool results. Do not call more tools unless the user asks you to continue.',
    ...extra,
  });
}

/**
 * Did a repeatable tool actually do something? For `scroll`, "more page below"; for a
 * discrete input, `ok: true`. Anything else is not progress — the step cap is the backstop.
 */
export function toolMadeProgress(name, result, input = null) {
  // Through the dispatcher too: `page {action:'scroll'}` is a scroll. Judged by the bare
  // name, four scrolls through `page` looked like a stuck loop and were blocked.
  const eff = effectiveToolName(name, input);
  if (eff === 'scroll') {
    try { return JSON.parse(resultText(result))?.atBottom === false; } catch { return false; }
  }
  if (INPUT_PROGRESS_TOOLS.has(eff)) {
    try { return JSON.parse(resultText(result))?.ok === true; } catch { return false; }
  }
  return false;
}

/**
 * @param maxIdenticalCalls  how many times the SAME call runs before it is replayed or refused
 * @param maxStalledRounds   how many no-progress rounds in a row before `stalled`
 * @param maxRepeats         how many replays/refusals in a turn before `looping`
 */
export function createToolLoopGuard({
  maxIdenticalCalls = DEFAULT_MAX_IDENTICAL_CALLS,
  maxStalledRounds = DEFAULT_MAX_STALLED_ROUNDS,
  maxRepeats = DEFAULT_MAX_REPEATS,
} = {}) {
  const counts = new Map();
  const lastResult = new Map(); // key → what that identical call returned the first time
  let stalledRounds = 0;
  let lastSignature = null;
  let repeats = 0;

  return {
    // No nuclear per-turn kill switch — one looping tool must not disable the rest. The
    // round cap is the overall backstop.
    get disabled() { return false; },
    get stalled() { return stalledRounds >= maxStalledRounds; },
    /** Replays and refusals so far this turn. */
    get repeats() { return repeats; },
    /** The model has been answered "you already asked that" enough times to stop asking. */
    get looping() { return repeats >= maxRepeats; },

    /**
     * After each round, note progress. No progress = every call was blocked, OR the round's
     * loopable call-set is byte-identical to the previous round's (a loop even before the
     * per-tool threshold trips). An exact-repeat round is definitive — two strikes at once.
     */
    noteRound(blockedCount, total, signature = '') {
      const allBlocked = total > 0 && blockedCount >= total;
      const repeatRound = !!signature && signature === lastSignature;
      lastSignature = signature;
      if (repeatRound) stalledRounds += 2;
      else if (allBlocked) stalledRounds += 1;
      else stalledRounds = 0;
    },

    /** Clear a call's repeat count when it actually made progress. */
    reset(key) { if (key) counts.delete(key); },

    /** Remember what a READ returned, so a repeat can be answered instead of refused. */
    remember(key, name, input, result, { readOnly = false } = {}) {
      if (!key || !result || !readOnly) return;
      lastResult.set(key, result);
    },

    /**
     * Should this call run? `{ blocked, replayed, count, key, result }` — `result` is what to
     * answer with when it should not.
     */
    check(name, input) {
      if (OBSERVATION_TOOLS.has(effectiveToolName(name, input))) return { blocked: false };
      const key = stableToolCallKey(name, input);
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count > maxIdenticalCalls && lastResult.has(key)) {
        // Serve the answer it already earned — and say so, because a model that repeats
        // itself is usually waiting for a value that will not change. Still counted, so a
        // genuinely stuck loop stays visible in the log.
        repeats += 1;
        const prior = lastResult.get(key);
        const note = '[This exact call was already made this turn; the result is unchanged. Answer from what you have.]';
        const result = typeof prior === 'string' ? `${prior}\n\n${note}` : (prior && typeof prior === 'object' && typeof prior.text === 'string' ? { ...prior, text: `${prior.text}\n\n${note}` } : prior);
        return { blocked: false, replayed: true, count, key, result };
      }
      if (count > maxIdenticalCalls) {
        repeats += 1;
        return {
          blocked: true, count, key,
          result: blockedToolResult(
            name,
            `Skipped a repeated identical ${name || 'tool'} call (${count}× with the same input). Vary the input or try a different action — your other tools still work.`,
            { repeated: true, identicalCallCount: count, maxIdenticalCalls },
          ),
        };
      }
      return { blocked: false, count, key };
    },
  };
}
