export const HISTORY_CONTEXT_MODES = {
  OFF: 'off',
  CHATS: 'chats',
  MEETINGS: 'meetings',
  ALL: 'all',
};

export function normalizeHistoryContextMode(value) {
  const v = String(value || '').toLowerCase();
  if (v === HISTORY_CONTEXT_MODES.CHATS) return HISTORY_CONTEXT_MODES.CHATS;
  if (v === HISTORY_CONTEXT_MODES.MEETINGS) return HISTORY_CONTEXT_MODES.MEETINGS;
  if (v === HISTORY_CONTEXT_MODES.ALL || v === 'both') return HISTORY_CONTEXT_MODES.ALL;
  return HISTORY_CONTEXT_MODES.OFF;
}

export function historyContextForMode(value, { canMeetings = false } = {}) {
  const mode = normalizeHistoryContextMode(value);
  if (mode === HISTORY_CONTEXT_MODES.OFF) {
    return { enabled: false, scope: 'all', includeMeetings: false, mode };
  }
  if (mode === HISTORY_CONTEXT_MODES.MEETINGS) {
    return {
      enabled: !!canMeetings,
      scope: 'meetings',
      includeMeetings: !!canMeetings,
      mode,
      locked: !canMeetings,
    };
  }
  if (mode === HISTORY_CONTEXT_MODES.ALL) {
    return {
      enabled: true,
      scope: canMeetings ? 'all' : 'chats',
      includeMeetings: !!canMeetings,
      mode,
      downgraded: !canMeetings,
    };
  }
  return { enabled: true, scope: 'chats', includeMeetings: false, mode };
}

export function historyContextLabel(value, { canMeetings = false } = {}) {
  const ctx = historyContextForMode(value, { canMeetings });
  if (!ctx.enabled) return ctx.locked ? 'History: Meetings require Pro' : 'History: Off';
  if (ctx.scope === 'meetings') return 'History: Meetings';
  if (ctx.scope === 'all') return 'History: Chats + meetings';
  return ctx.downgraded ? 'History: Chats (meetings require Pro)' : 'History: Chats';
}
