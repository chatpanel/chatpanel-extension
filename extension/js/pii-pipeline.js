// Turn-level orchestration for reversible PII redaction.
//
// Composes the deterministic engine (pii-redact.js) into the message pipeline:
//   - redactOutbound: redact a COPY of the turn's messages (content + non-image
//     attachment text) and the system prompt into a per-conversation vault, just
//     before they go to any model (API or CLI/bridge).
//   - makeStreamRestorer: restore placeholders in the streamed reply, holding a
//     small tail so a token split across chunks ([[PER | SON_1]]) still restores.
//   - redactToolResult / restore: redact local tool results before feeding them
//     back to the model, restore for display.
//
// Phase 1 is deterministic-only (regex + known entities + user dictionary), so it
// adds no latency. The phase-2 model-detection pass simply contributes more
// entities into the same vault, so nothing here changes when it lands.

import { createVault, redactText, restoreText, restoreWithAliases } from './pii-redact.js';
import { sanitizeUnicode } from './sanitize.js';

export function redactionEnabled(cfg) {
  return !!(cfg && cfg.mode && cfg.mode !== 'off');
}

// Module-level Pro entitlement for the DEFAULT redaction path (the auxiliary model
// calls — topic extraction, meeting scribe, autocomplete — that don't pass an
// explicit `redaction`). The app sets this once on license load so those calls
// are gated like the main chat.
let piiEntitled = false;
export function setPiiEntitlement(isPro) { piiEntitled = !!isPro; }

// Build a default redaction context from global settings + a fresh per-call vault.
// streamChat uses this whenever a caller omits `redaction`, so NO model-bound call
// can bypass redaction when the user has it on. A fresh vault per call is fine:
// each call re-redacts its whole payload, so tokens are self-consistent within it.
export function redactionFromSettings(settings) {
  const cfg = settings?.ui?.piiRedaction;
  if (!redactionEnabled(cfg)) return null;
  return { vault: createVault(), cfg, isPro: piiEntitled, entities: [], detect: cfg.mode === 'model' };
}

// One-shot redact a single string using global settings — for the rare non-
// streamChat model path (the raw-fetch bridge autocomplete). Returns { text,
// vault }; restore the model's output with restore(out, vault). Applies the same
// tier/scope/dictionary gating as the main pipeline.
export function redactOnce(text, settings) {
  const ctx = redactionFromSettings(settings);
  if (!ctx) return { text, vault: null };
  const out = redactOutbound({
    messages: [{ role: 'user', content: text }],
    vault: ctx.vault, cfg: ctx.cfg, isPro: ctx.isPro, entities: ctx.entities,
  });
  return { text: out.messages[0]?.content ?? text, vault: ctx.vault };
}

// The entity (name/org) tier is Pro; Free silently falls back to deterministic
// regex so the feature still does something useful without the upsell breaking.
export function effectiveTier(cfg, isPro) {
  const t = cfg?.tier === 'full' ? 'full' : 'basic';
  return t === 'full' && !isPro ? 'basic' : t;
}

// Free ceiling: a small taste of the custom dictionary (the first FREE_DICT_LIMIT
// entries apply); an unlimited dictionary, wider scope, and the model layer are Pro.
// Enforced here at runtime as defense-in-depth (the UI also surfaces the cap).
export const FREE_DICT_LIMIT = 5;

function gatedDictionary(cfg, isPro) {
  const d = Array.isArray(cfg?.dictionary) ? cfg.dictionary : [];
  return isPro ? d : d.slice(0, FREE_DICT_LIMIT);
}

export function gatedScope(cfg, isPro) {
  const s = cfg?.scope || {};
  if (isPro) return s;
  return { chat: s.chat !== false, context: false, history: false, toolResults: false };
}

export function redactOpts(cfg, isPro, entities) {
  return {
    tier: effectiveTier(cfg, isPro),
    entities: entities || [],
    dictionary: gatedDictionary(cfg, isPro),
  };
}

// Returns redacted COPIES — never mutates the stored conversation (local history
// keeps the real values; redaction re-applies each send via the same vault).
export function redactOutbound({ messages, system, vault, cfg, isPro = false, entities = [] }) {
  if (!redactionEnabled(cfg) || !vault) return { messages, system };
  const opts = redactOpts(cfg, isPro, entities);
  const scope = gatedScope(cfg, isPro);
  // De-steganography pass (see sanitize.js): strip invisible/format Unicode BEFORE
  // deterministic redaction so a zero-width-split value can't slip past the detector,
  // and a hidden instruction or fingerprint marker can't ride along to the model.
  // Runs on the outbound COPIES only — stored history keeps the user's literal text.
  let sanitized = 0;
  const scrub = (t) => { const { clean, removed } = sanitizeUnicode(t); sanitized += removed; return clean; };
  const redactMsg = (m) => {
    const copy = { ...m };
    if (scope.chat !== false && m.content) copy.content = redactText(scrub(m.content), vault, opts);
    if (Array.isArray(m.attachments)) {
      copy.attachments = m.attachments.map((a) => {
        if (a.kind === 'image' || !a.text) return a;
        const isHistory = a.kind === 'history-rag';
        if (isHistory ? scope.history === false : scope.context === false) return a;
        return { ...a, text: redactText(scrub(a.text), vault, opts) };
      });
    }
    return copy;
  };
  const outMessages = (messages || []).map(redactMsg);
  return {
    messages: outMessages,
    system: system ? redactText(scrub(system), vault, opts) : system,
    sanitized,
  };
}

// Redact a local tool result string before it is returned to the model (e.g. a
// history_search hit containing real names). No-op when scope.toolResults is off.
export function redactToolResult(text, { vault, cfg, isPro = false, entities = [] } = {}) {
  if (!redactionEnabled(cfg) || !vault || !gatedScope(cfg, isPro).toolResults) return text;
  if (typeof text !== 'string') return text;
  return redactText(text, vault, redactOpts(cfg, isPro, entities));
}

// Streaming-safe restorer. push() returns text safe to display now; flush() the rest.
export function makeStreamRestorer(vault) {
  let buf = '';
  return {
    push(chunk) {
      if (!vault) return chunk || '';
      buf += chunk || '';
      const open = buf.lastIndexOf('[[');
      let safe;
      if (open !== -1 && !buf.slice(open).includes(']]')) {
        // a placeholder may still be forming at the tail — hold it back
        safe = buf.slice(0, open);
        buf = buf.slice(open);
      } else {
        safe = buf;
        buf = '';
      }
      return restoreText(safe, vault);
    },
    flush() {
      const out = vault ? restoreText(buf, vault) : buf;
      buf = '';
      return out;
    },
  };
}

export function restore(text, vault) {
  return vault ? restoreText(text, vault) : text;
}

// Deep-restore a value (tool-call args the model produced contain tokens; local
// tools must run on the REAL values). Walks strings/arrays/objects.
export function restoreDeep(value, vault) {
  if (!vault) return value;
  // restoreWithAliases (not restoreText): tool args run LOCALLY, so undo pseudonyms
  // too — the on-device search must hit real data; only the model stays blinded.
  if (typeof value === 'string') return restoreWithAliases(value, vault);
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = restoreDeep(value[k], vault);
    return out;
  }
  return value;
}

// Redact a tool result before it is fed back to the model. Results are a string
// or an object like { text, image, … }; only the text is redacted.
export function redactResult(result, ctx) {
  if (typeof result === 'string') return redactToolResult(result, ctx);
  if (result && typeof result === 'object' && typeof result.text === 'string') {
    return { ...result, text: redactToolResult(result.text, ctx) };
  }
  return result;
}
