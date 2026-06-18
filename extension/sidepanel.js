// ChatPanel side panel controller.
import {
  getSettings,
  getTarget,
  resolveTarget,
  getIndex,
  getConversation,
  createConversation,
  saveConversation,
  renameConversation,
  deleteConversation,
  pruneEmptyConversations,
  clearAllConversations,
  conversationToMarkdown,
  updateSettings,
  meetingNotesSkill,
} from './js/store.js';
import { streamChat, checkBridge, listModels, smallestModel } from './js/providers.js';
import {
  listTabs,
  getActiveTab,
  captureActiveTab,
  captureTab,
  captureSelection,
  captureUrl,
  captureMeetingTranscript,
  meetingPlatform,
  probeMeeting,
  startMeeting,
  stopMeeting,
  getMeetingRecord,
} from './js/context.js';
import {
  meetingToText,
  meetingToMarkdown,
  getMeetingIndex,
  getMeeting,
  getMeetingNotes,
  saveMeetingNotes,
  deleteMeeting,
  markMeetingEnded,
} from './js/store-meetings.js';
import { renderMarkdown } from './js/markdown.js';
import { getLicense, isPro, planLabel, can, canUseAgent, freeAgentId, freeEndpointId, tierFor, FREE_LIMITS, subscribe } from './js/license.js';
import { checkForUpdate, isDismissed, dismiss } from './js/update.js';
import { assistPrompt } from './js/assist.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  license: null,
  conv: null, // active conversation
  index: [], // history index
  attachments: [], // pending context for the next message
  usePage: true, // auto-include the current tab as context
  activeTab: null, // { id, title, url } of the tab the panel is looking at
  bridge: { ok: false, agents: [] },
  convCache: new Map(), // id -> live conv object (kept so streams survive switches)
  streams: new Map(), // convId -> { controller, started, lastEvent }
  bubbles: new Map(), // messageId -> bubble element (active view only)
  // Watch mode: re-read a FIXED tab on an interval and re-run the agent on change.
  watch: {
    on: false,
    timer: null,
    busy: false,
    tabId: null, // the tab captured at Start (not whatever's active later)
    tabTitle: '',
    convId: null, // the conversation watch runs append to
    lastHash: null,
    runs: 0,
    errored: false,
    instruction: '',
    intervalMs: 10000,
    onlyWhenChanged: true,
    maxRuns: 50,
  },
};

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
async function init() {
  state.settings = await getSettings();
  state.license = await getLicense();
  ensureUsableActiveAgent();
  state.usePage = state.settings.ui.autoAttachActiveTab !== false;
  applyTheme();
  await pruneEmptyConversations(); // clear stale empty "New chat" entries
  state.index = await getIndex();

  await startConversation();
  wireEvents();
  wireDrawerResize();
  refreshBridge();
  refreshActiveTab();
  renderUpgradeChip();
  maybeShowUpdateBanner();
  scheduleLiveNotes({ force: true }); // arm the global meeting-scribe loop (off-tab safe)
  if (state.settings.ui?.railCollapsed) {
    document.body.classList.add('rail-collapsed');
    const t = $('rail-toggle');
    if (t) { t.textContent = '›'; t.title = 'Show panel rail'; }
  }
  renderRail();
  // Keep the "recording" indicator + live-meeting cache fresh even when Live notes
  // is off and the user isn't switching tabs (so it clears soon after a call ends).
  setInterval(() => renderScribeIndicator(), 30_000);

  // Right-click "Ask ChatPanel" seed.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'context-seed') applySeed(msg);
  });
  const { pendingSeed } = await chrome.storage.session.get('pendingSeed').catch(() => ({}));
  if (pendingSeed) {
    applySeed(pendingSeed);
    chrome.storage.session.remove('pendingSeed').catch(() => {});
  }
}

async function startConversation(existing) {
  const conv =
    existing || (await createConversation({ agentId: state.settings.activeAgentId }));
  state.convCache.set(conv.id, conv);
  state.conv = conv;
  state.bubbles.clear();
  state.attachments = [];
  renderAgentName();
  renderMessages();
  renderContextBar();
  updateComposerUI();
  renderActivity();
}

// Is the conversation currently on screen mid-response?
function isActiveStreaming() {
  return state.streams.has(state.conv.id);
}

// Parse a leading "/command args" into its skill (or null). The caller applies
// the skill's context/agent and substitutes variables — see applySkillPrep.
function matchSlashSkill(text) {
  const m = /^\/([a-z0-9_-]+)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const skill = state.settings.skills.find(
    (s) => (s.command || '').toLowerCase() === m[1].toLowerCase(),
  );
  return skill ? { skill, args: m[2].trim() } : null;
}

// --------------------------------------------------------------------------
// Agents
// --------------------------------------------------------------------------
function currentAgent() {
  return getTarget(state.settings, state.conv.agentId || state.settings.activeAgentId);
}

// On Free, the active agent must be one of the unlocked slots. If it isn't
// (default points elsewhere, or the user downgraded from Pro), repoint to the
// free agent slot so chatting never targets a locked agent.
function ensureUsableActiveAgent() {
  if (isPro(state.license)) return;
  const cur = getTarget(state.settings, state.settings.activeAgentId);
  if (cur && canUseAgent(state.license, state.settings, cur)) return;
  const id = freeAgentId(state.settings) || freeEndpointId(state.settings);
  if (id && id !== state.settings.activeAgentId) {
    state.settings.activeAgentId = id;
    updateSettings({ activeAgentId: id });
  }
}

// `target` may be an endpoint, a model agent, or a bridge agent.
function agentAvailability(target) {
  if (!target) return { ok: false, reason: 'None' };
  if (target.kind === 'bridge') {
    if (!state.bridge.ok) return { ok: false, reason: 'Bridge not running' };
    // Custom "bring your own" agents aren't in /health (the bridge can't enumerate
    // user-defined commands); they're validated when run / via Settings' Check.
    if (target.bridgeAgent === 'custom') {
      return target.command ? { ok: true } : { ok: false, reason: 'No command set' };
    }
    const found = state.bridge.agents.find((a) => a.id === target.bridgeAgent);
    if (!found) return { ok: false, reason: 'Not detected' };
    return { ok: found.available, reason: found.reason };
  }
  // Endpoint or model agent — usable once it resolves to an endpoint + a model.
  const eff = resolveTarget(target, state.settings);
  if (!eff?.baseUrl) return { ok: false, reason: 'No endpoint' };
  if (!eff.model) return { ok: false, reason: 'Pick a model' };
  return { ok: true };
}

async function refreshBridge() {
  state.bridge = await checkBridge(state.settings.bridgeUrl);
  renderAgentName();
}

function renderAgentName() {
  const a = currentAgent();
  $('agent-name').textContent = a?.name || 'Select agent';
}

function renderAgentMenu() {
  const menu = $('agent-menu');
  menu.innerHTML = '';
  const s = state.settings;

  const addItem = (target, badge) => {
    const avail = agentAvailability(target);
    const usable = canUseAgent(state.license, s, target); // Pro, or the free pick
    const item = document.createElement('button');
    item.className =
      'menu-item' +
      (target.id === state.conv.agentId ? ' active' : '') +
      (usable ? '' : ' locked');
    const dot = document.createElement('span');
    dot.className = 'dot ' + (avail.ok ? 'on' : 'off');
    const label = document.createElement('span');
    label.style.flex = '1';
    const model = target.kind === 'bridge' ? '' : resolveTarget(target, s)?.model || '';
    const sub = !avail.ok
      ? `<span class="mi-sub">— ${escapeAttr(avail.reason)}</span>`
      : model
        ? `<span class="mi-sub">${escapeAttr(model)}</span>`
        : '';
    label.innerHTML = `${escapeAttr(target.name)} ${sub}`;
    item.append(dot, label);
    // Locked (Pro) items keep a 🔒 tag; free ones keep their existing badge.
    if (!usable) {
      const lock = document.createElement('span');
      lock.className = 'badge lock';
      lock.textContent = '🔒 Pro';
      item.appendChild(lock);
    } else if (badge) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = badge;
      item.appendChild(b);
    }
    item.onclick = () => {
      if (!usable) {
        closeMenus();
        return upsell('agents', '✨ Free uses 1 model + 1 agent — Pro unlocks all. Pick yours in Settings.');
      }
      state.conv.agentId = target.id;
      state.settings.activeAgentId = target.id;
      updateSettings({ activeAgentId: target.id });
      saveConversation(state.conv);
      renderAgentName();
      closeMenus();
    };
    menu.appendChild(item);
  };

  const endpoints = s.endpoints || [];
  const bridge = (s.agents || []).filter((a) => a.kind === 'bridge');
  if (endpoints.length) {
    menu.appendChild(sectionLabel('API'));
    endpoints.forEach((e) => addItem(e));
  }
  if (bridge.length) {
    menu.appendChild(sectionLabel('Agents'));
    bridge.forEach((a) => addItem(a, 'local'));
  }
  const manage = document.createElement('button');
  manage.className = 'menu-item';
  manage.innerHTML = '⚙ <span>Manage in Settings…</span>';
  manage.onclick = () => chrome.runtime.openOptionsPage();
  menu.appendChild(manage);
}

// --------------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------------
function renderMessages() {
  const root = $('messages');
  root.querySelectorAll('.msg').forEach((n) => n.remove());
  state.bubbles.clear();
  const empty = $('empty');
  if (!state.conv.messages.length) {
    empty.classList.remove('hidden');
    renderSuggestions();
  } else {
    empty.classList.add('hidden');
    for (const m of state.conv.messages) root.appendChild(renderMessage(m));
  }
  scrollToBottom();
}

