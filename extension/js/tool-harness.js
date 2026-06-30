// THE tool harness — one interception layer shared by every orchestrator
// (ChatPanel API + agent, gateway API + relay) so tool handling can't drift. It
// owns the boundaries around a model turn:
//
//   ⓪ selectTools  — inject + narrow the tools the model is offered (MCP-auto).
//   ② toTool       — what a tool RECEIVES: real values (so on-device / remote
//                    lookups work), or the redacted token for remote MCP tools
//                    when the user chose "redact remote".
//   ③ toModelResult— what the MODEL sees back: the tool result re-redacted so it
//                    stays blinded.
//   ④ toUser       — the final reply: reversible tokens restored (pseudonyms stay).
//
// PRIVACY IS OPTIONAL. With no `vault` (redaction off), ②③④ are pass-throughs —
// no latency, no placeholder confusion — but ⓪ selectTools STILL narrows, because
// not every turn is privacy-sensitive yet every turn benefits from fewer tools.
//
// Self-contained on the SYNCED engine files (pii-redact.js, tool-rank.js), so the
// extension (browser ESM) and the gateway (npm) run the exact same code. The caller
// passes the already-gated `redactOpts` ({tier, entities, dictionary}) it computed
// from cfg+isPro — keeping tier/dictionary Pro-gating out of the harness.

import { restoreText, restoreWithAliases, redactText } from './pii-redact.js';
import { narrowSpecs } from './tool-rank.js';

// MCP / remote tools are server-prefixed (mcp_server__tool). Local tools
// (history/meeting/page, or a client's core bash/read) are not — they always get
// real values and are never narrowed away.
export const isRemoteToolName = (name) => /^mcp[_-]/i.test(String(name || ''));

// Deep restore of a tool-call argument value, undoing reversible tokens AND
// pseudonyms (tools run locally / on real data; only the model stays blinded).
export function restoreToolArgs(value, vault) {
  if (!vault) return value;
  if (typeof value === 'string') return restoreWithAliases(value, vault);
  if (Array.isArray(value)) return value.map((v) => restoreToolArgs(v, vault));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = restoreToolArgs(value[k], vault);
    return out;
  }
  return value;
}

// System-prompt note that tells the model how to behave around placeholders when
// tools are armed. WITHOUT this, privacy-aware models (Codex, Claude) recognize a
// [[LOCATION_1]] token as redacted and REFUSE to use it for a lookup ("I can't see
// your real city") — the opposite of what we want. Weak models call the tool blindly
// and it works (the harness restores the real value), so the note levels them up.
export function placeholderToolNote({ toolData = 'real' } = {}) {
  const intro =
    'PRIVACY PLACEHOLDERS: some values in this conversation are tokens like [[PERSON_1]], '
    + '[[LOCATION_1]], [[ORG_1]] that stand in for the user\'s real private data. ';
  const remote = toolData === 'redactRemote'
    ? 'When you call a LOCAL tool the placeholder is automatically replaced with the real '
      + 'value before the tool runs; REMOTE (MCP) tools deliberately receive the placeholder '
      + 'to keep private data off third-party servers. '
    : 'When you call ANY tool, these placeholders are AUTOMATICALLY replaced with the real '
      + 'values before the tool executes — the tool receives the TRUE value and returns correct '
      + 'results. ';
  const rules =
    'So: treat each placeholder as a CONCRETE, specific value you already have — it is enough to '
    + 'act on, NOT missing or unknown information. CALL THE TOOL using the placeholder exactly as '
    + 'written, as if it were the real value. '
    // The common failure isn\'t a privacy refusal — it\'s the model deciding it "lacks data"
    // because the value is a token, and answering from general knowledge instead of looking up.
    + 'If answering needs the real data behind a placeholder (e.g. which city [[LOCATION_1]] is, '
    + 'who [[PERSON_1]] is, what [[ORG_1]] does), do NOT reply that you lack information or cannot '
    + 'answer. Instead pick the most relevant available tool for that placeholder\'s TYPE — LOCATION '
    + '→ geography / place lookups, PERSON → people lookups, ORG → company/org lookups, dates/IDs → '
    + 'the matching lookup — and pass the placeholder straight through as the argument. The harness '
    + 'restores the true value before the tool runs, so the lookup returns correct results. Make your '
    + 'best-guess tool call FIRST; only conclude you lack data AFTER a tool has actually returned '
    + 'nothing useful. '
    + 'Do NOT ask the user to re-type the value and do NOT refuse on privacy grounds — the lookup '
    + 'will work. The real values are restored in your final answer automatically, so write your '
    + 'answer using the placeholders too.';
  return intro + remote + rules;
}

export function makeToolHarness({ vault = null, toolData = 'real', redactOpts = null, redactResults = true } = {}) {
  const on = !!vault;                       // privacy enabled for this turn?
  const redactRemote = toolData === 'redactRemote';
  return {
    enabled: on,
    isRemoteTool: isRemoteToolName,

    // ⓪ Always-on tool selection (privacy-independent). `available` is any spec
    // list; `opts` forwards { cap, keep, name, description } to the shared ranker.
    selectTools(available, query, opts = {}) {
      return narrowSpecs(available, query, opts);
    },

    // ② What the tool receives.
    toTool(name, args) {
      if (!on) return args;                                    // privacy off → already real
      if (redactRemote && isRemoteToolName(name)) return args;  // keep PII off remote MCP
      return restoreToolArgs(args, vault);                      // real values for the tool
    },

    // ③ What the model sees back (re-redacted). Handles a string or a { text } shape.
    toModelResult(name, raw) {
      if (!on || !redactResults || !redactOpts) return raw;
      if (typeof raw === 'string') return redactText(raw, vault, redactOpts);
      if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
        return { ...raw, text: redactText(raw.text, vault, redactOpts) };
      }
      return raw;
    },

    // ④ The final reply the user sees.
    toUser(text) {
      return on ? restoreText(text, vault) : text;
    },
  };
}
