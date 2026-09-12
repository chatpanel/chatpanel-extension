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
export { pendingQueue, isQueued, dequeue, moveQueued, promoteQueued } from './queue.js';
export {
  groupModels, filterSections, defaultModelId, modelSummary,
} from './model-picker.js';
export {
  NOTE_ACTIONS, NOTE_ACTION_ORDER, NOTE_ACTION_TEMPERATURE, NOTE_ACTION_ERRORS,
  NOTE_COMMANDS, NOTE_COMMAND_TEMPERATURE, NOTE_COMMAND_MAX_TOKENS,
  frameNoteAction, noteActionLabel, noteActionItems, filterNoteActions,
  commandLineAt, triggerQueryAt,
} from './note-actions.js';
export {
  parseAgentMention, agentMentionAt, parseSkillMention, mergeSkillPrompt,
  findSkillByName, findTargetByName, mentionAnswerPrefix,
} from './note-mentions.js';
export { wikiQueryAt, rankLinkTargets } from './note-links.js';
export {
  SWARM_ROLES, roleById, classifyModel, supportsSubagents, appoint, routeTeam,
} from './cowriter-router.js';
export {
  SEARCH_ENGINES, RESULTS_PER_ENGINE, buildSearchUrl, unwrapRedirect, isResultHost,
  pickResults, mergeEngineResults, engineOrder,
} from './web-search.js';
export {
  MAX_GRAPH_NODES, buildNoteGraph, egoGraph, trimGraph, graphStats,
} from './note-graph.js';
export {
  lintText, wordDiff, filterTypoEdits, editKey, applyEdits,
  COWRITER_SYSTEM, COWRITER_TEMPERATURE,
} from './cowriter.js';
export {
  salientTerms, topicTerms, researchRelevance, webQuery, researchSnippet,
  rankResearchCards, mergeResearchLanes,
} from './note-research.js';
export {
  PLAN_ROLES, PLAN_AUTHORS, PLAN_DECOMPOSE_SYSTEM, PLAN_DECOMPOSE_MAX_TOKENS,
  PLAN_DECOMPOSE_TEMPERATURE, PLAN_SECTION_MAX_TOKENS, PLAN_SECTION_TEMPERATURE,
  planSectionSystem, parsePlanTasks, planTitleFor, planParts, planBody, planAttribution,
} from './note-plan.js';
export { REACH, reachRank, reachSatisfies } from './reach.js';
export { UPCASTERS, upcast, upcastAll } from './upcast.js';
export {
  validateCapability, validateInvocation, canSatisfy,
  toModelSchema, toModelSchemas,
} from './capability.js';
export { checkInvariants, INVARIANTS } from './invariants.js';
export { createMemoryAdapter, createLogStore, createBlobStore } from './store.js';
export { createRegistry, REGISTRY_STATES } from './registry.js';
export { defineSearchEngine, reconcileEngines, attemptOrder, ENGINE_KINDS, SearchEngineError } from './search-engines.js';
export {
  getWeather, weatherUrl, parseWeather, formatWeather, areaLabel, isAmbiguousLocation,
  WEATHER_HOST, WEATHER_TIMEOUT_MS, WeatherError,
} from './weather.js';
export { defineToolGroup, createToolGroupRegistry, ToolGroupError } from './tool-groups.js';
export { toolNeedFor } from './tool-need.js';
export { parseFlowchart, layoutFlowchart, renderFlowchartSvg } from './flowchart.js';
export { validateView, validateViewInvocation, viewResult } from './view.js';
export { validateWidget, validateWidgetMessage, effectiveGrants, widgetIcon, WIDGET_SURFACES } from './widget.js';
export { fuseRRF, planQueries, multiSearch } from './rrf.js';