function renderMessage(m) {
  // Watch-mode log row — a compact dim line, not a chat bubble.
  if (m.role === 'watch') {
    const row = document.createElement('div');
    row.className = 'msg watch-log';
    row.dataset.id = m.id;
    row.textContent = `👁 ${m.content} · ${timeLabel(m.ts)}`;
    return row;
  }

  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}${m.error ? ' error' : ''}${m.queued ? ' queued' : ''}`;
  wrap.dataset.id = m.id;

  if (m.role === 'assistant') {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.watch ? `👁 watch run · ${timeLabel(m.watchAt)}` : m.agentName || 'Assistant';
    wrap.appendChild(who);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'assistant') {
    bubble.innerHTML = assistantBody(m);
    if (m.pending && !m.content && !m.thinking) bubble.classList.add('cursor-blink');
    enhanceCode(bubble);
  } else {
    // user bubble: plain text + attachment note
    bubble.textContent = m.content;
    if (m.attachments?.length) {
      const note = document.createElement('div');
      note.className = 'who';
      note.style.marginTop = '6px';
      note.textContent = '📎 ' + m.attachments.map((a) => a.title || a.url).join(', ');
      bubble.appendChild(note);
    }
    if (m.queued) {
      const q = document.createElement('div');
      q.className = 'who';
      q.style.marginTop = '4px';
      q.textContent = '⏳ Queued';
      bubble.appendChild(q);
    }
  }
  wrap.appendChild(bubble);
  state.bubbles.set(m.id, bubble);

  // hover actions
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = miniBtn('Copy', () => navigator.clipboard.writeText(m.content));
  actions.appendChild(copy);
  if (m.role === 'assistant' && !m.pending) {
    actions.appendChild(miniBtn('Retry', () => retryFrom(m)));
  }
  wrap.appendChild(actions);
  return wrap;
}

function updateBubble(m) {
  const bubble = state.bubbles.get(m.id);
  if (!bubble) return;
  bubble.classList.toggle('cursor-blink', !!m.pending && !m.content && !m.thinking);
  bubble.innerHTML = assistantBody(m);
  enhanceCode(bubble);
}

// Assistant bubble = an optional streamed "thinking" disclosure + the answer.
function assistantBody(m) {
  let html = '';
  if (m.thinking) {
    const open = m.pending ? ' open' : '';
    html += `<details class="thinking"${open}><summary>💭 Thinking</summary><div class="thinking-body">${escapeAttr(
      m.thinking,
    )}</div></details>`;
  }
  html += m.content ? renderMarkdown(m.content) : '';
  return html;
}

function enhanceCode(bubble) {
  bubble.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '');
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
    pre.appendChild(btn);
  });
}

function renderSuggestions() {
  const box = $('empty-suggestions');
  box.innerHTML = '';
  const ideas = [
    'Summarize this tab',
    'What are the key points on this page?',
    'Explain the code in this repo',
  ];
  for (const idea of ideas) {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = idea;
    b.onclick = () => {
      // The current page is already auto-included via the 🌐 chip — don't
      // attach it again here or we'd send the page twice.
      $('input').value = idea;
      autoGrow();
      $('input').focus();
    };
    box.appendChild(b);
  }
}

// --------------------------------------------------------------------------
// Sending + streaming
// --------------------------------------------------------------------------
// Conversations currently mid-send (between the click and the stream starting).
// Taken synchronously so a rapid double Enter/click can't fire two requests.
const sendingLock = new Set();

async function send() {
  const input = $('input');
  clearPromptSuggest();
  const raw = input.value.trim();
  const conv = state.conv; // capture: the user may switch chats while this streams
  // Guard BEFORE any await: a second fast Enter would otherwise slip through the
  // gap while we read the page, producing duplicate requests.
  if (
    (!raw && !state.attachments.length) ||
    state.streams.has(conv.id) ||
    sendingLock.has(conv.id)
  ) {
    return;
  }
  sendingLock.add(conv.id);
  try {
    // A /command invokes its skill: switch agent, attach its context, and fill
    // {{variables}} — all before the page auto-attach below reads state.usePage.
    // Skills are Pro; on Free the command is sent as literal text with a nudge.
    let text = raw;
    const sk = matchSlashSkill(raw);
    if (sk && !skillsAllowed()) {
      upsell('customSkills');
    } else if (sk) {
      await applySkillPrep(sk.skill);
      text = await substituteVars(sk.skill.prompt + (sk.args ? `\n\n${sk.args}` : ''), { args: sk.args });
    }

    // Live meeting: if capture is active on this tab, automatically include a FRESH
    // transcript snapshot (read at send time) so the user doesn't have to hit Attach
    // for every question. Replaces any earlier meeting attachment so we never send a
    // stale copy, and skips the generic page-read below (the meeting shell page has
    // no useful text — the transcript IS the context).
    // Live meeting rides along on EVERY message, from any tab, unless excluded —
    // so you never have to navigate to a button to ask about an in-progress call.
    let meetingIncluded = false;
    if (
      can(state.license, 'liveMeetings') &&
      state.liveMeeting &&
      state.excludedMeetingId !== state.liveMeeting.id
    ) {
      try {
        const win = state.settings?.ui?.meetingWindowMin || 0; // 0 = full; N = last N min
        const sinceTs = win ? Date.now() - win * 60_000 : 0;
        // Read the live in-memory transcript at send time (real-time even when the
        // meeting tab is backgrounded), not the throttled persisted copy.
        const rec = await getLiveMeetingRecord();
        if (rec) {
          // Inject BOTH the running summary and the live transcript so the agent
          // answers from up-to-date context. Keep the recent transcript tail if long.
          const transcript = meetingToText(rec, { sinceTs });
          const notes = await getMeetingNotes(state.liveMeeting.id).catch(() => '');
          let body = (notes ? `RUNNING SUMMARY (so far):\n${notes}\n\n` : '') + 'LIVE TRANSCRIPT:\n';
          const cap = 40000;
          const room = Math.max(2000, cap - body.length);
          body += transcript.length > room ? '…' + transcript.slice(-room) : transcript;
          state.attachments = state.attachments.filter((a) => a.kind !== 'meeting');
          state.attachments.unshift({
            id: `mtg_${rec.id}_${Date.now()}`, kind: 'meeting',
            title: `🎙 ${rec.title || 'Meeting'} (live)`, url: rec.url || '',
            text: body, chars: body.length,
          });
          meetingIncluded = true;
        }
      } catch {
        /* no transcript yet — fall through and send without it */
      }
    }

    // Include the current page fresh (read at send time) unless the user turned it
    // off or already attached this exact tab. We DO include it alongside a live
    // meeting (ask about both the page AND the call) — only the meeting tab's own
    // page is skipped (it's just Meet's UI, and the transcript already covers it).
    const onMeetingTab = !!(state.activeTab && meetingPlatform(state.activeTab.url || ''));
    if (
      !onMeetingTab &&
      state.usePage &&
      state.activeTab &&
      !state.attachments.some((a) => a.url === state.activeTab.url)
    ) {
      try {
        toast('Reading this page…');
        state.attachments.unshift(await captureTab(state.activeTab.id));
      } catch {
        toast("⚠ Couldn't read this page; sending without it", 2200);
      }
    }

    // Auto-attach any URLs found in the message (the "paste a URL" flow).
    await autoAttachUrls(text);

    // Final guard: never send the same source twice (e.g. live page + a manual
    // attach of the same tab).
    const seen = new Set();
    const attachments = state.attachments.filter((a) => {
      const key = a.url || a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const userMsg = { id: uid(), role: 'user', content: text, attachments, ts: Date.now() };
    const queued = state.streams.has(conv.id); // a reply is already in flight
    userMsg.queued = queued;
    conv.messages.push(userMsg);
    input.value = '';
    autoGrow();
    suggestSuppressed = false;
    $('skill-suggest').classList.add('hidden');
    state.attachments = [];
    renderContextBar();

    $('empty').classList.add('hidden');
    $('messages').appendChild(renderMessage(userMsg));
    scrollToBottom();
    await saveConversation(conv);
    refreshHistory();

    if (queued) {
      // Queue: the running response picks it up when it finishes. (Hit Stop to
      // answer it now instead — i.e. steer.)
      toast('Queued — sends after the current reply');
      return;
    }

    const agent = agentForConv(conv);
    const assistant = makeAssistant(agent);
    conv.messages.push(assistant);
    $('messages').appendChild(renderMessage(assistant));
    scrollToBottom();
    // runStream registers the stream synchronously, so releasing the lock in the
    // finally below safely hands off to the state.streams guard.
    runStream(agent, assistant, conv); // not awaited — keeps other chats usable
  } finally {
    sendingLock.delete(conv.id);
  }
}

function agentForConv(conv) {
  return getTarget(state.settings, conv.agentId || state.settings.activeAgentId);
}

function makeAssistant(agent) {
  return {
    id: uid(),
    role: 'assistant',
    content: '',
    agentId: agent.id,
    agentName: agent.name,
    ts: Date.now(),
    pending: true,
  };
}

// After a response finishes, answer any messages the user queued while it ran.
// Several consecutive queued messages are answered together in one turn.
function maybeDrainQueue(conv) {
  if (state.streams.has(conv.id)) return;
  const last = conv.messages[conv.messages.length - 1];
  if (!last || last.role !== 'user') return;
  for (let i = conv.messages.length - 1; i >= 0 && conv.messages[i].role === 'user'; i--) {
    conv.messages[i].queued = false;
  }
  const agent = agentForConv(conv);
  const assistant = makeAssistant(agent);
  conv.messages.push(assistant);
  if (conv.id === state.conv.id) renderMessages();
  runStream(agent, assistant, conv);
}

// Streams a response into `conv` (which may not be the one on screen). UI is only
// touched when conv is the active conversation, so concurrent chats don't fight.
async function runStream(agent, assistant, conv) {
  const controller = new AbortController();
  state.streams.set(conv.id, { controller, started: Date.now(), lastEvent: '' });
  if (conv.id === state.conv.id) updateComposerUI();
  ensureActivityTimer();
  renderActivity();

  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (conv.id === state.conv.id) {
      updateBubble(assistant);
      scrollToBottom();
    }
  };

  try {
    await streamChat({
      agent: resolveTarget(agent, state.settings),
      messages: conv.messages.filter((m) => m !== assistant),
      settings: state.settings,
      signal: controller.signal,
      onDelta: (d) => {
        pending += d;
        assistant.content = pending; // keep the object current for switch-back
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onEvent: (ev) => {
        // Stream reasoning/thinking text into a collapsible block as it arrives.
        if (ev.type === 'reasoning' && ev.text) {
          assistant.thinking = (assistant.thinking || '') + ev.text;
          if (!raf) raf = requestAnimationFrame(flush);
        }
        recordActivity(conv.id, ev);
      },
    });
    assistant.content = pending;
  } catch (e) {
    if (e.name === 'AbortError') {
      assistant.content = pending + (pending ? '\n\n_(stopped)_' : '_(stopped)_');
    } else {
      assistant.content = `⚠ ${e.message}`;
      assistant.error = true;
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    assistant.pending = false;
    state.streams.delete(conv.id);
    ensureActivityTimer();
    if (conv.id === state.conv.id) {
      updateComposerUI();
      renderActivity();
      const node = $('messages').querySelector(`.msg[data-id="${assistant.id}"]`);
      if (node) node.replaceWith(renderMessage(assistant));
    }
    await saveConversation(conv);
    refreshHistory();
    maybeAutoTitle(conv); // fire-and-forget: name the chat from its first exchange
    // Answer anything the user queued while this ran. This also powers "steer":
    // hitting Stop ends the current reply, then the queued message is answered.
    maybeDrainQueue(conv);
  }
}

// Give a conversation a short, meaningful title generated by its OWN model from
// the first exchange — so history search shows "Refactor auth middleware" rather
// than a truncated first question. Runs once per conversation, in the background.
async function maybeAutoTitle(conv) {
  if (conv.autoTitled) return;
  const hasUser = conv.messages.some((m) => m.role === 'user' && m.content);
  const hasReply = conv.messages.some((m) => m.role === 'assistant' && m.content && !m.error);
  if (!hasUser || !hasReply) return;
  conv.autoTitled = true; // set first so concurrent turns don't double-run
  try {
    const target = resolveTarget(getTarget(state.settings, conv.agentId), state.settings);
    const title = await generateTitle(conv, target);
    if (title) conv.title = title;
  } catch {
    /* keep the truncated fallback title */
  }
  await saveConversation(conv).catch(() => {});
  refreshHistory();
}

function cleanTitle(s) {
  let t = (s || '').trim().split('\n')[0].trim();
  t = t.replace(/^title\s*[:\-]\s*/i, '');
  t = t.replace(/^["'“”«]+|["'“”».]+$/g, '').trim();
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || null;
}

async function generateTitle(conv, target) {
  if (!target) return null;
  const firstOf = (role) =>
    conv.messages.find((m) => m.role === role && m.content && !m.error)?.content || '';
  const u = firstOf('user').slice(0, 700);
  const a = firstOf('assistant').slice(0, 700);
  if (!u) return null;
  const sys =
    'You create a short, specific title for a chat conversation. Reply with ONLY ' +
    'the title: 3 to 6 words, Title Case, no quotes, no trailing punctuation.';
  const prompt = `Conversation:\n\nUser: ${u}\n\nAssistant: ${a}\n\nTitle:`;
  let out = '';
  await streamChat({
    // Override the system prompt + cap tokens; keep the conversation's model.
    agent: { ...target, systemPrompt: sys, maxTokens: 24, temperature: 0.3 },
    messages: [{ role: 'user', content: prompt }],
    settings: state.settings,
    onDelta: (d) => {
      out += d;
    },
    onEvent: () => {},
  });
  return cleanTitle(out);
}

function stopStream() {
  // If Watch is running on this conversation, Stop halts the WHOLE job — otherwise
  // it would only abort the current tick and the loop would reschedule + fire again.
  // stopWatch hard-aborts the in-flight stream, kills the timer, and logs
  // "👁 Watch stopped" so it's clear both the message and the watcher stopped.
  if (state.watch.on && state.watch.convId === state.conv.id) {
    stopWatch({ hard: true });
    return;
  }
  const s = state.streams.get(state.conv.id);
  if (s) s.controller.abort();
}

async function retryFrom(assistantMsg) {
  if (isActiveStreaming()) return;
  const conv = state.conv;
  const idx = conv.messages.indexOf(assistantMsg);
  if (idx < 0) return;
  // Drop this assistant turn and re-run from the prior user message.
  conv.messages.splice(idx, 1);
  const agent = currentAgent();
  const assistant = {
    id: uid(),
    role: 'assistant',
    content: '',
    agentId: agent.id,
    agentName: agent.name,
    ts: Date.now(),
    pending: true,
  };
  conv.messages.push(assistant);
  renderMessages();
  runStream(agent, assistant, conv);
}

// Send is ALWAYS available now: a send while a reply streams queues the next
// turn. Stop lives in the activity strip. (Kept as a function since several
// places call it; the composer stop button stays hidden.)
function updateComposerUI() {
  $('btn-send').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
}

// Activity strip: latest tool/status for the active stream + elapsed seconds.
function recordActivity(convId, ev) {
  const s = state.streams.get(convId);
  if (!s) return;
  if (ev.type === 'tool') s.lastEvent = `${ev.name || 'tool'}${ev.summary ? ': ' + ev.summary : ''}`;
  else if (ev.type === 'status') s.lastEvent = ev.text || s.lastEvent;
  else if (ev.type === 'reasoning') s.lastEvent = 'Thinking';
  if (convId === state.conv.id) renderActivity();
}

function renderActivity() {
  const strip = $('activity');
  const s = state.streams.get(state.conv.id);
  if (!s) {
    strip.classList.add('hidden');
    return;
  }
  const secs = Math.floor((Date.now() - s.started) / 1000);
  strip.classList.remove('hidden');
  strip.innerHTML = '<span class="spinner"></span>';
  const label = document.createElement('span');
  label.textContent = `${s.lastEvent || 'Working'}… ${secs}s`;
  const stop = document.createElement('button');
  stop.className = 'activity-stop';
  stop.textContent = 'Stop';
  stop.onclick = (e) => {
    e.stopPropagation();
    stopStream();
  };
  strip.append(label, stop);
}

let activityInterval = null;
function ensureActivityTimer() {
  if (state.streams.size && !activityInterval) {
    activityInterval = setInterval(renderActivity, 1000);
  } else if (!state.streams.size && activityInterval) {
    clearInterval(activityInterval);
    activityInterval = null;
  }
}

// --------------------------------------------------------------------------
// Context / attachments
// --------------------------------------------------------------------------
// Track which tab the panel is "looking at" so the page chip stays accurate.
async function refreshActiveTab() {
  try {
    const tab = await getActiveTab();
    state.activeTab =
      tab && /^https?:/.test(tab.url || '')
        ? { id: tab.id, title: tab.title || tab.url, url: tab.url }
        : null;
  } catch {
    state.activeTab = null;
  }
  renderContextBar();
  renderMeetingBar();
  renderScribeIndicator();
}

// Meeting companion status bar. Shown only when the active tab is a recognised
// meeting platform; tells the user whether capture is wired up and lets them
// start/stop/attach the live transcript. Probing the content script is async, so
// a sequence token guards against an older tab's result landing after a newer one.
let _meetingBarSeq = 0;
const MEETING_LABELS = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams', webex: 'Webex' };
// Short names for the scribe brand label ("ChatPanel Zoom Scribe", …).
const MEETING_SHORT = { zoom: 'Zoom', meet: 'Meet', teams: 'Teams', webex: 'Webex' };
// Meetings the user explicitly Stopped — we don't auto-restart these until they
// manually Start again. Keyed by meeting id/key so it survives tab switches.
const _autoStartSuppressed = new Set();

// Rolling-window choices (minutes) for how much transcript rides along each message.
// 0 = the whole meeting so far; positive = last N minutes (cheaper per question).
const MEETING_WINDOWS = [0, 30, 15, 5];
function meetingWindowLabel() {
  const m = state.settings?.ui?.meetingWindowMin || 0;
  return m ? `Last ${m}m` : 'Full';
}
async function cycleMeetingWindow() {
  const cur = state.settings?.ui?.meetingWindowMin || 0;
  const next = MEETING_WINDOWS[(MEETING_WINDOWS.indexOf(cur) + 1) % MEETING_WINDOWS.length];
  state.settings = await updateSettings({ ui: { meetingWindowMin: next } });
  renderMeetingBar();
  toast(`Meeting context: ${meetingWindowLabel()}`);
}

// --------------------------------------------------------------------------
// Live scribe — one running minutes doc, merge-refreshed on an interval.
// --------------------------------------------------------------------------
const LIVE_NOTES_INTERVALS = [0, 2, 3, 5, 10]; // minutes; 0 = off
const liveNotes = {
  key: null, text: '', transcript: '', updatedAt: 0, lastTs: 0,
  busy: false, timer: null, failures: 0, tab: 'summary', title: 'Meeting',
};

function liveNotesIntervalMin() {
  return state.settings?.ui?.liveNotesIntervalMin || 0;
}

async function cycleLiveNotesInterval() {
  const cur = liveNotesIntervalMin();
  const next = LIVE_NOTES_INTERVALS[(LIVE_NOTES_INTERVALS.indexOf(cur) + 1) % LIVE_NOTES_INTERVALS.length];
  state.settings = await updateSettings({ ui: { liveNotesIntervalMin: next } });
  scheduleLiveNotes({ force: true });
  renderMeetingBar();
  toast(next ? `Live notes refreshing every ${next} min` : 'Live notes off');
  if (next && state.activeTab) viewActiveMeeting(state.activeTab.id);
}

function resetLiveNotes() {
  liveNotes.key = null;
  liveNotes.text = '';
  liveNotes.updatedAt = 0;
  liveNotes.lastTs = 0;
  liveNotes.failures = 0;
}

function stopLiveNotes() {
  clearTimeout(liveNotes.timer);
  liveNotes.timer = null;
}

// --------------------------------------------------------------------------
// Live scribe loop — headless & MULTI-MEETING, decoupled from the active tab.
// The content script persists every capturing meeting's transcript to storage
// every ~4s regardless of focus, so the loop summarizes ALL live meetings from
// STORAGE (getMeetingIndex → getMeeting) and saves notes per meeting. This keeps
// the scribe running while you browse other tabs, and handles multiple calls.
// (Names kept so existing callers — init, the meeting bar, the interval cycler —
// keep arming it.) Runs while the side panel is open + a Live interval is set.
// --------------------------------------------------------------------------
const scribeState = new Map(); // meetingId → { lastTs }
let scribeBusy = false;

// `force` reschedules immediately; otherwise only arms if nothing is pending.
function scheduleLiveNotes({ force = false, delayMs } = {}) {
  const min = liveNotesIntervalMin();
  if (!min) { stopLiveNotes(); return; }
  if (liveNotes.timer && !force) return;
  clearTimeout(liveNotes.timer);
  liveNotes.timer = setTimeout(runLiveNotesTick, delayMs ?? (scribeState.size ? min * 60_000 : 4000));
}

async function runLiveNotesTick() {
  liveNotes.timer = null;
  const min = liveNotesIntervalMin();
  if (!min) return;
  if (scribeBusy) { scheduleLiveNotes({ force: true, delayMs: 15_000 }); return; }
  scribeBusy = true;
  try {
    let index = [];
    try { index = await getMeetingIndex(); } catch { /* none yet */ }
    const live = index.filter((e) => e.status !== 'ended');
    renderScribeIndicator(live);
    for (const e of live) {
      try {
        const rec = await getMeeting(e.id);
        const segs = rec?.segments || [];
        if (!segs.length) continue;
        const st = scribeState.get(e.id) || { lastTs: 0 };
        const latestTs = segs[segs.length - 1]?.t || Date.now();
        const prev = await getMeetingNotes(e.id).catch(() => '');
        const isFirst = !prev;
        if (!isFirst && latestTs <= st.lastTs) continue; // nothing new said
        const delta = meetingToText(rec, { sinceTs: isFirst ? 0 : st.lastTs });
        if (!delta.trim()) { st.lastTs = latestTs; scribeState.set(e.id, st); continue; }
        const text = await summarizeMeeting(prev, delta, isFirst);
        if (text) {
          await saveMeetingNotes(e.id, text);
          if (meetingsView.rec && meetingsView.rec.id === e.id) refreshLiveMeetingView();
        }
        st.lastTs = latestTs;
        scribeState.set(e.id, st);
      } catch { /* skip this meeting this tick, retry next */ }
    }
  } finally {
    scribeBusy = false;
    scheduleLiveNotes({ force: true });
  }
}

// --------------------------------------------------------------------------
// Watch mode — re-read a FIXED tab on an interval and re-run the agent when the
// page changes, so ChatPanel can act on a live page (e.g. post to Slack on change).
// Mirrors the live-notes loop (setTimeout reschedule + busy guard); each run is a
// SINGLE-SHOT agent call so cost stays bounded. The loop is runtime-only; the
// interval/checkbox/instruction persist in settings.ui.watch.
// --------------------------------------------------------------------------
function watchIntervalLabel(ms) {
  return ms % 60000 === 0 ? `${ms / 60000}m` : `${Math.round(ms / 1000)}s`;
}
// The bridge agent answering this conversation (for the "can it act?" helper).
// BYO API agents have no MCP/skills, so the permission note doesn't apply to them.
function currentBridgeAgent() {
  const id = state.conv.agentId || state.settings.activeAgentId;
  const a = (state.settings.agents || []).find((x) => x.id === id);
  return a && a.kind === 'bridge' ? a : null;
}
function timeLabel(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
// Cheap FNV-1a hash of the captured text — detect change without storing the page.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

async function startWatch({ instruction, intervalMs, onlyWhenChanged }) {
  if (state.watch.on) return;
  if (!can(state.license, 'watch')) { upsell('watch'); return; } // Pro feature
  if (!state.activeTab) { toast('No readable tab to watch'); return; }
  const w = state.watch;
  Object.assign(w, {
    on: true,
    busy: false,
    errored: false,
    tabId: state.activeTab.id,
    tabTitle: state.activeTab.title || state.activeTab.url,
    convId: state.conv.id,
    lastHash: null,
    runs: 0,
    instruction: instruction || '',
    intervalMs: intervalMs || 10000,
    onlyWhenChanged: onlyWhenChanged !== false,
  });
  state.settings = await updateSettings({
    ui: { watch: { intervalMs: w.intervalMs, onlyWhenChanged: w.onlyWhenChanged, instruction: w.instruction } },
  });
  appendWatchLog(`Watching “${w.tabTitle}” every ${watchIntervalLabel(w.intervalMs)}`);
  closeMenus();
  renderWatchButton();
  scheduleWatch({ force: true, delayMs: 0 }); // immediate first run for instant feedback
}

function stopWatch({ reason, hard } = {}) {
  const w = state.watch;
  if (!w.on && !w.timer) return;
  clearTimeout(w.timer);
  w.timer = null;
  const was = w.on;
  w.on = false;
  if (hard) state.streams.get(w.convId)?.controller.abort();
  if (was) appendWatchLog(`Watch stopped${reason ? ' — ' + reason : ''}`);
  renderWatchButton();
}

function scheduleWatch({ force = false, delayMs } = {}) {
  const w = state.watch;
  if (!w.on) { clearTimeout(w.timer); w.timer = null; return; }
  if (w.timer && !force) return;
  clearTimeout(w.timer);
  w.timer = setTimeout(runWatchTick, delayMs ?? w.intervalMs);
}

async function runWatchTick() {
  const w = state.watch;
  w.timer = null;
  if (!w.on) return;
  const conv = state.convCache.get(w.convId) || state.conv;
  // Never overlap a manual send or a still-streaming watch run.
  if (w.busy || state.streams.has(conv.id)) {
    scheduleWatch({ force: true, delayMs: Math.min(w.intervalMs, 5000) });
    return;
  }
  if (w.runs >= w.maxRuns) { stopWatch({ reason: `reached ${w.maxRuns} runs` }); return; }
  w.busy = true;
  try {
    const cap = await captureTab(w.tabId);
    const h = hashText(cap.text || '');
    const first = w.lastHash === null;
    const changed = first || h !== w.lastHash;
    w.lastHash = h;
    if (w.onlyWhenChanged && !changed) {
      appendWatchLog('no change');
      scheduleWatch({ force: true });
      return;
    }
    await runWatchRun(conv, cap, first); // reschedules in runWatchStream's finally
    if (w.errored) stopWatch({ reason: 'stopped on error' });
  } catch (e) {
    appendWatchLog(`⚠ ${e.message || e}`);
    stopWatch({ reason: 'stopped on error' });
  } finally {
    w.busy = false;
  }
}

async function runWatchRun(conv, cap, first) {
  const w = state.watch;
  const instr =
    (w.instruction || 'Briefly report what this page shows now.') +
    (first ? '' : '\n\n(The watched page changed since the last check.)');
  const userMsg = { id: uid(), role: 'user', content: instr, attachments: [cap], ts: Date.now(), watch: true };
  conv.messages.push(userMsg);
  if (conv.id === state.conv.id) $('messages').appendChild(renderMessage(userMsg));
  const agent = agentForConv(conv);
  const assistant = makeAssistant(agent);
  assistant.watch = true;
  assistant.watchAt = Date.now();
  conv.messages.push(assistant);
  if (conv.id === state.conv.id) { $('messages').appendChild(renderMessage(assistant)); scrollToBottom(); }
  w.runs += 1;
  renderWatchButton();
  await runWatchStream(agent, assistant, conv, userMsg);
}

// Fork of runStream(): SINGLE-SHOT messages ([userMsg]) instead of full history, and
// it reschedules the watch loop when the turn ends.
async function runWatchStream(agent, assistant, conv, userMsg) {
  const controller = new AbortController();
  state.streams.set(conv.id, { controller, started: Date.now(), lastEvent: '' });
  if (conv.id === state.conv.id) updateComposerUI();
  ensureActivityTimer();
  renderActivity();

  let pending = '';
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (conv.id === state.conv.id) { updateBubble(assistant); scrollToBottom(); }
  };

  try {
    await streamChat({
      agent: resolveTarget(agent, state.settings),
      messages: [userMsg], // single-shot: just this tick's instruction + page capture
      settings: state.settings,
      signal: controller.signal,
      onDelta: (d) => {
        pending += d;
        assistant.content = pending;
        if (!raf) raf = requestAnimationFrame(flush);
      },
      onEvent: (ev) => {
        if (ev.type === 'reasoning' && ev.text) {
          assistant.thinking = (assistant.thinking || '') + ev.text;
          if (!raf) raf = requestAnimationFrame(flush);
        }
        recordActivity(conv.id, ev);
      },
    });
    assistant.content = pending;
  } catch (e) {
    if (e.name === 'AbortError') {
      assistant.content = pending + (pending ? '\n\n_(stopped)_' : '_(stopped)_');
    } else {
      assistant.content = `⚠ ${e.message}`;
      assistant.error = true;
      state.watch.errored = true; // the tick will stop the loop
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    assistant.pending = false;
    state.streams.delete(conv.id);
    ensureActivityTimer();
    if (conv.id === state.conv.id) {
      updateComposerUI();
      renderActivity();
      const node = $('messages').querySelector(`.msg[data-id="${assistant.id}"]`);
      if (node) node.replaceWith(renderMessage(assistant));
    }
    await saveConversation(conv);
    refreshHistory();
    maybeDrainQueue(conv); // answer anything the user queued mid-watch
    if (state.watch.on && !state.watch.errored) scheduleWatch({ force: true });
  }
}

// A compact, dim log row in the watched conversation (role 'watch' is filtered out
// of every model call by providers.js, so it never leaks into a prompt).
function appendWatchLog(text) {
  const conv = state.convCache.get(state.watch.convId) || state.conv;
  const m = { id: uid(), role: 'watch', kind: 'watch-log', content: text, ts: Date.now() };
  conv.messages.push(m);
  if (conv.id === state.conv.id) { $('messages').appendChild(renderMessage(m)); scrollToBottom(); }
  saveConversation(conv);
}

function renderWatchButton() {
  if (typeof renderRail === 'function') renderRail(); // keep the rail 👁 highlight in sync
  const btn = $('btn-watch');
  if (btn) btn.classList.toggle('watching', state.watch.on);
  const status = $('watch-status');
  if (status) {
    status.classList.toggle('hidden', !state.watch.on);
    if (state.watch.on) {
      status.textContent = `Watching every ${watchIntervalLabel(state.watch.intervalMs)} · ${state.watch.runs} run${state.watch.runs === 1 ? '' : 's'}`;
    }
  }
  const start = $('watch-start');
  const stop = $('watch-stop');
  if (start) start.classList.toggle('hidden', state.watch.on);
  if (stop) stop.classList.toggle('hidden', !state.watch.on);
}

function renderWatchMenu() {
  const cfg = (state.settings.ui && state.settings.ui.watch) || {};
  const ms = state.watch.on ? state.watch.intervalMs : cfg.intervalMs || 10000;
  const unit = ms % 60000 === 0 && ms >= 60000 ? 60000 : 1000;
  const nEl = $('watch-interval-n');
  const unitEl = $('watch-interval-unit');
  if (nEl) nEl.value = String(Math.max(1, Math.round(ms / unit)));
  if (unitEl) unitEl.value = String(unit);
  const changed = $('watch-changed');
  if (changed) changed.checked = state.watch.on ? state.watch.onlyWhenChanged : cfg.onlyWhenChanged !== false;
  const instr = $('watch-instruction');
  if (instr) instr.value = state.watch.on ? state.watch.instruction : cfg.instruction || '';
  renderWatchPerm();
  renderWatchButton();
}

// Inline permission helper: a watch agent can only post to Slack/MCP, edit, or run
// shell if its mode is bypassPermissions — otherwise the action is auto-cancelled
// in headless mode. Make that one click instead of a buried Settings trip.
function renderWatchPerm() {
  const el = $('watch-perm');
  if (!el) return;
  const agent = currentBridgeAgent();
  if (!agent) { el.className = 'watch-perm-note'; el.textContent = ''; return; } // BYO API: N/A
  el.innerHTML = '';
  if (agent.permissionMode === 'bypassPermissions') {
    el.className = 'watch-perm-note ok';
    el.textContent = `✓ “${agent.name}” can take actions (Slack/MCP, edits, shell).`;
    return;
  }
  el.className = 'watch-perm-note warn';
  el.append(`⚠ “${agent.name}” can read the page but won't post to Slack/MCP or act until allowed. `);
  const btn = document.createElement('button');
  btn.className = 'watch-btn';
  btn.textContent = 'Allow this agent to act';
  btn.onclick = async () => {
    agent.permissionMode = 'bypassPermissions';
    state.settings = await updateSettings({ agents: state.settings.agents });
    renderWatchPerm();
    toast('Agent can now take actions');
  };
  el.appendChild(btn);
}

