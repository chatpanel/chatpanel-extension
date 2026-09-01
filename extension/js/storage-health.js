import { getMeetingIndex } from './store-meetings.js';

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Bytes of chrome.storage.local actually in use — the real footprint of chats, meetings
 * and notes, which all live there.
 *
 * Deliberately NOT navigator.storage.estimate(): that answers a different question, the
 * origin's quota-managed pools (Cache Storage, IndexedDB). Those hold the in-browser model
 * weights and the event log, and not one of the records — so reporting it as "your data"
 * makes a model download look like history.
 */
export async function localBytesInUse(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.getBytesInUse) return 0;
  try {
    const bytes = await storage.getBytesInUse(null);
    return Math.max(0, Number(bytes) || 0);
  } catch {
    return 0;
  }
}

export async function localStorageHealth({
  storage = globalThis.chrome?.storage?.local,
  getMeetingIndex: readMeetingIndex = getMeetingIndex,
} = {}) {
  const [bytes, meetings] = await Promise.all([
    localBytesInUse(storage),
    readMeetingIndex().catch(() => []),
  ]);
  const meetingCount = Array.isArray(meetings) ? meetings.length : 0;
  return {
    bytes,
    bytesLabel: formatBytes(bytes),
    meetings: meetingCount,
  };
}
