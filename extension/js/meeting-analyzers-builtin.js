// The analyzers a meeting runs, declared against the shared contract.
//
// These behaviours already existed — a running summary on a timer, insight sections at the
// end, live monitors watching for an answer — each with its own prompt shape, cadence and
// storage, written separately. Declaring them puts the three things a user and the runtime
// both need in one place: what it produces, when it wants to run, and whether it is on.
//
// The prompts stay where they are. This is a declaration of WHEN and WHAT, not a rewrite of
// HOW — the same strangler approach the canvas adapters got, for the same reason: the
// existing code works.

import { defineMeetingAnalyzer, createAnalyzerRegistry } from './events/meeting-analyzers.js';
import { declarePlugins, pluginManifest } from './plugins.js';

// A running summary is the one thing every other analyzer reads, so it goes first and often.
export const summaryAnalyzer = defineMeetingAnalyzer({
  id: 'meeting:summary',
  label: 'Running summary',
  description: 'Keeps a short summary of the meeting up to date while it runs.',
  produces: 'summary',
  cadence: 'periodic',
  everyMs: 90_000,
  // Below this there is not enough said to summarise, and the result is a paragraph
  // apologising for the empty transcript.
  minTranscriptChars: 400,
  run: async ({ ask, transcript, summary }) => ask({ kind: 'summary', transcript, previous: summary }),
});

// Decisions, action items and risks — expensive and only meaningful once, so at the end.
export const insightsAnalyzer = defineMeetingAnalyzer({
  id: 'meeting:insights',
  label: 'Decisions and action items',
  description: 'Extracts decisions, action items and risks when the meeting ends.',
  produces: 'sections',
  cadence: 'on-end',
  minTranscriptChars: 400,
  run: async ({ ask, transcript }) => ask({ kind: 'insights', transcript }),
});

// A standing question the user asked to be watched. Periodic because the answer can arrive
// at any point, and cheap enough to check often.
export const monitorAnalyzer = defineMeetingAnalyzer({
  id: 'meeting:monitors',
  label: 'Live monitors',
  description: 'Watches for answers to questions you asked ChatPanel to keep an eye on.',
  produces: 'answer',
  cadence: 'periodic',
  everyMs: 45_000,
  minTranscriptChars: 200,
  run: async ({ ask, transcript, summary, previous }) => ask({ kind: 'monitor', transcript, summary, monitor: previous }),
});

export const MEETING_ANALYZERS = [summaryAnalyzer, insightsAnalyzer, monitorAnalyzer];

let registry = null;

export async function analyzerRegistry() {
  if (registry) return registry;
  registry = createAnalyzerRegistry();
  for (const a of MEETING_ANALYZERS) registry.add(a);
  await declarePlugins(MEETING_ANALYZERS.map((a) => ({
    id: a.id, kind: 'meeting-analysis', label: a.label, description: a.description,
  })));
  return registry;
}

/**
 * Which analyzers should run now. `admit` comes from the manifest, so switching one off in
 * Plugins stops it being due rather than discarding its result afterwards — a summary the
 * user turned off should not cost a model call.
 */
export async function dueAnalyzers(opts) {
  const [reg, manifest] = await Promise.all([analyzerRegistry(), pluginManifest()]);
  return reg.due({ ...opts, admit: (a) => manifest.isEnabled(a.id) });
}