// --------------------------------------------------------------------------
// Past Meetings — list + reopen recorded meetings (transcript + saved AI summary).
// Reuses the scribe drawer styles; its own state so a live meeting never conflicts.
// --------------------------------------------------------------------------
const meetingsView = { rec: null, notes: '', tab: 'summary', generating: false, live: false, liveTimer: null };
const PLATFORM_ICON = { zoom: '🟦', meet: '🟩', teams: '🟪', webex: '🟧' };

async function openMeetings() {
  if (!can(state.license, 'liveMeetings')) return upsell('liveMeetings'); // Pro — covers all entry points
  $('meetings-drawer').classList.remove('hidden');
  $('meeting-view').classList.add('hidden');
  $('meetings-list-view').classList.remove('hidden');
  $('meetings-search').value = '';
  await renderMeetingsList('');
}
function closeMeetings() { clearInterval(meetingsView.liveTimer); $('meetings-drawer').classList.add('hidden'); renderRail(); }

async function renderMeetingsList(query) {
  const list = $('meetings-list');
  let index = [];
  try { index = await getMeetingIndex(); } catch { /* none */ }
  const q = (query || '').trim().toLowerCase();
  index = index
    .filter((e) => !q || (e.title || '').toLowerCase().includes(q))
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
  if (!index.length) {
    list.innerHTML = '<div class="empty-notes">No meetings yet. Join a Zoom/Meet/Teams/Webex call with captions on and ChatPanel records the transcript.</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of index) {
    const live = e.status !== 'ended';
    const dur = e.endedAt && e.startedAt ? Math.round((e.endedAt - e.startedAt) / 60000) : 0;
    const meta = [relAgo(e.endedAt || e.startedAt), dur ? `${dur}m` : '', `${e.lines || 0} lines`, live ? '· live' : '']
      .filter(Boolean).join(' · ');
    const row = document.createElement('div');
    row.className = 'meeting-row';
    const main = document.createElement('button');
    main.className = 'meeting-row-main';
    main.innerHTML =
      `<div class="meeting-row-title">${PLATFORM_ICON[e.platform] || '🎙'} ${escHtml(e.title || 'Meeting')}</div>` +
      `<div class="meeting-row-meta">${escHtml(meta)}</div>`;
    main.onclick = () => openStoredMeeting(e.id);
    const del = miniBtn('✕', async () => {
      await deleteMeeting(e.id);
      renderMeetingsList($('meetings-search').value);
      toast('Meeting deleted');
    });
    del.title = 'Delete meeting';
    del.className = 'mini-btn meeting-row-del';
    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  }
}

