// Reversible PII redaction.
//
// Strips sensitive values out of everything that leaves the device for a model
// (chat text, attached page/meeting context, and tool results we feed back), then
// reconstructs the originals when the reply is rendered to the user. The model
// only ever sees opaque, stable placeholders like [[EMAIL_1]] / [[PERSON_2]] — so
// it can still reason about "who said what" without seeing the real values.
//
// Pure + dependency-free so it is unit-testable and runs identically for API and
// CLI/bridge agents (both assemble their outbound payload through providers.js).
//
// Tiers (the licensing seam):
//   'basic' — deterministic regex: emails, phones, IPs, cards (Luhn), SSNs, keys.
//   'full'  — basic + entity-aware: known people/orgs (meeting roster, contacts,
//             the user's own identity) and a user-editable custom dictionary.
//
// Reversibility caveat: if the model paraphrases instead of echoing a token, that
// one reference won't restore (it shows the token) — but the privacy guarantee
// (the real value never left the device) always holds.

const TOKEN_RE = /\[\[([A-Z][A-Z0-9]*)_(\d+)\]\]/g;

// Bracket-TOLERANT match of the same token. Smaller models routinely drop or mangle
// the [[ ]] when echoing a placeholder into tool-call JSON — e.g. they emit "ORG_1"
// or "[ORG_1]" instead of "[[ORG_1]]" — which the strict TOKEN_RE misses, leaving
// the tool to search the literal "ORG_1" (and get nothing). We match 0–2 brackets
// on each side and reconstruct the canonical token to look up; only ACTUAL vault
// tokens are swapped, so a coincidental "ABC_1" that isn't ours is left untouched.
const TOLERANT_TOKEN_RE = /\[{0,2}([A-Z][A-Z0-9]*_\d+)\]{0,2}/g;

// A vault is the per-conversation mapping between placeholders and originals. Keep
// one per conversation so PERSON_1 means the same entity across turns.
export function createVault() {
  // `aliases` maps a pseudonym (e.g. "Alex") back to the real value (e.g. "Suresh")
  // so LOCAL tool calls (history/meeting search) can run on real data. The reply
  // restorer ignores it — pseudonyms stay permanent in the user's view.
  return { byToken: new Map(), byValue: new Map(), counts: new Map(), aliases: new Map() };
}

export function vaultToJSON(vault) {
  return {
    entries: [...(vault?.byToken || new Map())].map(([token, value]) => ({ token, value })),
    aliases: [...(vault?.aliases || new Map())].map(([alias, value]) => ({ alias, value })),
  };
}

export function vaultFromJSON(data) {
  const vault = createVault();
  for (const { token, value } of data?.entries || []) {
    const m = /^\[\[([A-Z][A-Z0-9]*)_(\d+)\]\]$/.exec(token);
    vault.byToken.set(token, value);
    vault.byValue.set(value, token);
    if (m) vault.counts.set(m[1], Math.max(vault.counts.get(m[1]) || 0, Number(m[2])));
  }
  for (const { alias, value } of data?.aliases || []) vault.aliases.set(alias, value);
  return vault;
}

function tokenFor(vault, type, value) {
  const existing = vault.byValue.get(value);
  if (existing) return existing;
  const t = String(type || 'PII').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PII';
  const n = (vault.counts.get(t) || 0) + 1;
  vault.counts.set(t, n);
  const token = `[[${t}_${n}]]`;
  vault.byToken.set(token, value);
  vault.byValue.set(value, token);
  return token;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Deterministic detectors. Each: { type, re, valid? }. Order = priority; more
// specific patterns run first so they win the bytes before greedier ones.
const DETECTORS = [
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    type: 'KEY',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    type: 'IP',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    // Phone: only count it if it has a separator or a leading + and 7–15 digits —
    // so long bare ids (a 11-digit page id, an order number) are NOT redacted.
    type: 'PHONE',
    re: /(?<![\w.])\+?\d[\d ().-]{6,}\d(?![\w])/g,
    valid: (m) => {
      const digits = m.replace(/\D/g, '');
      // Needs a separator / leading + OR be a bare 10-digit run (a typed phone like
      // 9320434444). 11+ bare digits still require formatting so long ids aren't hit.
      return digits.length >= 7 && digits.length <= 15
        && (/[ ().-]/.test(m) || m.trimStart().startsWith('+') || digits.length === 10);
    },
  },
  {
    type: 'CARD',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    valid: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhnValid(d); },
  },
];

