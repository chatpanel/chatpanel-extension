import { meetingToText } from './store-meetings.js';

export function buildMeetingChatAttachment(rec, notes = '', { now = Date.now(), maxChars = 40000 } = {}) {
  const transcript = meetingToText(rec, { sinceTs: 0 });
  let body = (notes ? `SUMMARY:\n${notes}\n\n` : '') + 'TRANSCRIPT:\n';
  const room = Math.max(2000, maxChars - body.length);
  body += transcript.length > room ? '…' + transcript.slice(-room) : transcript;

  return {
    id: `mtg_${rec.id}_${now}`,
    kind: 'meeting',
    title: `🎙 ${rec.title || 'Meeting'}`,
    url: rec.url || '',
    text: body,
    chars: body.length,
  };
}

export function upsertMeetingChatAttachment(attachments, rec, notes = '', options = {}) {
  const prefix = `mtg_${rec.id}`;
  const next = (attachments || []).filter((a) => !(typeof a.id === 'string' && a.id.startsWith(prefix)));
  next.unshift(buildMeetingChatAttachment(rec, notes, options));
  return next;
}