async function openStoredMeeting(id) {
  const rec = await getMeeting(id);
  if (!rec) { toast('Meeting not found'); return; }
  clearInterval(meetingsView.liveTimer);
  meetingsView.rec = rec;
  meetingsView.notes = await getMeetingNotes(id).catch(() => '');
  meetingsView.generating = false;
  meetingsView.live = rec.status !== 'ended';
  $('meeting-view-title').textContent =
    `${PLATFORM_ICON[rec.platform] || '🎙'} ${rec.title || 'Meeting'}${meetingsView.live ? ' · live' : ''}`;
  $('meetings-list-view').classList.add('hidden');
  $('meeting-view').classList.remove('hidden');
  switchMeetingTab('summary');
  // Live meeting → keep the view fresh (transcript + summary) while open.
  if (meetingsView.live) meetingsView.liveTimer = setInterval(refreshLiveMeetingView, 5000);
}

// Re-read the currently-viewed live meeting from storage and re-render (called on a
// timer while viewing a live meeting, and by the scribe loop right after it saves).
async function refreshLiveMeetingView() {
  const cur = meetingsView.rec;
  if (!cur) return;
  // For the live meeting, read the FRESH in-memory record (real-time even when its
  // tab is backgrounded); else the persisted record.
  const rec =
    state.liveMeeting && state.liveMeeting.id === cur.id
      ? (await getLiveMeetingRecord()) || (await getMeeting(cur.id))
      : await getMeeting(cur.id);
  if (!rec) return;
  meetingsView.rec = rec;
  meetingsView.notes = await getMeetingNotes(cur.id).catch(() => meetingsView.notes);
  meetingsView.live = rec.status !== 'ended';
  if (meetingsView.tab === 'transcript') renderMeetingTranscript();
  else if (!meetingsView.generating) renderMeetingSummary();
  setMeetingViewStatus();
  if (!meetingsView.live) clearInterval(meetingsView.liveTimer);
}

// Get the FRESHEST record for the live meeting. Background tabs throttle the
// content script's storage flush, so the persisted record lags — but the in-memory
// buffer (read via a message to the tab, which works even when backgrounded) is
// real-time. Find the meeting's tab and read it live; fall back to storage.
async function getLiveMeetingRecord() {
  if (!state.liveMeeting) return null;
  const id = state.liveMeeting.id;
  const tryTab = async (tabId) => {
    if (tabId == null) return null;
    try { const r = await getMeetingRecord(tabId); return r && r.id === id ? r : null; } catch { return null; }
  };
  let rec = await tryTab(state.liveMeeting.tabId); // cached from a prior lookup
  if (!rec) {
    try {
      const tabs = await listTabs({ currentWindowOnly: false }); // meeting may be in another window
      for (const t of tabs) {
        if (!meetingPlatform(t.url || '')) continue;
        const r = await getMeetingRecord(t.id);
        if (r && r.id === id) { rec = r; state.liveMeeting.tabId = t.id; break; }
      }
    } catch { /* fall through */ }
  }
  if (!rec) rec = await getMeeting(id); // last resort: persisted (may lag when backgrounded)
  return rec;
}

// "View" on the meeting bar → open the active tab's meeting in the unified viewer.
async function viewActiveMeeting(tabId) {
  const rec = await getMeetingRecord(tabId);
  if (!rec?.id) { toast('No transcript captured yet'); return; }
  $('meetings-drawer').classList.remove('hidden');
  await openStoredMeeting(rec.id);
}

// Attach the viewed meeting's transcript as context and focus the composer, so the
// user can ask about it from ANY tab.
function askAboutMeeting() {
  const rec = meetingsView.rec;
  if (!rec) return;
  const transcript = meetingToText(rec, { sinceTs: 0 });
  const notes = meetingsView.notes || '';
  let body = (notes ? `SUMMARY:\n${notes}\n\n` : '') + 'TRANSCRIPT:\n';
  const room = Math.max(2000, 40000 - body.length);
  body += transcript.length > room ? '…' + transcript.slice(-room) : transcript;
  state.attachments = state.attachments || [];
  state.attachments = state.attachments.filter((a) => !(typeof a.id === 'string' && a.id.startsWith(`mtg_${rec.id}`)));
  state.attachments.unshift({
    id: `mtg_${rec.id}_${Date.now()}`,
    kind: 'meeting',
    title: `🎙 ${rec.title || 'Meeting'}`,
    url: rec.url || '',
    text: body,
    chars: body.length,
  });
  closeMeetings();
  renderContextBar();
  $('input').focus();
  toast('Meeting attached — ask your question');
}

// Slim "N meetings recording" strip, shown from any non-meeting tab.
async function renderScribeIndicator(liveOpt) {
  let live = liveOpt;
  if (!live) {
    try { live = (await getMeetingIndex()).filter((e) => e.status !== 'ended'); } catch { live = []; }
  }
  // Drop + finalize "zombie" meetings: a live entry whose heartbeat (persistedAt)
  // went stale means its tab/content script is gone (call left, tab closed), so it
  // never flips to ended on its own. Finalize it so it stops auto-attaching/showing.
  // (No persistedAt = pre-heartbeat record → also treat as stale.)
  const now = Date.now();
  const ZOMBIE_MS = 90_000;
  const fresh = [];
  for (const e of live) {
    if (e.persistedAt && now - e.persistedAt < ZOMBIE_MS) fresh.push(e);
    else markMeetingEnded(e.id).catch(() => {});
  }
  live = fresh;

  // Cache the most-recent live meeting so it can auto-attach + show a context chip
  // from ANY tab. When it starts/changes/ends, refresh the context bar.
  const top = [...live].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  const prevId = state.liveMeeting && state.liveMeeting.id;
  const prevTabId = state.liveMeeting && state.liveMeeting.tabId;
  state.liveMeeting = top ? { id: top.id, title: top.title, tabId: top.id === prevId ? prevTabId : undefined } : null;
  if ((state.liveMeeting && state.liveMeeting.id) !== prevId) renderContextBar();

  const el = $('scribe-indicator');
  if (!el) return;
  const onMeetingTab = state.activeTab && meetingPlatform(state.activeTab.url || '');
  if (live.length && !onMeetingTab) {
    el.classList.remove('hidden');
    el.textContent = `🎙 ${live.length} meeting${live.length === 1 ? '' : 's'} recording — view`;
  } else {
    el.classList.add('hidden');
  }
}

function meetingBackToList() {
  clearInterval(meetingsView.liveTimer);
  $('meeting-view').classList.add('hidden');
  $('meetings-list-view').classList.remove('hidden');
  renderMeetingsList($('meetings-search').value);
}

// --------------------------------------------------------------------------
// Right icon rail — a pluggable home for panes (Meetings, Watch; future: Skills,
// graph-viz). Add a pane with registerPane({ id, icon, title, open, isOpen, pro? }).
// --------------------------------------------------------------------------
const RAIL_PANES = [
  { id: 'meetings', icon: '🎙', label: 'Meet', title: 'Meetings — live & past', pro: 'liveMeetings', open: openMeetings,
    isOpen: () => !$('meetings-drawer').classList.contains('hidden') },
  { id: 'watch', icon: '👁', label: 'Watch', title: 'Watch this page & act', pro: 'watch', open: openWatchPane,
    isOpen: () => !$('watch-menu').classList.contains('hidden') },
];
function registerPane(p) { RAIL_PANES.push(p); renderRail(); }

function safePaneOpen(p) { try { return p.isOpen ? p.isOpen() : false; } catch { return false; } }
function closePane(p) {
  if (p.id === 'meetings') closeMeetings();
  else if (p.id === 'watch') $('watch-menu').classList.add('hidden');
  else if (p.close) p.close();
}
function renderRail() {
  const rail = $('rail');
  if (!rail) return;
  rail.innerHTML = '';
  for (const p of RAIL_PANES) {
    const btn = document.createElement('button');
    const active = safePaneOpen(p) || (p.id === 'watch' && state.watch.on); // 👁 stays lit while watching
    btn.className = 'rail-btn' + (active ? ' active' : '');
    const ico = document.createElement('span');
    ico.className = 'rail-ico';
    ico.textContent = p.icon;
    btn.appendChild(ico);
    if (p.label) {
      const lab = document.createElement('span');
      lab.className = 'rail-label';
      lab.textContent = p.label;
      btn.appendChild(lab);
    }
    btn.title = p.title;
    btn.onclick = (e) => {
      e.stopPropagation(); // don't let the body click close the popover we just opened
      if (p.pro && !can(state.license, p.pro)) return upsell(p.pro); // Pro-gated pane
      if (safePaneOpen(p)) closePane(p);
      else { RAIL_PANES.forEach((q) => q !== p && safePaneOpen(q) && closePane(q)); p.open(); }
      renderRail();
    };
    rail.appendChild(btn);
  }
}
function openWatchPane() {
  if (!can(state.license, 'watch')) return upsell('watch');
  closeMenus();
  renderWatchMenu();
  $('watch-menu').classList.remove('hidden');
}
function toggleRail() {
  const collapsed = document.body.classList.toggle('rail-collapsed');
  const t = $('rail-toggle');
  if (t) {
    t.textContent = collapsed ? '›' : '‹';
    t.title = collapsed ? 'Show panel rail' : 'Collapse panel rail';
  }
  updateSettings({ ui: { railCollapsed: collapsed } }).then((s) => (state.settings = s)).catch(() => {});
}

