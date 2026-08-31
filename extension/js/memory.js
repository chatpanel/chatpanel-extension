// MEMORY, as a capability the surfaces call — not logic living in the side panel.
//
// Plain data in, plain data out: no DOM, no chrome.* beyond the store, no side-panel state.
// The side panel, the Notes dashboard and anything after them arm memory through these three
// entry points, so what the model is told cannot depend on which window the user typed into:
//
//   recallForTurn()      → the memories this turn carries, and the system text for them
//   captureFromMessage() → what the user's own words asked to be remembered
//   memoryToolProvider() → the `memory` tool, for when the MODEL wants to save something
//
// The decisions are all in @chatpanel/events/memory.js. This file binds them to storage and to
// the surface's confirm dialog, and owns exactly one policy the shared package cannot: WHO IS
// ALLOWED TO WRITE WITHOUT ASKING.
//
// THE AUTHOR DECIDES THE GATE. A memory is injected into every future turn on every model, so
// a bad one is not a bad answer once — it is a standing instruction. That makes it precisely
// the thing an injected page wants to write. So:
//
//   • the USER's own words save themselves when they issued a command ("remember that…"),
//     because the user is the author and asking them to confirm what they just typed is a
//     tax on the one case where intent is unambiguous;
//   • the USER's revealed facts ("I prefer…") are OFFERED, never taken;
//   • an AGENT's `memory` call is CONFIRMED, always — the same gate note-tools.js puts on
//     writing a note, for a stronger reason. Content that reached the model from a web page
//     must not be able to durably rewrite how ChatPanel treats its owner.

import {
  candidatesFrom, recall, memoryBlock, memoryToolSystem, MEMORY_TOOL_SPEC,
  MEMORY_KINDS, MEMORY_KIND_NAMES, MAX_MEMORY_CHARS,
} from './events/memory.js';
import {
  getMemories, rememberMemory, forgetMemory, touchMemories,
} from './store-memory.js';

export { MEMORY_KINDS, MEMORY_KIND_NAMES, MAX_MEMORY_CHARS };

/** Memory is on unless the user turned it off. Onboarding-first: it must work out of the box. */
export function memoryEnabled(settings) {
  return settings?.ui?.memory?.enabled !== false;
}

/** Whether to surface "Remember this?" offers for facts the user merely revealed. */
export function offersEnabled(settings) {
  return memoryEnabled(settings) && settings?.ui?.memory?.offers !== false;
}

/**
 * The scopes a turn can see: always 'global', plus the agent it is running on, so a preference
 * set for one CLI does not leak into another.
 */
export function scopesFor({ agentId = '' } = {}) {
  return agentId ? ['global', `agent:${agentId}`] : ['global'];
}

/**
 * What this turn should carry, and the text that carries it.
 *
 * Returns `{ system: '' }` when memory is off or empty, so callers can concatenate
 * unconditionally — a caller that has to branch is a caller that will forget to.
 *
 * `touch` is deliberately fire-and-forget: recall statistics must never delay a turn, and a
 * failed write of them must never fail one.
 */
export async function recallForTurn({ text = '', settings = {}, agentId = '', maxChars } = {}) {
  if (!memoryEnabled(settings)) return { memories: [], system: '' };
  let all = [];
  try { all = await getMemories(); } catch { return { memories: [], system: '' }; }
  if (!all.length) return { memories: [], system: '' };

  const memories = recall(all, {
    text,
    scopes: scopesFor({ agentId }),
    now: Date.now(),
    ...(maxChars ? { maxChars } : {}),
  });
  if (!memories.length) return { memories: [], system: '' };

  touchMemories(memories.map((m) => m.id)).catch(() => {});
  return { memories, system: memoryBlock(memories) };
}

/**
 * Read one user message and act on what it asked for.
 *
 * Commands are applied here and now — that is the user's own consent, already given in the
 * words they typed. Reveals come back as `offers` for the surface to show as a chip; this
 * function never writes one.
 *
 * @returns {{ saved: object[], forgot: object[], offers: object[] }}
 */