// The compounding layer — subjects a brief can accumulate about, and the deterministic
// half of the maintenance pass (W0's read-only survey is `surveyCorpus`).
export {
  SUBJECT_KINDS, DEFAULT_THRESHOLD, MAX_SUBJECTS, MAX_SUBJECT_CHARS,
  normalizeSubject, subjectKey, subjectTokens, isSubjectCandidate,
  aliasMap, resolveSubjects, earnsBrief, rankSubjects,
  REDACTION_TOKEN_TYPES, isRedactionToken, SELF_LABELS, isSelfLabel, stripQualifiers,
  suggestMerges,
} from './entity.js';
export {
  BRIEF_STATES, CLAIM_KINDS, MAX_CLAIMS, MAX_CLAIM_REFS, MAX_BRIEF_RECORDS, MAX_BRIEF_CHARS,
  contentHash, briefId, briefToText, briefTerms, briefLinks, checkKnowledgeInvariants, parseBriefText,
} from './knowledge.js';
export { deriveBrief, deriveBriefs, driftedRefs } from './knowledge-derive.js';
export {
  SYNTHESIS_SCHEMA, synthesisPrompt, claimsFromSynthesis,
  MAX_SYNTHESIS_CLAIMS, MAX_EXCERPTS, MAX_EXCERPT_CHARS,
} from './synthesis.js';
export { PROPOSAL_STATES, SUPERSEDE_OVERLAP, propose, accept, reject, diffProposal, converge, linkClaims } from './promotion.js';
export {
  normalizeRecord, normalizeRecords, wikilinksIn, redactedTokensIn, redactionCost,
  wantedPages, orphanRecords,
  duplicateTitles, vocabularyDrift, mentionsFrom, spanningQuestions,
  surveyCorpus, thresholdSweep, formatSurvey, NEAR_TITLE_DISTANCE, SPAN_MIN_TERMS,
} from './curate.js';
export {
  PDF_MAX_CHARS, linesFromItems, orderLines, paragraphsFromLines,
  pageTextFromItems, looksScanned, buildPdfDocument,
} from './pdf-layout.js';
export {
  YOUTUBE_HOSTS, TRANSCRIPT_MAX_CHARS,
  parseYouTubeUrl, isYouTubeUrl,
  captionTracksFromPlayerResponse, videoMetaFromPlayerResponse,
  pickCaptionTrack, timedTextUrl, parseTimedText,
  groupSegments, formatTimestamp, formatTranscript,
  buildTranscriptDocument, transcriptFromTracks,
} from './media-transcript.js';
export {
  ACCESS_LOG_VERSION, ACCESS_LOG_MAX, redactAccessArgs, makeAccessEvent,
  createAccessLog, makeStorageTier, formatBytes,
} from './observability.js';
export { routeGraph, projectChain } from './route-graph.js';
export { defineAdapter, createAdapterRegistry, AdapterError } from './adapters.js';
export { linkifyCitations, sourcesFromToolText } from './citations.js';
export { buildTrajectory, phasesOf, lanesOf, filterEntries, displayName, ENTRY_KINDS, threadsOf, threadTitle, promptEntries, turnsOf, threadTree } from './trajectory.js';
export { createTurnRunner, defineLoop, LOOP_KINDS, LoopError } from './loop.js';
export { defineModel, defineMiddleware, defineRouteStrategy, createModelRouter, signalsFrom, requirementsFor, requirementsForStep, preferenceFor, failoverOrder, pinnedOrderOf, FAILOVER_CLASS_GAP, FAILOVER_CAPABILITY_GAP, sameModelKey, RouterError } from './router.js';
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
  clipText, matchSummary,
} from './schedule.js';
export { defineMeetingAnalyzer, createAnalyzerRegistry, CADENCES, AnalyzerError } from './meeting-analyzers.js';
export {
  DEFAULT_WAKE, MAX_COMMANDS_PER_DELTA, DAYPART_HOUR, VoiceIntentError,
  compileWake, findWakeCommand, parseCommand, commandsFromSegments,
  parseDuration, parseClock, parseWhen, parseNumberWords, normalizeSpeech, tokenize, editDistance,
  defineVoiceIntent, createVoiceIntentRegistry, defaultVoiceIntents, BUILTIN_VOICE_INTENTS,
  timerIntent, reminderIntent, scheduleIntent, noteIntent, monitorIntent,
  REFINEMENT_SCHEMA, refinementPrompt, refinementFormat, parseRefinement, refinementStream, settleRefinement,
  refineSpokenCommand, isFillerSentence, gistText, gistOpening,
  commandLooksFinished, sameUtterance, createUtteranceGate,
  UTTERANCE_SETTLE_MS, UTTERANCE_DANGLING_MS,
} from './voice-intents.js';
export {
  MAX_TOPICS, MAX_TOPIC_CHARS, TOPICS_SCHEMA, topicsSchema, topicsPrompt, topicsFormat, parseTopics,
  normalizeTopic, normalizeTopics, topicsStream,
  ENTITY_TYPES, ENTITIES_SCHEMA, entitiesPrompt, entitiesFormat, parseEntities, coerceEntities, entitiesStream,
  MAX_SUGGESTIONS, MAX_SUGGESTION_CHARS, SUGGESTIONS_SCHEMA, suggestionsPrompt, suggestionsFormat,
  parseSuggestions, suggestionsStream,
} from './extraction.js';
export {
  FIELD_TYPES, RESPONSE_MODES, StructuredError,
  defineSchema, describeSchema, toJsonSchema, responseFormat,
  unfence, findJson, rewriteJson, repairJson, isNothing,
  coerce, parseStructured, createStructuredStream,
} from './structured.js';
export { explainMcpError, packageFromArgs, isStaleMcpSession } from './mcp-errors.js';
// The tool round — what a tool does, how a round runs, what a result costs, how a tool is
// found, and a workflow written down once (see docs/ROADMAP "the tool round" in chatpanel).
export { toolTraits, bareToolName, canRunConcurrently, isCacheable, needsConfirmation, traitsIndex } from './tool-traits.js';
export { planToolRound, runToolRound } from './tool-round.js';
export {
  createResultStore, shieldToolResult, runResultQuery, withResultShield, describeShape, compactValue,
  resultToolSpec, RESULT_TOOL_NAME, DEFAULT_SHIELD, DEFAULT_STORE,
} from './tool-result.js';
export { findTools, findToolsResult, findActionArgs, oneLiner, overlapRank, FIND_ACTION } from './tool-discovery.js';
export { compressToolSpec, compressToolSpecs, compressionStats, trimDescription, COMPRESSION_MODES, DEFAULT_COMPRESSION } from './tool-schema.js';
export { validateRecipe, expandRecipe, recipeParams, mapInput, dryRunRecipe, runPlan, runRecipe, RecipeError, RECIPE_MODES } from './recipe.js';
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
export {
  MAX_TAG_LENGTH, MAX_TAGS, normalizeTag, normalizeTags, hasTag, addTag, removeTag, toggleTag,
  sameTags, formatTag, parseTagQuery, hasTagTerms, formatTagQuery, matchesTagFilter, filterByTags,
  tagFacets, suggestExistingTags, tagsSearchText,
} from './tags.js';
export {
  UNTITLED_MEETING, MAX_TITLE_LENGTH, TITLE_RULES_VERSION, cleanTitle, isGenericTitle, titleFromSummary, titleFromTopics,
  titleFromParticipants, titleFromDate, deriveMeetingTitle, shouldAutoTitle, isBetterTitleSource,
  meetingTitlePrompt, parseTitleResponse,
} from './titles.js';

