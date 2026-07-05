// Lifetime Free quota for AI (full-tier / entity-aware) PII redaction.
//
// "Full" tier = the model/NER pass that finds names, orgs and locations (the
// reversible [[PERSON_1]] tokens), as opposed to the always-free deterministic
// pass (emails, keys, cards, phones via regex + dictionary). On Free this is
// capped at FREE_LIMITS.fullRedactions uses, then it falls back to the
// deterministic tier. Pro is unlimited.
//
// The count is shared: every full-tier redaction the extension performs counts
// against it, whether from a normal ChatPanel chat send or from the privacy
// "Test a prompt" run. Persisted in chrome.storage.local so it survives reloads
// and reads the same in the side panel and the settings page.

import { FREE_LIMITS } from './license.js';

const KEY = 'chatpanel:fullRedactionUsage';

async function readUsed() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const u = got[KEY];
    if (u) return Number(u.used) || 0;
  } catch { /* storage unavailable — treat as fresh */ }
  return 0;
}

// Read-only snapshot for the UI ("X of 25 used · 17 left").
export async function fullRedactionUsage(isPro) {
  const used = await readUsed();
  const cap = FREE_LIMITS.fullRedactions;
  return { used, cap, remaining: Math.max(0, cap - used), pro: !!isPro, exhausted: !isPro && used >= cap };
}

// May a full-tier redaction run right now? Pro is always yes. Checked BEFORE the
// (cost-bearing) detector runs, so an out-of-quota Free user quietly stays on the
// deterministic tier instead of calling the model.
export async function canUseFullRedaction(isPro) {
  if (isPro) return true;
  return (await readUsed()) < FREE_LIMITS.fullRedactions;
}

// Count one consumed full-tier redaction (Free only) — call AFTER one actually
// ran (i.e. entities were found and redacted), so empty detections don't burn the
// allowance. No-op for Pro. Best-effort: a storage failure never blocks redaction.
export async function recordFullRedaction(isPro) {
  if (isPro) return;
  const used = await readUsed();
  try { await chrome.storage.local.set({ [KEY]: { used: used + 1 } }); } catch { /* best effort */ }
}
