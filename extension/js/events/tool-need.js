// GENERATED — do not edit.
// Source of truth: chatpanel-events/tool-need.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Does this turn need tools AT ALL — asked before any of them are built.
//
// Every turn was armed with the same equipment regardless of what was said. "hi" arrived at
// the model carrying a history dispatcher, an MCP dispatcher and ~1,200 tokens of rulebook
// explaining how to use them, and that cost more than the prompt itself. That is not only
// waste, it CHANGES THE ANSWER: a turn that carries tools requires a model that can call
// them (see requirementsFor), so a greeting eliminated every model without the tools
// capability and then paid a CLI agent two seconds to spawn a process in order to wave back.
//
// Equipment is not demand. The question "what does this turn need" has to be asked of the
// MESSAGE, before the toolset exists — which is what the router already does for model
// choice, from the same signals, for free.
//
// THE ERROR BIAS IS THE OPPOSITE OF THE ROUTER'S, which is why this is not simply
// `signals.smalltalk`. Mis-routing a turn produces a worse answer; withholding the history
// tools from "what did we decide in the standup" produces "I cannot access your meetings" —
// wrong, and the exact thing the tool system prompt exists to prevent. So this does not try
// to detect which turns need tools. It recognises the narrow class of turns that provably
// cannot — pleasantries, and nothing else — and arms everything otherwise.
//
// Recognised by VOCABULARY rather than by absence: every word must be a conversational
// move. An unknown word, a typo, a name, a question — anything at all — falls through to
// "arm the tools", which is the safe direction. `smalltalk` still has to agree, so the two
// definitions of trivial cannot drift apart.
//
// Class R: no model call, no network, no I/O. Reading a string.

import { signalsFrom } from './router.js';

// Greetings, thanks, acknowledgements, farewells — and the filler that attaches to them
// ("hey there", "ok got it", "thanks so much"). Deliberately small: every addition widens
// the set of turns that get no tools, so a word earns its place by being unable to appear
// in a request.
const PLEASANTRY = new Set([
  'hi', 'hii', 'hiya', 'hey', 'heya', 'hello', 'helo', 'yo', 'sup', 'howdy', 'greetings',
  'good', 'morning', 'afternoon', 'evening', 'night', 'day',
  'thanks', 'thank', 'thankyou', 'thx', 'tnx', 'ty', 'cheers', 'appreciated',
  'ok', 'okay', 'k', 'kk', 'got', 'sounds', 'perfect', 'great', 'cool', 'nice', 'awesome',
  'lol', 'haha', 'hah', 'hehe', 'nvm', 'yep', 'yeah', 'yes', 'no', 'nope', 'sure',
  'bye', 'goodbye', 'later', 'ya', 'cya', 'ciao', 'welcome', 'worries', 'problem', 'np',
  'please', 'there', 'again', 'all', 'everyone', 'team', 'friend', 'mate', 'buddy',
  'you', 'u', 'so', 'much', 'very', 'well', 'and', 'a', 'the',
]);

// At most a short phrase. A long message built entirely from these words is not a greeting,
// it is something this rule does not understand — and not understanding means arm the tools.
const MAX_PLEASANTRY_WORDS = 6;

function isPleasantry(text) {
  // Strip emoji, punctuation and digits: "hi!! 👋" is "hi". Anything left must be a word in
  // the vocabulary.
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > MAX_PLEASANTRY_WORDS) return false;
  return words.every((w) => PLEASANTRY.has(w));
}

/**
 * @param request     { text } | { messages } — the turn, as the router already reads it.
 * @param signals     precomputed signalsFrom(request), when the caller already has them.
 * @param attachments anything the user attached; presence alone means there is material.
 * @param explicit    the user or a skill ASKED for tools this turn (MCP mode 'on', the
 *                    /history hint, a running skill). Never second-guessed.
 * @returns { tools, why } — `tools: false` means build nothing at all this turn.
 */
export function toolNeedFor({ request = null, signals = null, attachments = [], explicit = false } = {}) {
  if (explicit) return { tools: true, why: 'the turn asked for tools' };
  // MATERIAL THE USER HANDED OVER — not the tab that happens to be open.
  //
  // The side panel auto-attaches the current page to every send, so "hi" on a search results
  // page arrived carrying an attachment and armed the full toolset: three tools, ~2,300
  // tokens and a page read, to say hello back. The open tab is METADATA about where the user
  // is, not content they asked about; treating the two the same made the ambient page defeat
  // this rule on every turn where it mattered.
  //
  // `auto` marks it. A page the user genuinely attached has no such mark and still counts —
  // and a message that ASKS about the page ("summarise this") is not a pleasantry anyway, so
  // it arms tools by the ordinary path rather than by what happens to be attached.
  if ((attachments || []).some((a) => a && !a.auto)) {
    return { tools: true, why: 'the turn carries an attachment' };
  }

  const text = String(request?.text ?? (request?.messages || []).map((m) => m?.content || '').join('\n'));
  if (!isPleasantry(text)) return { tools: true, why: 'the request may need something fetched' };

  // And the router has to agree it is trivial. Two definitions of "asks for nothing" that
  // can disagree is the duplication this codebase keeps removing; requiring both means the
  // stricter one always wins.
  const sig = signals || signalsFrom(request || {});
  if (!sig.smalltalk) return { tools: true, why: 'the request may need something fetched' };

  return { tools: false, why: 'a greeting — nothing to look up' };
}
