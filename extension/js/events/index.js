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
  validateCapability, validateInvocation, canSatisfy,
  toModelSchema, toModelSchemas,
} from './capability.js';
export { checkInvariants, INVARIANTS } from './invariants.js';
export { createMemoryAdapter, createLogStore, createBlobStore } from './store.js';
export { createRegistry, REGISTRY_STATES } from './registry.js';
export { defineSearchEngine, reconcileEngines, attemptOrder, ENGINE_KINDS, SearchEngineError } from './search-engines.js';
export { defineToolGroup, createToolGroupRegistry, ToolGroupError } from './tool-groups.js';
export { toolNeedFor } from './tool-need.js';
export { parseFlowchart, layoutFlowchart, renderFlowchartSvg } from './flowchart.js';
export { validateView, validateViewInvocation, viewResult } from './view.js';
export { validateWidget, validateWidgetMessage, effectiveGrants, widgetIcon, WIDGET_SURFACES } from './widget.js';
export { fuseRRF, planQueries, multiSearch } from './rrf.js';
export {
  ACCESS_LOG_VERSION, ACCESS_LOG_MAX, redactAccessArgs, makeAccessEvent,
  createAccessLog, makeStorageTier, formatBytes,
} from './observability.js';
export { routeGraph, projectChain } from './route-graph.js';
export { defineAdapter, createAdapterRegistry, AdapterError } from './adapters.js';
export { linkifyCitations, sourcesFromToolText } from './citations.js';
export { buildTrajectory, phasesOf, lanesOf, filterEntries, displayName, ENTRY_KINDS, threadsOf, threadTitle, promptEntries, turnsOf, threadTree } from './trajectory.js';
export { createTurnRunner, defineLoop, LOOP_KINDS, LoopError } from './loop.js';
export { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, requirementsFor, requirementsForStep, preferenceFor, failoverOrder, pinnedOrderOf, FAILOVER_CLASS_GAP, FAILOVER_CAPABILITY_GAP, sameModelKey, REACH, RouterError } from './router.js';
export { makeSourceStore, manifestText, shortUrl, readSource, sourceId } from './sources-retrieval.js';
export { classifySource, extractUrls, hostMatches, meetReach, sourcePolicyFor, DEFAULT_INTERNAL_PATTERNS, INTERNAL_PATTERN_CATALOG } from './sources.js';
export { defineRule, createRuleEngine, SUPPRESSED, RuleError } from './rules.js';
export {
  VAULT_VERSION, KDF_ITERATIONS, KDF_HASH, DEFAULT_LOCK_MS, VaultError,
  MAX_TITLE_CHARS, MAX_NOTE_CHARS, MAX_SECRET_CHARS, MAX_ENTRIES,
  createVault, unlockVault, deriveKey, sealEntry, openEntry,
  validateEntry, entryMeta, searchEntries, isLocked, lockedSummary, canAddEntry,
  toB64, fromB64,
} from './vault.js';
export {
  SCHEDULE_KINDS, TRIGGER_KINDS, JOB_ACTIONS, MISSED_POLICIES, ScheduleError,
  validateSchedule, nextFireAt, occurrencesBetween, nextWakeAt,
  defineTrigger, createTriggerRegistry, BUILTIN_TRIGGERS,
  timerTrigger, meetingStartedTrigger, meetingEndedTrigger, personJoinedTrigger,
  phraseTrigger, topicTrigger, questionTrigger, voiceCommandTrigger,
  defineJob, dueJobs, jobsForEvent, occurrenceKey,
} from './schedule.js';
export { defineMeetingAnalyzer, createAnalyzerRegistry, CADENCES, AnalyzerError } from './meeting-analyzers.js';
export {
  DEFAULT_WAKE, MAX_COMMANDS_PER_DELTA, DAYPART_HOUR, VoiceIntentError,
  compileWake, findWakeCommand, parseCommand, commandsFromSegments,
  parseDuration, parseClock, parseWhen, parseNumberWords, normalizeSpeech, tokenize, editDistance,
  defineVoiceIntent, createVoiceIntentRegistry, defaultVoiceIntents, BUILTIN_VOICE_INTENTS,
  timerIntent, reminderIntent, scheduleIntent, noteIntent, monitorIntent,
} from './voice-intents.js';
export { explainMcpError, packageFromArgs } from './mcp-errors.js';
export { createManifest, ManifestError, SOURCES } from './manifest.js';
export { createKernel, meetDecisions, KernelError, REQUIRED_PLUGINS, ALLOW_ALL } from './kernel.js';
export { replay, formatReport, parseJsonl, toJsonl } from './harness.js';
export { compileQuery, findMatches, matchIndexFor, expandReplacement, replaceMatch, replaceAll, replaceAllInRange, MAX_MATCHES } from './text-search.js';
export { DATA_SCOPES } from './scopes.js';
export {
  MEMORY_VERSION, MEMORY_KINDS, MEMORY_KIND_NAMES, AMBIENT_KINDS, MAX_MEMORY_CHARS, MIN_MEMORY_CHARS,
  DEFAULT_MAX_MEMORIES, DEFAULT_BLOCK_CHARS, SAME_FACT, MEMORY_TOOL_SPEC, MEMORY_UPCASTERS, MemoryError,
  normalizeMemory, isValidMemory, memoryKey, slotOf, similarity, containment, candidatesFrom, reconcile, matchForForget,
  recall, memoryBlock, markUsed, pruneMemories, memoryToolSystem, upcastMemory,
} from './memory.js';
export { SOURCE_TRUST, SkillSourceError, defineSkillSource, createSkillSourceRegistry } from './skill-sources.js';
export { SKILL_MANIFEST_VERSION, SKILL_CONTEXTS, SKILL_HISTORY_SCOPES, SKILL_MCP_MODES, SKILL_TRUST, SKILL_FILE_KINDS, SKILL_UPCASTERS, SkillManifestError, isSafeSkillPath, originOf, trustOf, skillFiles, needsBridge, declaredAccess, originLabel, sameSkillOrigin, skillIsStale, validateSkill, upcastSkill, upcastSkills, normalizeSkill } from './skill-manifest.js';
export { SKILL_VARS, SKILL_VAR_NAMES, skillVar, skillVarPattern, parseSkillVars, lintSkillPrompt, suggestSkillVar, substituteSkillVars, skillVarGuidance, SkillVarError } from './skill-vars.js';
export { outlineOf, parseListItem, continueList, indentSelection, toggleWrap, toggleLinePrefix, toggleTask, toggleLink, docStats, selectionStats } from './markdown-authoring.js';
