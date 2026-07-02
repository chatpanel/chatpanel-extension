// AI prompt-assist — expand/improve a draft prompt using the user's *configured*
// model (whatever agent/endpoint is currently selected). Shared by the side-panel
// composer and the Skills editor. Costs nothing extra: it runs on the user's own
// model, never a ChatPanel-hosted one.
import { streamChat } from './providers.js';
import { getTarget, resolveTarget } from './store.js';

const SYSTEM =
  'You are a prompt engineer helping a user write a better prompt for an AI ' +
  'assistant. Rewrite their draft into a single, clear, self-contained prompt: ' +
  'state the role/goal, the steps or criteria, and the desired output format. ' +
  'Preserve any {{placeholders}} verbatim. Do NOT answer the prompt or add ' +
  'commentary — output ONLY the improved prompt text, with no code fences, ' +
  'quotes, or preamble.';

// Resolve the model prompt-assist should run on (the active chat target), or an
// actionable error if nothing usable is configured.
export function assistTarget(settings) {
  const target = getTarget(settings, settings.activeAgentId);
  const agent = resolveTarget(target, settings);
  if (!agent) return { error: 'No model configured yet — add an endpoint or agent first.' };
  if (agent.kind !== 'bridge' && !agent.model) {
    return { error: `Pick a model for "${target?.name || 'your endpoint'}" first (API tab → Load models).` };
  }
  return { agent, name: target?.name || agent.name };
}

// Stream an improved prompt. onDelta(fullText) is called with the running text.
export async function assistPrompt({ draft, settings, onDelta, signal }) {
  const { agent, error } = assistTarget(settings);
  if (error) throw new Error(error);
  const d = (draft || '').trim();
  const instruction = d
    ? `Improve and expand this into a complete, well-structured prompt:\n\n"""\n${d}\n"""`
    : 'Write a useful, well-structured starter prompt for an AI assistant that works over web-page context.';
  let out = '';
  await streamChat({
    agent: { ...agent, systemPrompt: SYSTEM, temperature: 0.4 },
    messages: [{ role: 'user', content: instruction }],
    settings,
    signal,
    usage: { surface: 'assist' },
    onDelta: (chunk) => {
      out += chunk;
      onDelta?.(out);
    },
    onEvent: () => {},
  });
  return out.trim();
}