// The library — one record model (chat / note / meeting / brief) for every client, so
// "what is the title of this meeting" has one answer rather than one per codebase.
export {
  RECORD_KINDS, MAX_TITLE_LEN, LibraryError,
  parseRecordId, makeRecordId, isRecordId,
  normalizeStoredRecord, isValidStoredRecord, toSearchRecord, searchTextFor, toIndexEntry,
  deriveTitle, snippetOf, wordCount,
} from './library.js';

// Two-way sync, as a pure plan over two index lists. Shared because the tie-break must not
// depend on which client is asking, or two clients flap forever.
export {
  CLOCK_TOLERANCE_MS, SyncError,
  stampOf, decide, planSync, isSettled, forkConflict, advanceBases,
} from './sync-plan.js';

// The encrypted backup wire format — the corpus's only lossless channel between clients.
export {
  ENCRYPTED_TYPE, COMPRESSIONS, BackupError,
  // Aliased: `vault.js` also exports KDF_ITERATIONS, and the two are genuinely different
  // numbers (the vault derives at 310k, a backup at 250k). Shadowing one with the other
  // would silently re-key every backup this package writes.
  KDF_ITERATIONS as BACKUP_KDF_ITERATIONS,
  encryptBackup, decryptBackup, isEncryptedBackup,
  identityCodec, streamCodec, nodeCodec, bestCodec,
  // `toB64`/`fromB64` are deliberately NOT re-exported: `vault.js` already owns those names
  // here. They remain on the module for callers that import the file directly.
} from './backup-envelope.js';

// The command bar's grammar, so muscle memory transfers between surfaces.
export {
  OMNI_MODES, OMNI_GRAMMAR,
  parseOmni, extractFilters, resolveSince, wantsModel, isActionable,
} from './omni.js';

// The palette as data, for clients that cannot import a stylesheet.
export {
  THEMES, LIGHT, DARK, PALETTES, SHAPE, TOKEN_NAMES, TOKEN_ROLES,
  paletteFor, cssVarName, toCssVars, themeStylesheet, resolveTheme,
} from './theme.js';

// Plans, gates and the signed entitlement — one definition, every client. The public
// verification key lives here so a rotation reaches all of them, instead of being a
// hand-edit in each (which is what CLAUDE.md currently has to warn about).
export {
  PLANS, API_BASE, ENDPOINTS, ENTITLEMENT_PUBLIC_JWK, UPGRADE_URL,
  FEATURE_TIER, PRO_FEATURES, TEAM_FEATURES, FREE_LIMITS,
  RECHECK_INTERVAL_MS, EntitlementError,
  checkoutUrl, planOf, planLabel, isPro, isTeam, can, tierFor, withinFreeLimit,
  verifyEntitlement, licenseFromPayload, needsRecheck,
} from './entitlement.js';

// One markdown renderer for every client — escaped first, link policy injected.
export { renderMarkdown, defaultLinkPolicy } from './markdown-render.js';

// A meeting read back out of the flat text the warm store holds — the same grammar the
// extension writes and MCP reads, so every client shows one transcript, not three.
export { parseMeetingText, speakerStats, densityRibbon } from './meeting-text.js';
export { speakerBreakdown, speakerTimeline, formatTalkTime, SPEAKER_SLOTS } from './meeting-shape.js';