function switchMeetingTab(tab) {
  meetingsView.tab = tab;
  const isT = tab === 'transcript';
  $('mv-tab-summary').classList.toggle('active', !isT);
  $('mv-tab-transcript').classList.toggle('active', isT);
  $('meeting-summary').classList.toggle('hidden', isT);
  $('meeting-transcript').classList.toggle('hidden', !isT);
  $('meeting-search').classList.toggle('hidden', !isT);
  if (isT) renderMeetingTranscript(); else renderMeetingSummary();
  setMeetingViewStatus();
}

function renderMeetingSummary() {
  const body = $('meeting-summary');
  if (meetingsView.notes) { body.innerHTML = renderMarkdown(meetingsView.notes); return; }
  body.innerHTML = '<div class="empty-notes">No summary was saved for this meeting.</div>';
  const btn = document.createElement('button');
  btn.className = 'watch-btn primary';
  btn.style.margin = '8px 12px';
  btn.textContent = 'Generate summary';
  btn.onclick = () => generateMeetingSummary();
  body.appendChild(btn);
}

function renderMeetingTranscript() {
  const body = $('meeting-transcript');
  const q = ($('meeting-search').value || '').trim().toLowerCase();
  const lines = meetingToText(meetingsView.rec, { sinceTs: 0 }).split('\n').filter((l) => l.trim());
  if (!lines.length) { body.innerHTML = '<div class="empty-notes">No transcript captured.</div>'; return; }
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  if (!shown.length) { body.innerHTML = `<div class="empty-notes">No lines match “${escHtml(q)}”.</div>`; return; }
  const hi = (t) => {
    if (!q) return escHtml(t);
    const i = t.toLowerCase().indexOf(q);
    return i < 0 ? escHtml(t) : escHtml(t.slice(0, i)) + '<mark>' + escHtml(t.slice(i, i + q.length)) + '</mark>' + escHtml(t.slice(i + q.length));
  };
  body.innerHTML = shown.map((l) => `<div class="ln-line">${hi(l)}</div>`).join('');
}

function setMeetingViewStatus() {
  const el = $('meeting-view-status');
  if (!el || !meetingsView.rec) return;
  if (meetingsView.tab === 'transcript') {
    const n = meetingToText(meetingsView.rec, { sinceTs: 0 }).split('\n').filter((l) => l.trim()).length;
    el.textContent = `${n} line${n === 1 ? '' : 's'}`;
  } else {
    el.textContent = relAgo(meetingsView.rec.endedAt || meetingsView.rec.startedAt);
  }
}

async function generateMeetingSummary() {
  if (meetingsView.generating || !meetingsView.rec) return;
  meetingsView.generating = true;
  const body = $('meeting-summary');
  body.innerHTML = '<div class="empty-notes">Generating summary…</div>';
  const transcript = meetingToText(meetingsView.rec, { sinceTs: 0 });
  const agent = agentForConv(state.conv);
  let text = '';
  try {
    await streamChat({
      agent: resolveTarget(agent, state.settings),
      messages: [{
        role: 'user',
        content: `Summarize this meeting transcript as concise markdown notes — a short summary, key decisions, and action items with owners.\n\n---\n${transcript}`,
      }],
      settings: state.settings,
      onDelta: (d) => { text += d; body.innerHTML = renderMarkdown(text); body.scrollTop = body.scrollHeight; },
    });
    meetingsView.notes = text.trim();
    await saveMeetingNotes(meetingsView.rec.id, meetingsView.notes);
    renderMeetingSummary();
    toast('Summary saved');
  } catch (e) {
    body.innerHTML = `<div class="empty-notes">⚠ ${escHtml(e.message || String(e))}</div>`;
  } finally {
    meetingsView.generating = false;
  }
}

function copyMeetingActive() {
  const t = meetingsView.tab === 'transcript' ? meetingToText(meetingsView.rec, { sinceTs: 0 }) : meetingsView.notes;
  navigator.clipboard.writeText(t || '').then(() => toast('Copied')).catch(() => {});
}
function downloadMeetingActive() {
  const rec = meetingsView.rec;
  if (!rec) return;
  const base = (rec.title || 'meeting').replace(/[^\w]+/g, '_').slice(0, 50) || 'meeting';
  if (meetingsView.tab === 'transcript') downloadText(`${base}_transcript.txt`, meetingToText(rec, { sinceTs: 0 }), 'text/plain');
  else if (meetingsView.notes) downloadText(`${base}_notes.md`, meetingsView.notes, 'text/markdown');
  else downloadText(`${base}.md`, meetingToMarkdown(rec), 'text/markdown');
  toast('Downloaded');
}

// Run the agent to produce/merge the running notes, streaming into the drawer.
// Produce/merge a meeting's running notes from `prevNotes` + the new transcript
// delta. Headless — returns the merged markdown (the scribe loop saves it to
// storage; viewers read it from there). No drawer/UI coupling.
async function summarizeMeeting(prevNotes, deltaText, isFirst) {
  const agent = getTarget(state.settings, state.settings.activeAgentId);
  const prompt = isFirst
    ? `${meetingNotesSkill().prompt}\n\n--- MEETING TRANSCRIPT SO FAR ---\n${deltaText}`
    : [
        'You are a live meeting scribe maintaining ONE running minutes document.',
        'Update the CURRENT running notes by merging in the NEW transcript below — do not start over.',
        'Rules: keep the same sections (TL;DR, Topics, Key Moments tagged [decision]/[highlight]/[risk]/[question], Action Items with owners/dues). Merge new items into the right place; refine or correct earlier entries if the new transcript clarifies them; never duplicate; keep stable items stable. Output ONLY the complete updated document.',
        '',
        '--- CURRENT RUNNING NOTES ---',
        prevNotes,
        '',
        '--- NEW TRANSCRIPT SINCE LAST UPDATE ---',
        deltaText,
      ].join('\n');

  let out = '';
  await streamChat({
    agent,
    messages: [{ role: 'user', content: prompt }],
    settings: state.settings,
    onDelta: (d) => { out += d; },
  });
  return out.trim();
}

function liveNotesDrawerOpen() {
  return !$('live-notes-drawer').classList.contains('hidden');
}

// Summary tab (rendered markdown). Kept as renderLiveNotesBody so the streaming
// merge can call it on each delta.
function renderLiveNotesBody(text) {
  const body = $('live-notes-summary');
  if (!body) return;
  body.innerHTML = text
    ? renderMarkdown(text)
    : '<div class="empty-notes">No summary yet. Turn on 📝 Live (or send a /notes message) to generate one.</div>';
}

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Transcript tab — one line per segment, optionally filtered+highlighted by the
// search box. Speaker is dimmed so the spoken text reads cleanly.
function renderTranscript() {
  const body = $('live-notes-transcript');
  if (!body) return;
  const q = ($('live-notes-search').value || '').trim().toLowerCase();
  const lines = (liveNotes.transcript || '').split('\n').filter((l) => l.trim());
  if (!lines.length) {
    body.innerHTML = '<div class="empty-notes">No transcript captured yet — make sure captions are on.</div>';
    return;
  }
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  if (!shown.length) {
    body.innerHTML = `<div class="empty-notes">No lines match “${escHtml(q)}”.</div>`;
    return;
  }
  const hi = (text) => {
    if (!q) return escHtml(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return escHtml(text);
    return escHtml(text.slice(0, i)) + '<mark>' + escHtml(text.slice(i, i + q.length)) + '</mark>' + escHtml(text.slice(i + q.length));
  };
  body.innerHTML = shown.map((l) => `<div class="ln-line">${hi(l)}</div>`).join('');
}

// Pull the full transcript from the capturing frame into liveNotes.transcript.
async function refreshTranscript() {
  const tab = state.activeTab;
  if (!tab) return;
  try {
    const rec = await getMeetingRecord(tab.id);
    if (rec) {
      liveNotes.transcript = meetingToText(rec, { sinceTs: 0 });
      liveNotes.title = rec.title || 'Meeting';
    }
  } catch {
    /* leave the last transcript in place */
  }
}

function relAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function setLiveNotesStatus(override) {
  const el = $('live-notes-status');
  if (!el) return;
  if (override) { el.textContent = override; return; }
  if (liveNotes.tab === 'transcript') {
    const n = (liveNotes.transcript || '').split('\n').filter((l) => l.trim()).length;
    el.textContent = `${n} line${n === 1 ? '' : 's'}`;
    return;
  }
  const iv = liveNotesIntervalMin();
  el.textContent = `${iv ? `every ${iv}m · ` : 'off · '}updated ${relAgo(liveNotes.updatedAt)}`;
}

function switchLiveNotesTab(tab) {
  liveNotes.tab = tab;
  const isT = tab === 'transcript';
  $('ln-tab-summary').classList.toggle('active', !isT);
  $('ln-tab-transcript').classList.toggle('active', isT);
  $('live-notes-summary').classList.toggle('hidden', isT);
  $('live-notes-transcript').classList.toggle('hidden', !isT);
  $('live-notes-search').classList.toggle('hidden', !isT);
  if (isT) renderTranscript();
  else renderLiveNotesBody(liveNotes.text);
  setLiveNotesStatus();
}

async function openLiveNotes() {
  $('live-notes-drawer').classList.remove('hidden');
  await refreshTranscript();
  switchLiveNotesTab(liveNotes.tab);
  // Keep the transcript live while the drawer is open (independent of the summary
  // interval, so the Transcript tab updates even with Live notes off).
  clearInterval(liveNotes.transcriptTimer);
  liveNotes.transcriptTimer = setInterval(async () => {
    if (!liveNotesDrawerOpen()) return;
    await refreshTranscript();
    if (liveNotes.tab === 'transcript') { renderTranscript(); setLiveNotesStatus(); }
  }, 5000);
}
function closeLiveNotes() {
  $('live-notes-drawer').classList.add('hidden');
  clearInterval(liveNotes.transcriptTimer);
  liveNotes.transcriptTimer = null;
}

// Download the active tab: Summary → .md, Transcript → .txt.
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function liveNotesFileBase() {
  return (liveNotes.title || 'meeting').replace(/[^\w.-]+/g, '_').slice(0, 50);
}
function downloadLiveNotesActive() {
  if (liveNotes.tab === 'transcript') {
    if (!liveNotes.transcript) return toast('No transcript yet');
    downloadText(`${liveNotesFileBase()}_transcript.txt`, liveNotes.transcript, 'text/plain');
  } else {
    if (!liveNotes.text) return toast('No summary yet');
    downloadText(`${liveNotesFileBase()}_notes.md`, liveNotes.text, 'text/markdown');
  }
  toast('Downloaded');
}
function copyLiveNotesActive() {
  const text = liveNotes.tab === 'transcript' ? liveNotes.transcript : liveNotes.text;
  navigator.clipboard.writeText(text || '').then(() => toast('Copied')).catch(() => {});
}

async function renderMeetingBar() {
  const bar = $('meeting-bar');
  const tab = state.activeTab;
  const platform = tab && meetingPlatform(tab.url || '');
  if (!platform) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const seq = ++_meetingBarSeq;
  const label = MEETING_LABELS[platform] || platform;
  const probe = await probeMeeting(tab.id); // null if the content script isn't loaded
  if (seq !== _meetingBarSeq) return; // a newer render superseded us

  // Brand the bar as the scribe rather than a "recording" — we read live captions,
  // not audio/video, so no red dot.
  const scribe = `ChatPanel ${MEETING_SHORT[platform] || label} Scribe`;
  const render = (text, buttons = []) => {
    bar.classList.remove('hidden');
    bar.innerHTML = '';
    const logo = document.createElement('img');
    logo.className = 'meeting-logo';
    logo.src = 'assets/icon16.png';
    logo.alt = '';
    const span = document.createElement('span');
    span.className = 'meeting-text';
    span.textContent = text;
    bar.append(logo, span);
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'meeting-btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      bar.appendChild(btn);
    }
  };

  // Content script not responding → the tab loaded before the extension did.
  if (!probe?.ok) {
    render(`${scribe} · reload the tab to enable`, [
      { label: 'Reload', onClick: () => chrome.tabs.reload(tab.id) },
    ]);
    return;
  }
  // Platform recognised but adapter not implemented yet.
  if (probe.ready === false) {
    render(`${scribe} · coming soon`);
    return;
  }
  // Gated behind Pro.
  if (!can(state.license, 'liveMeetings')) {
    render(`${scribe} · Pro`, [
      { label: '✨ Upgrade', primary: true, onClick: () => upsell('liveMeetings') },
    ]);
    return;
  }
  // Pro + active. Capture is auto-included on every message; controls are the live
  // notes interval, the rolling window, and Stop.
  const key = probe.meetingKey || tab.url;
  if (probe.capturing) {
    const iv = liveNotesIntervalMin();
    render(scribe, [
      { label: '📄 View', onClick: () => viewActiveMeeting(tab.id) },
      { label: `📝 Live ${iv ? iv + 'm' : 'Off'}`, onClick: cycleLiveNotesInterval },
      { label: `🕑 ${meetingWindowLabel()}`, onClick: cycleMeetingWindow },
      {
        label: 'Stop',
        primary: true,
        onClick: async () => {
          _autoStartSuppressed.add(key); // don't auto-restart after an explicit stop
          await stopMeeting(tab.id); // flips status→ended; the scribe loop then skips it
          renderMeetingBar();
        },
      },
    ]);
    scheduleLiveNotes(); // ensure the global scribe loop is armed (idempotent)
    return;
  }
  // Not capturing on THIS tab — but the global scribe loop keeps running for any
  // OTHER live meetings, so we intentionally do not stop it here.

  // Not capturing: auto-start the moment we see a ready meeting tab, so the user
  // never has to click Start — unless they explicitly Stopped this meeting.
  if (!_autoStartSuppressed.has(key)) {
    await startMeeting(tab.id);
    if (seq !== _meetingBarSeq) return;
    toast('🎙 Meeting notes started — ask away, the transcript rides along');
    return renderMeetingBar();
  }

  // Suppressed (user Stopped) — offer a manual restart.
  const capsHint = probe.live ? 'captions on' : 'turn on captions';
  render(`${scribe} · paused · ${capsHint}`, [
    {
      label: 'Start',
      primary: true,
      onClick: async () => {
        _autoStartSuppressed.delete(key);
        await startMeeting(tab.id);
        renderMeetingBar();
        toast('Scribe on — ask away, the transcript rides along automatically');
      },
    },
  ]);
}