export async function captureFromMessage(text, { settings = {}, agentId = '', surface = 'chat', ref = '' } = {}) {
  const out = { saved: [], forgot: [], offers: [] };
  if (!memoryEnabled(settings)) return out;

  const candidates = candidatesFrom(text, { includeReveals: offersEnabled(settings) });
  for (const c of candidates) {
    if (!c.explicit) { out.offers.push(c); continue; }
    try {
      if (c.op === 'forget') {
        const { removed } = await forgetMemory(c.text);
        out.forgot.push(...removed);
      } else {
        const res = await rememberMemory({
          text: c.text,
          kind: c.kind,
          confidence: c.confidence,
          source: { via: 'user', surface, ref, agent: agentId },
        });
        // A restatement is not news. Reporting "Remembered" for something already known is the
        // fastest way to make the feature feel like it is not listening.
        if (res.action !== 'duplicate') out.saved.push({ ...res.record, action: res.action, replaces: res.replaces });
      }
    } catch { /* one bad candidate must not swallow the others */ }
  }
  return out;
}

/** Accept an offer the user tapped. Separate from capture so the UI owns the moment of consent. */
export async function acceptOffer(candidate, { agentId = '', surface = 'chat', ref = '' } = {}) {
  return rememberMemory({
    text: candidate.text,
    kind: candidate.kind,
    confidence: candidate.confidence,
    source: { via: 'user', surface, ref, agent: agentId },
  });
}

/**
 * The `memory` tool, for when the MODEL decides something is worth keeping.
 *
 * Every write asks the user. See the header: a memory is a standing instruction to every
 * future turn, so an agent that read a web page must not be able to install one silently.
 * `list` and a denied write are answered plainly enough that the model stops rather than
 * retrying with different words.
 *
 * Platform bits are injected (confirm, onChanged) exactly as note-tools.js does, so this
 * module stays testable and the surface keeps its DOM.
 *
 * @param confirm  async (detail) => 'allow' | 'deny'
 * @param needsConfirm mirrors the page/note tools' preference; a user who turned confirmation
 *        off for those has already answered this question.
 */
export function memoryToolProvider({
  confirm = null, onChanged = () => {}, agentLabel = 'AI', agentId = '', needsConfirm = true, ref = '',
} = {}) {
  const err = (message, extra = {}) => JSON.stringify({ ok: false, error: message, ...extra });

  return {
    specs: [MEMORY_TOOL_SPEC],
    system: memoryToolSystem(),
    async execute(name, input = {}) {
      if (name !== 'memory') return err(`Unknown tool "${name}".`);
      const action = String(input.action || '').trim();

      if (action === 'list') {
        const all = await getMemories();
        if (!all.length) return 'No memories stored yet.';
        return [
          `${all.length} memory(ies) about this user:`,
          ...all.map((m) => `- [${m.id}] (${m.kind}) ${m.text}${m.pinned ? ' · pinned' : ''}`),
        ].join('\n');
      }

      const text = String(input.text || '').trim();
      if (!text) return err(`"${action || 'memory'}" needs \`text\`.`);

      if (action === 'forget') {
        const all = await getMemories();
        const { matchForForget } = await import('./events/memory.js');
        const hits = all.some((m) => m.id === text) ? all.filter((m) => m.id === text) : matchForForget(all, text);
        if (!hits.length) return err(`No memory matches "${text}". Use action "list" to see what is stored.`);
        if (needsConfirm && confirm) {
          const verdict = await confirm({
            title: 'Forget this?',
            body: hits.map((m) => m.text).join('\n'),
            kind: 'forget',
            agent: agentLabel,
          });
          if (verdict !== 'allow') return err('The user declined. Do not try again — leave the memory as it is.');
        }
        const { removed } = await forgetMemory(text);
        onChanged('forget', removed);
        return JSON.stringify({ ok: true, forgot: removed.map((m) => m.text) });
      }

      if (action !== 'remember') return err(`Unknown action "${action}".`, { actions: ['remember', 'forget', 'list'] });
      if (text.length > MAX_MEMORY_CHARS) {
        return err(`A memory must be at most ${MAX_MEMORY_CHARS} characters. Shorten it, or save the long version as a note.`);
      }

      const kind = MEMORY_KINDS[input.kind] ? input.kind : 'fact';
      if (needsConfirm && confirm) {
        const verdict = await confirm({ title: 'Remember this?', body: text, kind, agent: agentLabel });
        if (verdict !== 'allow') return err('The user declined. Do not save it and do not ask again this turn.');
      }

      const res = await rememberMemory({
        text,
        kind,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        confidence: 1,
        source: { via: 'agent', surface: 'chat', ref, agent: agentId || agentLabel },
      });
      onChanged(res.action, [res.record]);
      return JSON.stringify({
        ok: true,
        action: res.action,
        remembered: res.record.text,
        ...(res.replaces ? { replaced: res.replaces.text } : {}),
        ...(res.action === 'duplicate' ? { note: 'Already known — nothing changed.' } : {}),
      });
    },
  };
}
