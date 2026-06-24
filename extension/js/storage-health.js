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

async function bytesInUse(storage) {
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
    bytesInUse(storage),
    readMeetingIndex().catch(() => []),
  ]);
  const meetingCount = Array.isArray(meetings) ? meetings.length : 0;
  return {
    bytes,
    bytesLabel: formatBytes(bytes),
    meetings: meetingCount,
  };
}