async function addAttachment(producer) {
  // Enforce free-tier attachment limit.
  if (
    state.attachments.length >= FREE_LIMITS.attachmentsPerMessage &&
    !can(state.license, 'multiTab')
  ) {
    return upsell('multiTab');
  }
  try {
    toast('Reading…');
    const att = await producer();
    state.attachments.push(att);
    renderContextBar();
    toast(`Attached: ${att.title}`);
  } catch (e) {
    toast('⚠ ' + e.message, 2600);
  }
}

async function autoAttachUrls(text) {
  const urls = [...new Set((text.match(/https?:\/\/[^\s)]+/gi) || []))].slice(0, 3);
  for (const url of urls) {
    if (state.attachments.find((a) => a.url === url)) continue;
    // First URL is free; additional ones need Pro (multi-context).
    if (state.attachments.length >= FREE_LIMITS.attachmentsPerMessage && !can(state.license, 'multiTab')) break;
    try {
      const att = await captureUrl(url);
      state.attachments.push(att);
    } catch {
      /* leave the bare URL in the text */
    }
  }
  renderContextBar();
}

// "Whole-window context" (Pro): grab every readable tab in the current window in
// one shot. Capped so we don't blow past a model's context window.
const WINDOW_TAB_CAP = 10;
async function attachWholeWindow() {
  if (!can(state.license, 'multiTab')) return upsell('multiTab');
  const all = (await listTabs({ currentWindowOnly: true })).filter(
    (t) => !state.attachments.some((a) => a.url === t.url),
  );
  const targets = all.slice(0, WINDOW_TAB_CAP);
  if (!targets.length) return toast('No new tabs to attach in this window');
  toast(`Reading ${targets.length} tab${targets.length === 1 ? '' : 's'}…`, 4000);
  const results = await Promise.allSettled(targets.map((t) => captureTab(t.id)));
  let n = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      state.attachments.push(r.value);
      n++;
    }
  }
  renderContextBar();
  const extra = all.length > WINDOW_TAB_CAP ? ` (first ${WINDOW_TAB_CAP} of ${all.length})` : '';
  toast(n ? `Attached ${n} tab${n === 1 ? '' : 's'}${extra}` : 'Could not read those tabs', 2600);
}

function renderContextBar() {
  const bar = $('context-bar');
  bar.innerHTML = '';
  const showPage = state.usePage && state.activeTab;
  const showMeeting = !!state.liveMeeting && state.excludedMeetingId !== state.liveMeeting.id;
  if (!state.attachments.length && !showPage && !showMeeting) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // Live meeting chip — its transcript is read fresh from the DB and included on
  // EVERY message, from any tab, until you dismiss it (then it stays off for this
  // meeting). No navigating to a button.
  if (showMeeting) {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip page-chip';
    chip.title = 'Live meeting transcript — included on every message (read fresh each send)';
    chip.innerHTML = `<span class="ctx-kind">🎙</span><span class="ctx-title">${escapeAttr(
      (state.liveMeeting.title || 'Meeting') + ' · live',
    )}</span>`;
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.textContent = '✕';
    x.title = 'Stop including this meeting';
    x.onclick = () => {
      state.excludedMeetingId = state.liveMeeting.id;
      renderContextBar();
      toast('Meeting context off for this meeting');
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  }

  // The "live page" chip: the current tab, auto-included and read fresh at send.
  if (showPage) {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip page-chip';
    chip.title = `This page is included as context — ${state.activeTab.url}`;
    chip.innerHTML = `<span class="ctx-kind">🌐</span><span class="ctx-title">${escapeAttr(
      state.activeTab.title,
    )}</span>`;
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.textContent = '✕';
    x.title = 'Stop including this page';
    x.onclick = () => {
      state.usePage = false;
      renderContextBar();
      toast('Page context off — add it back with 📎');
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  }

  state.attachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    const kind = { page: '🗎', url: '🔗', selection: '✂️' }[att.kind] || '📎';
    chip.innerHTML = `<span class="ctx-kind">${kind}</span><span class="ctx-title">${escapeAttr(
      att.title || att.url,
    )}</span>`;
    const x = document.createElement('button');
    x.className = 'ctx-x';
    x.textContent = '✕';
    x.onclick = () => {
      state.attachments.splice(i, 1);
      renderContextBar();
    };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
}

async function renderAttachMenu() {
  const menu = $('attach-menu');
  menu.innerHTML = '';
  // Toggle for auto-including the current page (the default behavior).
  const toggle = actionItem(state.usePage ? '✅' : '⬜️', 'Include this page automatically', () => {
    state.usePage = !state.usePage;
    refreshActiveTab();
    toast(state.usePage ? 'This page will be included' : 'Page context off');
  });
  menu.appendChild(toggle);
  menu.appendChild(actionItem('🗎', 'Current tab (once)', () => addAttachment(() => captureActiveTab())));
  menu.appendChild(actionItem('✂️', 'Current selection', () => addAttachment(() => captureSelection())));
  // Whole-window context (Pro): attach every readable tab in this window at once.
  const proWindow = can(state.license, 'multiTab');
  menu.appendChild(
    actionItem('🪟', `All tabs in this window${proWindow ? '' : ' — Pro'}`, () => attachWholeWindow()),
  );

  // Live meeting transcript (Pro) — only shown when the active tab is a meeting.
  if (state.activeTab && meetingPlatform(state.activeTab.url || '')) {
    const proMeet = can(state.license, 'liveMeetings');
    menu.appendChild(
      actionItem('🎙', `Live meeting transcript${proMeet ? '' : ' — Pro'}`, () => {
        if (!proMeet) return upsell('liveMeetings');
        addAttachment(() => captureMeetingTranscript(state.activeTab.id));
      }),
    );
  }

  // URL input
  const urlWrap = document.createElement('div');
  urlWrap.style.padding = '6px 8px';
  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.placeholder = 'Paste a URL to analyze…';
  urlInput.style.cssText =
    'width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);color:var(--text);';
  urlInput.onkeydown = (e) => {
    if (e.key === 'Enter' && urlInput.value.trim()) {
      const v = urlInput.value.trim();
      closeMenus();
      addAttachment(() => captureUrl(v));
    }
  };
  urlWrap.appendChild(urlInput);
  menu.appendChild(urlWrap);

  menu.appendChild(sectionLabel('Open tabs'));
  const tabs = await listTabs();
  for (const t of tabs.slice(0, 25)) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    const fav = t.favIconUrl
      ? `<img src="${escapeAttr(t.favIconUrl)}" width="14" height="14" style="border-radius:3px"/>`
      : '🗎';
    item.innerHTML = `${fav}<span class="ctx-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeAttr(
      t.title,
    )}</span>`;
    item.onclick = () => {
      closeMenus();
      addAttachment(() => captureTab(t.id));
    };
    menu.appendChild(item);
  }
  if (!can(state.license, 'multiTab')) {
    const hint = document.createElement('div');
    hint.className = 'menu-section';
    hint.textContent = 'Pro: attach several tabs at once';
    menu.appendChild(hint);
  }
}

// --------------------------------------------------------------------------
// Skills
// --------------------------------------------------------------------------
function renderSkillsMenu() {
  const menu = $('skills-menu');
  menu.innerHTML = '';
  menu.appendChild(sectionLabel('Skills'));
  for (const skill of state.settings.skills) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.innerHTML = `<span>${skill.icon || '⚡'}</span><span>${escapeAttr(skill.name)}</span><span class="mi-sub">/${escapeAttr(
      skill.command || '',
    )}</span>`;
    item.onclick = () => {
      applySkill(skill);
      closeMenus();
    };
    menu.appendChild(item);
  }
  const manage = document.createElement('button');
  manage.className = 'menu-item';
  manage.innerHTML = '⚙ <span>Manage skills…</span>';
  manage.onclick = () => chrome.runtime.openOptionsPage();
  menu.appendChild(manage);
}

// Apply a skill from the ⚡ menu: prep agent/context, fill variables, drop the
// prompt into the composer for the user to review and send.
async function applySkill(skill) {
  const input = $('input');
  await applySkillPrep(skill);
  const text = await substituteVars(skill.prompt, { args: '' });
  input.value = text + (input.value ? '\n\n' + input.value : '');
  autoGrow();
  input.focus();
}

// Per-skill agent + context: switch the conversation's agent and attach the
// context the skill declares (page / selection / all-tabs / none / auto).
async function applySkillPrep(skill) {
  if (skill.agentId && getTarget(state.settings, skill.agentId)) {
    state.conv.agentId = skill.agentId;
    state.settings.activeAgentId = skill.agentId;
    updateSettings({ activeAgentId: skill.agentId });
    renderAgentName();
  }
  switch (skill.context || 'auto') {
    case 'none':
      state.usePage = false;
      renderContextBar();
      break;
    case 'page':
      state.usePage = true;
      renderContextBar();
      break;
    case 'selection':
      await addAttachment(() => captureSelection()).catch(() => {});
      break;
    case 'tabs':
      await attachWholeWindow();
      break;
    default: // 'auto' — leave the current page/attachment behavior as-is.
      break;
  }
}

// Fill {{placeholders}} in a skill prompt. {{input}} (and {{input:label}}) take
// the text typed after the command; {{url}}/{{title}}/{{date}} are sync; only
// {{selection}} costs a tab read, and only when present.
async function substituteVars(text, { args = '' } = {}) {
  if (!text.includes('{{')) return text;
  let out = text
    .replace(/\{\{\s*input(?::[^}]*)?\s*\}\}/gi, args || '')
    .replace(/\{\{\s*url\s*\}\}/gi, state.activeTab?.url || '')
    .replace(/\{\{\s*title\s*\}\}/gi, state.activeTab?.title || '')
    .replace(/\{\{\s*date\s*\}\}/gi, new Date().toLocaleDateString());
  if (/\{\{\s*selection\s*\}\}/i.test(out)) {
    let sel = '';
    try {
      sel = (await captureSelection()).text || '';
    } catch {
      /* nothing selected */
    }
    out = out.replace(/\{\{\s*selection\s*\}\}/gi, sel);
  }
  return out;
}