// Redact `text`, recording placeholders in `vault`. `entities` (full tier) is a
// list of { value, type } known names/orgs; `dictionary` is the user's custom
// list of { value, type } (exact strings) or { pattern, flags, type } (regex).
export function redactText(text, vault, {
  tier = 'basic',
  entities = [],
  dictionary = [],
} = {}) {
  if (text == null || text === '') return text;
  let out = String(text);
  const v = vault || createVault();

  const entityTier = tier === 'full' || tier === 'entities';

  // 1) User dictionary first — highest authority, user explicitly chose these.
  //    An entry with `alias` PSEUDONYMIZES: permanent substitution (the model and
  //    the user's transcript both see the alias, never reversed). Otherwise it
  //    REDACTS to a reversible [[TYPE_n]] placeholder restored in the user's view.
  for (const d of dictionary || []) {
    if (!d) continue;
    try {
      const re = d.pattern
        ? new RegExp(d.pattern, d.flags && /g/.test(d.flags) ? d.flags : `${d.flags || ''}g`)
        : (d.value ? new RegExp(`(?<![\\w])${escapeRegex(d.value)}(?![\\w])`, 'gi') : null);
      if (!re) continue;
      if (d.alias != null && d.alias !== '') {
        out = out.replace(re, () => d.alias); // pseudonymize: model + reply see the alias…
        // …but record alias→original so LOCAL tool args (history/meeting search) map
        // back to the real value. Local lookups must hit real data; only the model is blinded.
        if (d.value) v.aliases.set(d.alias, d.value);
      } else {
        out = out.replace(re, (m) => tokenFor(v, d.type || (d.pattern ? 'PII' : 'TERM'), d.pattern ? m : d.value));
      }
    } catch {
      /* a bad user regex must never break redaction */
    }
  }

  // 2) Known entities (full tier) — longest value first so "Alex Rivera" wins
  //    before a bare "Alex". Restores to the canonical entity value.
  if (entityTier) {
    const ents = [...(entities || [])].filter((e) => e && e.value)
      .sort((a, b) => String(b.value).length - String(a.value).length);
    for (const e of ents) {
      const re = new RegExp(`(?<![\\w])${escapeRegex(e.value)}(?![\\w])`, 'gi');
      out = out.replace(re, () => tokenFor(v, e.type || 'PERSON', e.value));
    }
  }

  // 3) Deterministic detectors (all tiers).
  for (const det of DETECTORS) {
    out = out.replace(det.re, (m) => (!det.valid || det.valid(m) ? tokenFor(v, det.type, m) : m));
  }
  return out;
}

// Swap placeholders back to their originals. Unknown tokens are left untouched.
export function restoreText(text, vault) {
  if (text == null || !vault) return text;
  return String(text).replace(TOLERANT_TOKEN_RE, (m, inner) => {
    const canonical = `[[${inner}]]`;
    return vault.byToken.has(canonical) ? vault.byToken.get(canonical) : m;
  });
}

// Restore for LOCAL use only — e.g. tool-call args that hit on-device history /
// meeting search. Undoes reversible tokens AND pseudonyms, so local lookups run on
// the real values. NOT used for the user-facing reply (pseudonyms stay there).
export function restoreWithAliases(text, vault) {
  let out = restoreText(text, vault);
  if (vault?.aliases?.size) {
    for (const [alias, real] of vault.aliases) {
      if (!alias) continue;
      out = out.replace(new RegExp(`(?<![\\w])${escapeRegex(alias)}(?![\\w])`, 'g'), () => real);
    }
  }
  return out;
}

// True if the text still contains any redaction placeholder (useful for streaming
// restore — buffer a tail when a token may be split across chunks).
export function hasToken(text) {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(String(text || ''));
}
