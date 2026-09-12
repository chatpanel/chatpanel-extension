// GENERATED — do not edit.
// Source of truth: chatpanel-events/context-attachments.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// ATTACHED CONTEXT, AS THE MODEL SEES IT — the same on every client.
//
// A message carries `attachments`: pages, selections, fetched links, files, images, and the
// user's own records. This is how they reach a model: text sources folded into the message
// as <context> blocks, images as image blocks in the provider's wire shape, and — when the
// turn has tools and the sources are big — a MANIFEST plus a `source` tool instead of the
// full text, so "hi" on a long page does not pay for the page.
//
// Moved out of the extension's providers.js so the desktop's turn assembles attachments
// exactly the way the panel does. Pure: nothing here fetches or renders.

import { makeSourceStore, manifestText, readSource, approxTokens } from './sources-retrieval.js';

// Flatten a stored message (with attachments) into the text the model sees.
// Image attachments are excluded here — they go to the model as image blocks
// (see toMultimodalMessages), not as text.
export function renderContent(m) {
  let text = m.content || '';
  const ctx = (m.attachments || []).filter((a) => a.kind !== 'image');
  if (ctx.length) {
    const blocks = ctx
      .map((a) => {
        const head = `[${a.kind || 'context'}] ${a.title || a.url || ''}`.trim();
        return `<context source="${(a.url || a.title || '').replace(/"/g, '')}">\n# ${head}\n${a.text || ''}\n</context>`;
      })
      .join('\n\n');
    text = text ? `${text}\n\n${blocks}` : blocks;
  }
  return text;
}

export function toChatMessages(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: renderContent(m) }));
}

// Image attachments on a message: { dataUrl: 'data:<media>;base64,<...>' }.
export function imageAttachmentsOf(m) {
  return (m.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl);
}

// Like toChatMessages, but emits multimodal content (text + image blocks) for
// user messages that carry images, in the given provider's wire format. Falls
// back to plain string content when there are no images. `provider` is
// 'openai' | 'anthropic'.
export function toMultimodalMessages(messages, provider) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = renderContent(m);
      const imgs = m.role === 'user' ? imageAttachmentsOf(m) : [];
      if (imgs.length === 0) return { role: m.role, content: text };
      if (provider === 'anthropic') {
        const content = [];
        for (const a of imgs) {
          const match = /^data:([^;]+);base64,(.+)$/s.exec(a.dataUrl);
          if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        }
        if (text) content.push({ type: 'text', text });
        return { role: 'user', content: content.length ? content : text };
      }
      // openai (and OpenAI-compatible vision endpoints)
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const a of imgs) content.push({ type: 'image_url', image_url: { url: a.dataUrl } });
      return { role: 'user', content: content.length ? content : text };
    });
}

/**
 * Hand the model a MANIFEST of what is attached, and a tool to read it.
 *
 * Attachments used to be flattened into the first message — every attached tab, in full,
 * before the model had said anything. "hi" on a long page paid for the whole page, and five
 * attached tabs put five documents in the prompt to answer a question about one paragraph of
 * one of them.
 *
 * Two conditions, both necessary:
 *   - THE TURN MUST CARRY TOOLS. Deferring content a model cannot then fetch does not save
 *     tokens, it deletes the context — the worst possible outcome, and silently.
 *   - IT MUST BE WORTH A ROUND TRIP. Below the threshold the extra call costs more than the
 *     text it avoids, so small attachments still travel inline.
 *
 * Returns the rewritten messages plus a store, or null when nothing was deferred.
 */
export function deferAttachedSources(messages, tools, { minTokens = 700 } = {}) {
  if (!tools?.specs?.length) return null;
  const carried = [];
  for (const m of messages || []) {
    for (const a of m?.attachments || []) {
      if (a?.kind === 'image' || !a?.text) continue;
      carried.push(a);
    }
  }
  if (!carried.length) return null;
  const store = makeSourceStore(carried.map((a) => ({
    kind: a.kind || 'context', title: a.title, url: a.url, text: a.text,
  })));
  if (store.tokens < minTokens) return null;
  // Same index, same id: the manifest and the store must agree or the model asks for
  // something real and is told it does not exist.
  const idFor = new Map(carried.map((a, i) => [a, store.entries[i]?.id]));
  const out = (messages || []).map((m) => {
    if (!m?.attachments?.some((a) => idFor.get(a))) return m;
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        const id = idFor.get(a);
        // The stub keeps the title and url — knowing WHAT is attached is what lets the model
        // decide whether to read it, and that part is cheap.
        return id ? { ...a, text: `(not included — read with \`source\`: id ${id}, ~${approxTokens(a.text)} tokens)` } : a;
      }),
    };
  });
  return { messages: out, store };
}

export const SOURCE_TOOL_SPEC = {
  name: 'source',
  description: 'Read an attached source (a page, tab, selection or file the user attached). Their content is NOT in the conversation — read what you need from here.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The source id from the manifest, e.g. page-1.' },
      query: { type: 'string', description: 'What you are looking for. A large source returns the matching sections rather than its first page.' },
    },
    required: ['id'],
  },
};

/** Add `source` to an existing toolset without disturbing what is already there. */
export function withSourceTool(tools, store) {
  const spec = { ...SOURCE_TOOL_SPEC };
  const system = [
    tools?.system,
    `${manifestText(store)}\n\nTheir content is NOT in this conversation. Call \`source\` with an id — and a query when the source is large — to read what you need.`,
  ].filter(Boolean).join('\n\n');
  return {
    ...tools,
    specs: [...(tools?.specs || []), spec],
    system,
    systemParts: { ...(tools?.systemParts || {}), source: approxTokens(manifestText(store)) },
    execute: async (name, input, meta) => (name === 'source'
      ? JSON.stringify(readSource(store, typeof input === 'string' ? JSON.parse(input || '{}') : (input || {})))
      : tools.execute(name, input, meta)),
  };
}
