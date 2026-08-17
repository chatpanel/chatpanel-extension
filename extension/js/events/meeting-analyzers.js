// GENERATED — do not edit.
// Source of truth: chatpanel-events/meeting-analyzers.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// What a meeting produces, as declarations.
//
// A meeting already generates several kinds of derived thing: a running summary, insight
// sections (decisions, action items, risks), and live monitors that watch for an answer to
// a standing question. Each is written separately — its own prompt shape, its own cadence,
// its own storage — so adding a fifth means touching several files and nothing outside the
// extension can offer one.
//
// They are the same shape underneath: run over the transcript so far, on some trigger,
// producing a typed result that is stored and shown. Declaring that shape gives three
// things at once — a Plugins entry the user can switch off, a cadence the runtime can honour
// without each analyzer implementing its own timer, and a contract the gateway could later
// run server-side without rewriting callers.
//
// WHAT THIS IS NOT: a scheduler. Declaring "every 90 seconds" does not start a timer here;
// the host decides when to run and this says what running means. Putting the clock in the
// contract would make it untestable and unrunnable off a browser.

export class AnalyzerError extends Error {
  constructor(code, message) { super(message); this.name = 'AnalyzerError'; this.code = code; }
}

/** When an analyzer wants to run. The host maps these to its own timers and events. */
export const CADENCES = Object.freeze([
  'periodic',   // every `everyMs` while the meeting is live
  'on-demand',  // only when the user asks
  'on-end',     // once, when the meeting finishes
]);

/**
 * @param produces what the result IS — 'summary' | 'sections' | 'answer' | 'text'. The host
 *        uses it to decide where the output goes, so an analyzer never has to know about
 *        storage.
 * @param run   async ({ transcript, summary, previous, meeting, ask }) => result. `ask` is
 *        the model call, injected: an analyzer that imported one could not run in the
 *        gateway, and could not be tested without a network.
 */
export function defineMeetingAnalyzer({
  id, label, produces = 'text', cadence = 'on-demand', everyMs = 0,
  minTranscriptChars = 0, description = '', run,
}) {
  if (!id) throw new AnalyzerError('BAD_ANALYZER', 'analyzer.id required');
  if (typeof run !== 'function') throw new AnalyzerError('BAD_ANALYZER', `analyzer '${id}': run required`);
  if (!CADENCES.includes(cadence)) throw new AnalyzerError('BAD_ANALYZER', `analyzer '${id}': unknown cadence '${cadence}'`);
  if (cadence === 'periodic' && !(everyMs > 0)) {
    // A periodic analyzer with no interval would either never run or run every tick, and
    // both look like a bug in the analyzer rather than in its declaration.
    throw new AnalyzerError('BAD_ANALYZER', `analyzer '${id}': periodic cadence needs everyMs`);
  }
  return Object.freeze({ id, label: label || id, produces, cadence, everyMs, minTranscriptChars, description, run });
}

export function createAnalyzerRegistry() {
  const analyzers = [];
  return {
    add(a) {
      analyzers.push(a);
      return () => { const i = analyzers.indexOf(a); if (i >= 0) analyzers.splice(i, 1); };
    },
    list: () => [...analyzers],
    get: (id) => analyzers.find((a) => a.id === id) || null,

    /**
     * Which analyzers are due right now.
     *
     * `lastRunAt` is passed in rather than held here: the registry is a declaration, and a
     * registry that remembered when things ran would be a second place for that truth to
     * live — beside the meeting record that already has to store it.
     */
    due({ now, cadence = 'periodic', lastRunAt = {}, transcriptChars = 0, admit = null } = {}) {
      return analyzers.filter((a) => {
        if (a.cadence !== cadence) return false;
        if (admit && !admit(a)) return false;
        // Below the threshold there is nothing worth spending a model call on — an empty
        // transcript summarised is a paragraph of apology.
        if (transcriptChars < a.minTranscriptChars) return false;
        if (a.cadence !== 'periodic') return true;
        const last = lastRunAt[a.id] || 0;
        return !last || (now - last) >= a.everyMs;
      });
    },
  };
}