// ✨ Improve the composer's draft with the user's configured model, streamed in.
async function improvePrompt() {
  const input = $('input');
  const btn = $('btn-assist');
  if (btn.disabled) return;
  const before = input.value;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '⏳';
  let streamed = false;
  try {
    await assistPrompt({
      draft: before,
      settings: state.settings,
      onDelta: (full) => {
        streamed = true;
        input.value = full;
        autoGrow();
      },
    });
    input.focus();
  } catch (e) {
    // Only roll back if nothing streamed — keep a good (or partial) result even
    // if the model throws a late/benign error after the text already arrived.
    if (streamed && input.value.trim()) {
      toast('⚠ ' + e.message, 2600);
      input.focus();
    } else {
      input.value = before;
      toast('✕ ' + e.message, 2800);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Skills (the ⚡ menu, /commands, suggestions) are a Pro feature.
function skillsAllowed() {
  return can(state.license, 'customSkills');
}

// Lightweight, free, instant: suggest the skill whose name/command/description
// best matches what the user is typing.
let suggestSuppressed = false;
function suggestSkill(text) {
  if (!skillsAllowed()) return null; // no skills for Free users
  const t = (text || '').toLowerCase().trim();
  if (t.length < 8 || t.startsWith('/')) return null;
  const words = new Set(t.split(/\W+/).filter((w) => w.length > 3));
  let best = null;
  let bestScore = 0;
  for (const skill of state.settings.skills || []) {
    const hay = `${skill.name} ${skill.command} ${skill.description || ''}`.toLowerCase();
    const keys = hay.split(/\W+/).filter((w) => w.length > 3);
    let score = 0;
    for (const w of words) if (keys.includes(w)) score += 1;
    for (const k of keys) if (t.includes(k)) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= 1.5 ? best : null;
}

function renderSuggest() {
  const box = $('skill-suggest');
  const skill = suggestSuppressed ? null : suggestSkill($('input').value);
  if (!skill) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '';
  const chip = document.createElement('button');
  chip.className = 'suggest-chip';
  chip.innerHTML = `💡 Use <b>/${escapeAttr(skill.command)}</b> — ${escapeAttr(skill.description || skill.name)}`;
  chip.onclick = () => {
    box.classList.add('hidden');
    applySkill(skill);
  };
  const x = document.createElement('button');
  x.className = 'suggest-x';
  x.textContent = '✕';
  x.title = 'Dismiss';
  x.onclick = () => {
    suggestSuppressed = true;
    box.classList.add('hidden');
  };
  box.append(chip, x);
  box.classList.remove('hidden');
}

// Slash menu — typing "/" (then a partial command) shows a filterable dropdown
// of skills, like a command palette. Selecting one completes "/command " in the
// composer so the user can add args and send (the /command is parsed on send).
// Reuses the #skill-suggest box (rendered as a list in `slash-menu` mode).
let slashItems = [];
let slashActive = -1;
function slashMenuOpen() { return slashItems.length > 0; }

function renderSlashMenu() {
  const box = $('skill-suggest');
  const m = /^\/(\S*)$/.exec($('input').value); // a lone slash + partial command (no space yet)
  if (!m || !skillsAllowed()) { hideSlashMenu(); return false; }
  const prefix = m[1].toLowerCase();
  const matches = (state.settings.skills || []).filter((s) =>
    (s.command || '').toLowerCase().startsWith(prefix),
  );
  if (!matches.length) { hideSlashMenu(); return false; }
  slashItems = matches;
  slashActive = Math.max(0, Math.min(slashActive, matches.length - 1));
  box.innerHTML = '';
  box.classList.add('slash-menu');
  matches.forEach((skill, i) => {
    const item = document.createElement('button');
    item.className = 'slash-item' + (i === slashActive ? ' active' : '');
    item.innerHTML =
      `<span class="si-icon">${skill.icon || '⚡'}</span>` +
      `<span class="si-cmd">/${escapeAttr(skill.command || '')}</span>` +
      `<span class="si-desc">${escapeAttr(skill.description || skill.name || '')}</span>`;
    // mousedown (not click) so we act before the textarea blur hides the menu.
    item.onmousedown = (e) => { e.preventDefault(); chooseSlash(i); };
    box.appendChild(item);
  });
  box.classList.remove('hidden');
  return true;
}

function hideSlashMenu() {
  if (!slashItems.length) return;
  const box = $('skill-suggest');
  box.classList.remove('slash-menu');
  box.classList.add('hidden');
  box.innerHTML = '';
  slashItems = [];
  slashActive = -1;
}

function chooseSlash(i) {
  const skill = slashItems[i];
  hideSlashMenu();
  if (!skill) return;
  const input = $('input');
  input.value = `/${skill.command || ''} `; // complete the command; user adds args + Enter
  autoGrow();
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------
async function refreshHistory() {
  state.index = await getIndex();
  if (!$('history').classList.contains('hidden')) renderHistory();
}

function renderHistory(filter = '') {
  const list = $('history-list');
  list.innerHTML = '';
  const f = filter.toLowerCase();
  const items = state.index.filter((e) => !f || e.title.toLowerCase().includes(f));
  if (!items.length) {
    list.innerHTML = '<div class="menu-section">No chats yet</div>';
    return;
  }
  for (const e of items) {
    const item = document.createElement('div');
    item.className = 'history-item' + (e.id === state.conv.id ? ' active' : '');
    const main = document.createElement('div');
    main.className = 'hi-main';
    main.innerHTML = `<div class="hi-title">${escapeAttr(e.title)}</div><div class="hi-meta">${relTime(
      e.updatedAt,
    )} · ${e.msgs} msgs</div>`;
    if (state.streams.has(e.id)) {
      const dot = document.createElement('span');
      dot.className = 'dot on';
      dot.title = 'Responding…';
      main.querySelector('.hi-meta').append(' · ', dot);
    }
    main.onclick = () => openConversation(e.id);
    const actions = document.createElement('div');
    actions.className = 'hi-actions';
    actions.appendChild(miniBtn('✎', () => startRename(e, item), 'Rename'));
    actions.appendChild(miniBtn('⤓', () => exportConv(e.id), 'Export as Markdown'));
    actions.appendChild(miniBtn('🗑', () => removeConv(e.id), 'Delete'));
    item.append(main, actions);
    list.appendChild(item);
  }
}

async function openConversation(id) {
  // Prefer the in-memory copy if it exists (it may be mid-stream).
  const conv = state.convCache.get(id) || (await getConversation(id));
  if (!conv) return;
  await startConversation(conv);
  $('history').classList.add('hidden');
}

// Inline rename (window.prompt is unreliable in side panels).
function startRename(e, itemEl) {
  const titleEl = itemEl.querySelector('.hi-title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'hi-rename';
  input.value = e.title;
  input.onclick = (ev) => ev.stopPropagation();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim() || e.title;
    await renameConversation(e.id, name);
    const c = state.convCache.get(e.id);
    if (c) c.title = name;
    if (state.conv.id === e.id) state.conv.title = name;
    refreshHistory();
  };
  input.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') {
      done = true;
      refreshHistory();
    }
  };
  input.onblur = commit;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// Delete immediately (confirm() is unreliable in side panels) with an Undo.
async function removeConv(id) {
  const conv = state.convCache.get(id) || (await getConversation(id));
  const s = state.streams.get(id);
  if (s) {
    s.controller.abort();
    state.streams.delete(id);
  }
  await deleteConversation(id);
  state.convCache.delete(id);
  if (state.conv.id === id) await startConversation();
  refreshHistory();
  if (conv) {
    toastAction('Chat deleted', 'Undo', async () => {
      await saveConversation(conv);
      state.convCache.set(conv.id, conv);
      refreshHistory();
    });
  }
}

// Export one conversation as a downloaded Markdown file (Pro). Free users get an
// upsell — keeping the affordance visible is itself an upgrade nudge.
async function exportConv(id) {
  if (!can(state.license, 'exportChats')) return upsell('exportChats');
  const conv = state.convCache.get(id) || (await getConversation(id));
  if (!conv) return;
  const md = conversationToMarkdown(conv);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (conv.title || 'chat').replace(/[^\w.-]+/g, '_').slice(0, 60) + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported as Markdown');
}

// --------------------------------------------------------------------------
// Misc UI
// --------------------------------------------------------------------------
// Top-bar chip: an "✨ Upgrade" call-to-action for Free users, or a "Pro"/"Team"
// status badge once subscribed. Always visible (it's the plan indicator).
function renderUpgradeChip() {
  const el = $('btn-upgrade');
  el.classList.remove('hidden');
  if (isPro(state.license)) {
    el.textContent = planLabel(state.license); // "Pro" / "Team"
    el.title = `${planLabel(state.license)} active — manage in Settings`;
    el.classList.add('is-active');
    el.classList.remove('is-upgrade');
  } else {
    el.textContent = '✨ Upgrade';
    el.title = 'Upgrade to Pro';
    el.classList.add('is-upgrade');
    el.classList.remove('is-active');
  }
}

// Manual ("Load unpacked") builds don't auto-update — surface a one-click update
// when a newer release is out. No-ops on Web Store installs and stays dismissed
// per-version so it never nags.
async function maybeShowUpdateBanner() {
  let info;
  try {
    info = await checkForUpdate();
  } catch {
    return;
  }
  if (!info.updateAvailable || (await isDismissed(info.latest))) return;
  const banner = $('update-banner');
  $('update-banner-text').textContent = `ChatPanel ${info.latest} is available (you have ${info.current}).`;
  const link = $('update-banner-link');
  link.href = info.downloadUrl;
  $('update-banner-dismiss').onclick = async () => {
    await dismiss(info.latest);
    banner.classList.add('hidden');
  };
  banner.classList.remove('hidden');
}

function applyTheme() {
  const t = state.settings.ui?.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function applySeed(seed) {
  const input = $('input');
  if (seed.selection) {
    state.attachments.push({
      id: uid(),
      kind: 'selection',
      title: seed.title || 'Selection',
      url: seed.url,
      text: seed.selection,
      chars: seed.selection.length,
    });
    renderContextBar();
  } else if (seed.url) {
    input.value = `Tell me about ${seed.url}`;
  }
  autoGrow();
  input.focus();
}

function toast(text, ms = 1400) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// Toast with an action button (used for Undo).
function toastAction(text, label, fn, ms = 5000) {
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text + '  ';
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = label;
  btn.onclick = (e) => {
    e.stopPropagation();
    t.classList.add('hidden');
    fn();
  };
  t.append(span, btn);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function upsell(feature, msg) {
  const plan = tierFor(feature) === 'team' ? 'team' : 'pro';
  const tier = plan === 'team' ? 'Team' : 'Pro';
  // High-intent moment — open checkout and auto-activate on return (no key). The
  // storage listener flips the UI to Pro once the entitlement lands.
  toastAction(msg || `✨ ${tier} feature`, `Upgrade to ${tier}`, () => startSubscribe(plan), 4500);
}

// Seamless, keyless subscribe from the side panel: open checkout, poll, and let
// the user know the moment Pro turns on (the storage listener re-renders the UI).
function startSubscribe(plan = 'pro') {
  toast('Opening checkout… Pro activates automatically when you finish.', 2600);
  subscribe(plan, { onActivated: () => toast('✓ Pro is now active. Thank you!', 2600) });
}

// The composer grows with content up to ~45% of the panel; a manual drag (see
// wireComposerResize) pins an explicit height that wins until double-click reset.
function autoGrow() {
  const i = $('input');
  if (state.composerH) {
    i.style.height = state.composerH + 'px';
    return;
  }
  i.style.height = 'auto';
  // Expand generously so a long prompt is visible without scrolling; only cap
  // near the full panel height (it still scrolls past that, but rarely needed).
  i.style.height = Math.min(i.scrollHeight, Math.round(window.innerHeight * 0.75)) + 'px';
}

function wireComposerResize() {
  const handle = $('composer-resize');
  const input = $('input');
  if (!handle) return;
  let startY = 0;
  let startH = 0;
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY; // drag up → taller
    state.composerH = Math.max(38, Math.min(startH + dy, Math.round(window.innerHeight * 0.7)));
    input.style.height = state.composerH + 'px';
    e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = input.getBoundingClientRect().height;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
  handle.addEventListener('dblclick', () => {
    state.composerH = 0; // back to auto-grow
    autoGrow();
  });
}

// --------------------------------------------------------------------------
// Prompt autocomplete (Pro, opt-in) — as the user pauses typing, ask a fast API
// model for a short continuation and offer it as ghost text ("Tab to complete").
// Off by default; enabled in Settings → Preferences. Uses an API endpoint even
// when the chat agent is a local bridge agent (see autocompleteTarget).
// --------------------------------------------------------------------------
let acTimer = null;
let acController = null;
let acSuggestion = '';
let acHintShown = false;
const acSmallModel = new Map(); // endpoint → smallest model id (cached)

// For an API endpoint, query its models once and cache the smallest one to use
// for autocomplete (e.g. a 0.5B local model instead of the big chat model).
// Falls back to the endpoint's configured model if listing isn't available.
async function smallModelFor(target) {
  const key = target.baseUrl || target.name || 'default';
  if (acSmallModel.has(key)) return acSmallModel.get(key) || target.model;
  let small = null;
  try {
    small = smallestModel(await listModels(target));
  } catch {
    /* listing unavailable — fall back below */
  }
  acSmallModel.set(key, small);
  return small || target.model;
}

// Default fast model per bridge engine for autocomplete. Claude → Haiku (in-process,
// snappy). Codex/Gemini spawn a CLI process per call, so they use their default
// model unless the agent sets `autocompleteModel`.
const FAST_MODEL = { claude: 'haiku', codex: '', gemini: '' };

// Where autocomplete should get its suggestion, FASTEST first. Autocomplete fires
// on a 500ms pause and is superseded by the next keystroke, so the source must
// answer in well under a second. API endpoints stream a few tokens almost
// instantly; bridge agents spawn a CLI process per call (~seconds), so their
// reply usually arrives stale and gets discarded. Hence we prefer ANY configured
// API endpoint over the active bridge agent — the bridge agent is only a last
// resort when no endpoint exists.
//   1) the active agent if it's itself an API endpoint;
//   2) any other configured API endpoint with a model;
//   3) the active bridge agent → bridge /complete (slow; best-effort).
function autocompleteSource() {
  const active = resolveTarget(currentAgent(), state.settings);
  if (active && active.kind !== 'bridge' && active.model) return { kind: 'api', target: active };
  for (const ep of state.settings.endpoints || []) {
    const t = resolveTarget(ep, state.settings);
    if (t && t.kind !== 'bridge' && t.model) return { kind: 'api', target: t };
  }
  if (active && active.kind === 'bridge') {
    const engine = active.bridgeAgent || 'claude';
    return { kind: 'bridge', engine, model: active.autocompleteModel || FAST_MODEL[engine] || '' };
  }
  return null;
}

function clearPromptSuggest() {
  clearTimeout(acTimer);
  if (acController) {
    acController.abort();
    acController = null;
  }
  acSuggestion = '';
  const ghost = $('input-ghost');
  if (ghost) ghost.innerHTML = '';
  const hint = $('prompt-suggest');
  if (hint) {
    hint.classList.add('hidden');
    hint.innerHTML = '';
  }
}

function scheduleAutocomplete() {
  clearTimeout(acTimer);
  if (acController) {
    acController.abort();
    acController = null;
  }
  acSuggestion = '';
  $('prompt-suggest').classList.add('hidden');
  // Wipe any rendered ghost immediately — on every edit (incl. backspace) the
  // prior suggestion is stale, so it must not linger over the input/placeholder.
  const ghost = $('input-ghost');
  if (ghost) ghost.innerHTML = '';
  if (!state.settings.ui?.autocomplete || !isPro(state.license) || isActiveStreaming()) return;
  const input = $('input');
  const text = input.value;
  // Need enough to continue, cursor at the very end, not a slash command.
  if (text.trim().length < 6 || text.startsWith('/')) return;
  if (input.selectionStart !== text.length) return;
  // A finished sentence has nothing to autocomplete — and asking anyway tends to
  // make the model ANSWER it instead of predicting the next words. Skip when the
  // text already ends a sentence (optionally with a closing quote/bracket).
  if (/[.?!]["'’”)\]]?\s*$/.test(text)) return;
  // Resolve where the suggestion comes from. If nothing usable (e.g. a bridge
  // agent that's offline and no API endpoint), say so once instead of silence.
  const source = autocompleteSource();
  if (!source) {
    if (!acHintShown) {
      acHintShown = true;
      const el = $('prompt-suggest');
      el.innerHTML = '<span class="ps-ghost">Autocomplete needs a model — pick an agent or add an API endpoint.</span>';
      el.classList.remove('hidden');
      el.onclick = () => chrome.runtime.openOptionsPage();
    }
    return;
  }
  acTimer = setTimeout(() => requestAutocomplete(text, source), 500);
}

// A short, de-duplicated slice of the attached context (the page/tabs/url the
// user has on), so completions are relevant to what they're looking at.
function autocompleteContext() {
  const parts = (state.attachments || []).map((a) => `${a.title ? a.title + ': ' : ''}${a.text || ''}`.trim());
  const ctx = parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  return ctx.slice(0, 1200);
}

async function requestAutocomplete(text, source) {
  if (!source) return;
  acController = new AbortController();
  const ctx = autocompleteContext();
  // Frame this as a text-continuation engine (ghost text), NOT a chat task —
  // "finish the message" reads as an instruction and makes models answer. The
  // few-shot examples teach small/local models the format (raw next words, can
  // start mid-word, no reply).
  const sys =
    'You are a text autocomplete engine — like the gray ghost text in a code editor ' +
    'or a phone keyboard. Predict ONLY the next few words (at most ~6) that continue ' +
    "the user's current sentence, in their own voice. You are NOT a chat assistant: " +
    'never answer, reply, explain, greet, or start a new sentence. The continuation ' +
    'may begin mid-word. Output the raw continuation only — no quotes, no labels. If ' +
    'the text already reads as a complete sentence, output nothing.\n\n' +
    'Examples:\n' +
    'Text: "what are the main diff" -> "erences between them"\n' +
    'Text: "how do I center a" -> " div with flexbox"\n' +
    'Text: "can you summarize this" -> " page for me"\n' +
    'Text: "write a python function to" -> " parse the CSV"';
  const prompt =
    (ctx ? `Context (the page the user is viewing):\n"""\n${ctx}\n"""\n\n` : '') +
    `Continue this text with only the next few words. Do not answer it:\n${text}`;
  let out = '';
  try {
    if (source.kind === 'bridge') {
      // Fast path through the local bridge using the agent's fast model.
      const base = (state.settings.bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');
      const res = await fetch(`${base}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: source.engine, prompt, model: source.model, system: sys }),
        signal: acController.signal,
      });
      if (!res.ok) return;
      out = (await res.json()).text || '';
    } else {
      const model = await smallModelFor(source.target); // smallest available
      await streamChat({
        agent: { ...source.target, model, systemPrompt: sys, maxTokens: 16, temperature: 0.2 },
        messages: [{ role: 'user', content: prompt }],
        settings: state.settings,
        signal: acController.signal,
        onDelta: (d) => {
          out += d;
        },
        onEvent: () => {},
      });
    }
  } catch {
    return; // aborted or failed — no suggestion
  }
  const input = $('input');
  if (input.value !== text) return; // user typed more meanwhile
  let s = out.replace(/^\s*["'“]+|["'”]+\s*$/g, '');
  // Strip an echoed copy of the user's text if the model repeated it.
  if (s.trimStart().toLowerCase().startsWith(text.trim().toLowerCase())) {
    s = s.trimStart().slice(text.trim().length);
  }
  s = s.replace(/\n[\s\S]*$/, ''); // first line only
  if (!s.trim()) return;
  // Join with a space unless the boundary already has one.
  acSuggestion = (/\s$/.test(text) || /^\s/.test(s) ? '' : ' ') + s.trim();
  renderGhost(text, acSuggestion);
}

// Inline ghost text: mirror the typed text (transparent) + the suggestion (dim)
// so it appears right after the cursor, VS Code style.
function renderGhost(typed, suggestion) {
  const el = $('input-ghost');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(typed));
  const s = document.createElement('span');
  s.className = 'gs';
  s.textContent = suggestion;
  el.appendChild(s);
  el.scrollTop = $('input').scrollTop;
}

function acceptPromptSuggest() {
  if (!acSuggestion) return;
  const input = $('input');
  input.value = input.value + acSuggestion; // acSuggestion already includes any leading space
  acSuggestion = '';
  $('input-ghost').innerHTML = '';
  autoGrow();
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

function scrollToBottom() {
  const m = $('messages');
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 200;
  if (nearBottom) m.scrollTop = m.scrollHeight;
}

// --------------------------------------------------------------------------
// Drawer resize — drag the left edge of a side drawer (Meetings / live notes)
// to widen or narrow it. Both drawers share one persisted width so the layout is
// consistent. Width is clamped to [MIN, panel width].
// --------------------------------------------------------------------------
const DRAWER_WIDTH_KEY = 'cp:drawerWidth';
const DRAWER_MIN_W = 280;

function applyDrawerWidth(px) {
  document.querySelectorAll('.live-notes-drawer').forEach((d) => {
    d.style.width = `${px}px`;
    d.style.maxWidth = 'none';
  });
}

function wireDrawerResize() {
  const saved = parseInt(localStorage.getItem(DRAWER_WIDTH_KEY) || '', 10);
  if (saved > 0) applyDrawerWidth(Math.min(saved, window.innerWidth));

  document.querySelectorAll('.live-notes-resize').forEach((handle) => {
    const drawer = handle.closest('.live-notes-drawer');
    if (!drawer) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const maxW = (drawer.parentElement || document.body).getBoundingClientRect().width;
      drawer.classList.add('resizing');
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const w = drawer.getBoundingClientRect().right - ev.clientX; // right edge is fixed
        applyDrawerWidth(Math.max(DRAWER_MIN_W, Math.min(w, maxW)));
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        drawer.classList.remove('resizing');
        localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(drawer.getBoundingClientRect().width)));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------
function wireEvents() {
  $('btn-send').onclick = send;
  $('btn-stop').onclick = stopStream;
  $('btn-new').onclick = () => startConversation();
  $('btn-settings').onclick = () => chrome.runtime.openOptionsPage();
  // The plan chip (Pro badge or ✨ Upgrade) always opens the License tab.
  $('btn-upgrade').onclick = () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html#license') });
  $('btn-assist').onclick = improvePrompt;

  wireComposerResize();

  const input = $('input');
  input.oninput = () => {
    autoGrow();
    if (!input.value.trim()) suggestSuppressed = false;
    // Slash command palette takes precedence over the natural-language chip.
    if (!renderSlashMenu()) renderSuggest();
    scheduleAutocomplete();
  };
  input.onkeydown = (e) => {
    // Slash command palette nav takes priority while it's open.
    if (slashMenuOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = (slashActive + 1) % slashItems.length; renderSlashMenu(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = (slashActive - 1 + slashItems.length) % slashItems.length; renderSlashMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashActive); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    }
    // Tab accepts an autocomplete suggestion; Esc dismisses it.
    if (e.key === 'Tab' && !e.shiftKey && acSuggestion) {
      e.preventDefault();
      acceptPromptSuggest();
      return;
    }
    if (e.key === 'Escape' && acSuggestion) {
      clearPromptSuggest();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && state.settings.ui.sendOnEnter) {
      e.preventDefault();
      send();
    }
  };
  input.onblur = () => setTimeout(() => { clearPromptSuggest(); hideSlashMenu(); }, 150);
  input.addEventListener('scroll', () => {
    const g = $('input-ghost');
    if (g) g.scrollTop = input.scrollTop;
  });

  // Agent menu
  $('agent-button').onclick = (e) => {
    e.stopPropagation();
    const m = $('agent-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      renderAgentMenu();
      m.classList.remove('hidden');
      // Re-poll the bridge so availability is fresh (it may have just started or
      // gained a new agent like Gemini); re-render the menu if it's still open.
      refreshBridge().then(() => {
        if (!m.classList.contains('hidden')) renderAgentMenu();
      });
    }
  };

  // Attach + skills menus
  $('btn-attach').onclick = async (e) => {
    e.stopPropagation();
    const m = $('attach-menu');
    const opening = m.classList.contains('hidden');
    closeMenus();
    if (opening) {
      await renderAttachMenu();
      m.classList.remove('hidden');
    }
  };
  $('btn-skills').onclick = (e) => {
    e.stopPropagation();
    closeMenus();
    if (!skillsAllowed()) return upsell('customSkills'); // Skills are Pro
    const m = $('skills-menu');
    const opening = m.classList.contains('hidden');
    if (opening) {
      renderSkillsMenu();
      m.classList.remove('hidden');
    }
  };

  // Watch mode: 👁 opens the popover; Start/Stop control the loop.
  $('rail-toggle').onclick = toggleRail;
  $('watch-start').onclick = () => {
    const n = Math.max(1, Number($('watch-interval-n').value) || 10);
    const unit = Number($('watch-interval-unit').value) || 1000;
    startWatch({
      instruction: $('watch-instruction').value.trim(),
      intervalMs: Math.max(5000, n * unit), // 5s floor — change-gating bounds cost
      onlyWhenChanged: $('watch-changed').checked,
    });
  };
  $('watch-stop').onclick = () => stopWatch({ hard: true });

  // History drawer
  $('btn-history').onclick = () => {
    renderHistory($('history-search').value);
    $('history').classList.remove('hidden');
  };
  $('history-close').onclick = () => $('history').classList.add('hidden');
  $('history-search').oninput = (e) => renderHistory(e.target.value);
  // Live-notes drawer controls (Summary / Transcript tabs, search, copy, download).
  $('live-notes-close').onclick = () => closeLiveNotes();
  $('live-notes-copy').onclick = () => copyLiveNotesActive();
  $('live-notes-download').onclick = () => downloadLiveNotesActive();
  $('ln-tab-summary').onclick = () => switchLiveNotesTab('summary');
  $('ln-tab-transcript').onclick = () => switchLiveNotesTab('transcript');
  $('live-notes-search').oninput = () => renderTranscript();

  // Past Meetings drawer
  $('meetings-close').onclick = () => closeMeetings();
  $('meeting-vclose').onclick = () => closeMeetings();
  $('meeting-back').onclick = () => meetingBackToList();
  $('meetings-search').oninput = (e) => renderMeetingsList(e.target.value);
  $('mv-tab-summary').onclick = () => switchMeetingTab('summary');
  $('mv-tab-transcript').onclick = () => switchMeetingTab('transcript');
  $('meeting-search').oninput = () => renderMeetingTranscript();
  $('meeting-copy').onclick = () => copyMeetingActive();
  $('meeting-download').onclick = () => downloadMeetingActive();
  $('meeting-ask').onclick = () => askAboutMeeting();
  $('scribe-indicator').onclick = () => openMeetings();
  // Two-click confirm (confirm() is unreliable in side panels).
  let clearArmed = false;
  $('history-clear').onclick = async (e) => {
    e.stopPropagation();
    const btn = $('history-clear');
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = 'Click again to confirm';
      setTimeout(() => {
        clearArmed = false;
        btn.textContent = 'Clear all history';
      }, 3000);
      return;
    }
    clearArmed = false;
    btn.textContent = 'Clear all history';
    for (const s of state.streams.values()) s.controller.abort();
    state.streams.clear();
    state.convCache.clear();
    ensureActivityTimer();
    await clearAllConversations();
    await startConversation();
    refreshHistory();
  };

  // Keep clicks inside an open menu (e.g. the URL input) from closing it.
  ['agent-menu', 'attach-menu', 'skills-menu', 'watch-menu'].forEach((id) =>
    $(id).addEventListener('click', (e) => e.stopPropagation()),
  );
  document.body.onclick = () => closeMenus();

  // Stop watching if the watched tab is closed.
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (state.watch.on && tabId === state.watch.tabId) stopWatch({ reason: 'watched tab closed' });
  });

  // Keep the page chip pointed at whatever tab the user is on.
  chrome.tabs.onActivated.addListener(() => refreshActiveTab());
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.status === 'complete' || info.title)) refreshActiveTab();
  });
  chrome.windows?.onFocusChanged?.addListener(() => refreshActiveTab());

  // React to settings changes from the options page (saved to storage).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes['chatpanel:settings']) {
      state.settings = await getSettings();
      applyTheme();
      renderAgentName();
      refreshBridge();
    }
    if (changes['chatpanel:license']) {
      state.license = await getLicense();
      ensureUsableActiveAgent();
      renderUpgradeChip();
      renderAgentName();
    }
  });
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.classList.add('hidden'));
}

// --------------------------------------------------------------------------
// Tiny helpers
// --------------------------------------------------------------------------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function miniBtn(label, onClick, title) {
  const b = document.createElement('button');
  b.className = 'mini-btn';
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}
function actionItem(icon, label, onClick) {
  const b = document.createElement('button');
  b.className = 'menu-item';
  b.innerHTML = `<span>${icon}</span><span>${escapeAttr(label)}</span>`;
  b.onclick = () => {
    closeMenus();
    onClick();
  };
  return b;
}
function sectionLabel(text) {
  const d = document.createElement('div');
  d.className = 'menu-section';
  d.textContent = text;
  return d;
}
function escapeAttr(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

init();
