// GENERATED — do not edit.
// Source of truth: chatpanel-events/index.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// @chatpanel/events — the ChatPanel event-log and capability contracts.
//
// Two contracts everything else inherits from:
//   • the EVENT SCHEMA — append-only, versioned forever, metadata only, ordered
//     without clocks;
//   • the CAPABILITY SIGNATURE — one call shape a rule, a schedule, the user or a
//     model all invoke identically.
//
// Pure and dependency-free so the identical code runs in the extension (browser ESM,
// MV3/CSP-safe), the gateway and the bridge — the @chatpanel/pii delivery pattern.

export {
  CURRENT_VERSION, EVENT_TYPES, ALL_TYPES,
  ACTOR_KINDS, SCOPE_KINDS, CLASSES, EFFECTS, EGRESS,
  EventError, validateEvent, isValidEvent, createAppender,
} from './event.js';

export { REF_KINDS, RESOLUTION, makeRef, isRef, resolveRef } from './ref.js';
export { linearize, compareEvents, causesAreWellFormed } from './order.js';
export { UPCASTERS, upcast, upcastAll } from './upcast.js';
export {
  DATA_SCOPES, validateCapability, validateInvocation, canSatisfy,
  toModelSchema, toModelSchemas,
} from './capability.js';
export { checkInvariants, INVARIANTS } from './invariants.js';
export { createMemoryAdapter, createLogStore, createBlobStore } from './store.js';
export { createRegistry, REGISTRY_STATES } from './registry.js';
export { defineSearchEngine, reconcileEngines, attemptOrder, ENGINE_KINDS, SearchEngineError } from './search-engines.js';
export { defineToolGroup, createToolGroupRegistry, ToolGroupError } from './tool-groups.js';
export { defineAdapter, createAdapterRegistry, AdapterError } from './adapters.js';
export { linkifyCitations, sourcesFromToolText } from './citations.js';
export { buildTrajectory, phasesOf, lanesOf, filterEntries, displayName, ENTRY_KINDS } from './trajectory.js';
export { createTurnRunner, defineLoop, LOOP_KINDS, LoopError } from './loop.js';
export { defineRule, createRuleEngine, SUPPRESSED, RuleError } from './rules.js';
export { defineMeetingAnalyzer, createAnalyzerRegistry, CADENCES, AnalyzerError } from './meeting-analyzers.js';
export { explainMcpError, packageFromArgs } from './mcp-errors.js';
export { createManifest, ManifestError, SOURCES } from './manifest.js';
export { createKernel, meetDecisions, KernelError, REQUIRED_PLUGINS, ALLOW_ALL } from './kernel.js';
export { replay, formatReport, parseJsonl, toJsonl } from './harness.js';
