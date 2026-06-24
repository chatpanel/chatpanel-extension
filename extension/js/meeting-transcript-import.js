const isBullet = (line) => /^\s*([-*+]|\d+\.)\s+/.test(line);
const stripBullet = (line) => line.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();
const CHAT_RECIPIENT_RE = /\bto\s+(everyone|all|all panelists|host|hosts|participants?)\b/i;
const demd = (value) => String(value || '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
  .replace(/`(.+?)`/g, '$1')
  .replace(/_(.+?)_/g, '$1')
  .trim();

function sectionKind(heading) {
  const value = String(heading || '').toLowerCase();
  if (/^(meeting\s+)?chat(?:\s+transcript)?\b|^messages?\b/.test(value)) return 'chat';
  if (/^(meeting\s+)?participants?\b|^(meeting\s+)?attendees?\b|^(meeting\s+)?people\b/.test(value)) return 'participants';
  if (/^(meeting\s+)?shared links?\b|^links?\b|^resources?\b|^references?\b/.test(value)) return 'links';
  if (/^(meeting\s+)?transcript\b|^captions?\b|^conversation\b|^spoken\b/.test(value)) return 'transcript';
  return null;
}

function nextTime(base, index) {
  return base + index * 4000;
}

function validTime(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dateFromParts(match) {
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4] || 0);
  const mi = Number(match[5] || 0);
  const s = Number(match[6] || 0);
  const ms = Number(String(match[7] || '0').padEnd(3, '0').slice(0, 3));
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return 0;
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

export function inferTranscriptStart(text = '', filename = '', fallback = Date.now()) {
  const sample = [
    filename,
    ...String(text || '').split(/\r?\n/).slice(0, 20),
  ].join('\n');

  const iso = sample.match(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z(?=$|[^A-Za-z0-9])/);
  if (iso) {
    const ts = Date.parse(iso[0]);
    if (validTime(ts)) return ts;
  }

  const compactDateTimeWithMs = sample.match(
    /\b(20\d{2})[ ._-](\d{1,2})[ ._-](\d{1,2})[T\s_-]+(\d{1,2})[ .:_-](\d{2})[ .:_-](\d{2})[ .:_-](\d{1,3})\s*Z?\b/i,
  );
  if (compactDateTimeWithMs) {
    const ts = dateFromParts(compactDateTimeWithMs);
    if (ts) return ts;
  }

  const compactDateTime = sample.match(
    /\b(20\d{2})[ ._-](\d{1,2})[ ._-](\d{1,2})[T\s_-]+(\d{1,2})[ .:_-](\d{2})(?:[ .:_-](\d{2}))?(?:[ .:_-](\d{1,3}))?\s*Z?\b/i,
  );
  if (compactDateTime) {
    const ts = dateFromParts(compactDateTime);
    if (ts) return ts;
  }

  for (const raw of String(text || '').split(/\r?\n/).slice(0, 12)) {
    const line = demd(raw);
    const metadata = line.match(/(?:Zoom|Google Meet|Meet|Teams|Webex|Imported|Meeting)\s*[·|-]\s*(.+)$/i);
    if (!metadata) continue;
    const ts = Date.parse(metadata[1].trim());
    if (validTime(ts)) return ts;
  }

  return validTime(fallback) || Date.now();
}

function parseSegmentLine(line, t) {
  let m = line.match(/^\*\*(.+?)\*\*\s*(?:_\(([^)]*)\)_)?\s*:?\s*(.*)$/);
  if (m && (m[3] || '').trim()) return { t, speaker: demd(m[1]), text: demd(m[3]) };

  m = line.match(/^(?:\[([^\]]+)\]\s*)?([^:]{1,60}?):\s+(.+)$/);
  if (m) return { t, speaker: demd(m[2]), text: demd(m[3]) };

  return { t, speaker: '', text: demd(line) };
}

function parseChatLine(line, t, section) {
  let value = isBullet(line) ? stripBullet(line) : line.trim();
  value = value.replace(/^\[([^\]]+)\]\s*/, '').trim();
  if (!value) return null;

  let m = value.match(/^(.+?)\s+to\s+(.+?):\s+(.+)$/i);
  if (m) {
    return {
      t,
      sender: demd(m[1]) || 'Unknown',
      receiver: demd(m[2]) || 'Everyone',
      text: demd(m[3]),
    };
  }

  m = value.match(/^(.+?)\s+to\s+(Everyone|All|All Panelists|Hosts?|Participants?)\s+(.+)$/i);
  if (m) {
    return {
      t,
      sender: demd(m[1]) || 'Unknown',
      receiver: demd(m[2]) || 'Everyone',
      text: demd(m[3]),
    };
  }

  m = value.match(/^([^:]{1,60}?):\s+(.+)$/);
  if (m) {
    return {
      t,
      sender: demd(m[1]) || (section === 'links' ? 'Shared Links' : 'Chat'),
      receiver: 'Everyone',
      text: demd(m[2]),
    };
  }

  return {
    t,
    sender: section === 'links' ? 'Shared Links' : 'Chat',
    receiver: 'Everyone',
    text: demd(value),
  };
}

function parseParticipantLine(line) {
  let value = isBullet(line) ? stripBullet(line) : line.trim();
  value = demd(value);
  if (!value) return null;
  if (CHAT_RECIPIENT_RE.test(value)) return null;

  let initials = '';
  const prefix = value.match(/^([A-Z?[\]()]{1,10})\s*[-–—]\s*(.+)$/);
  if (prefix) {
    initials = prefix[1] === '?' ? '' : prefix[1].replace(/[^A-Z]/g, '').slice(0, 4);
    value = prefix[2].trim();
  }

  const roles = [];
  for (;;) {
    const roleMatch = value.match(/\s*(?:\(([^()]*)\)|\[([^\[\]]*)\])\s*$/);
    if (!roleMatch) break;
    const token = demd(roleMatch[1] || roleMatch[2] || '');
    value = value.slice(0, roleMatch.index).trim();
    if (token) roles.unshift(token);
  }
  const dashRole = value.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashRole) {
    value = dashRole[1].trim();
    roles.push(dashRole[2].trim());
  }

  if (!value) return null;
  if (!initials) initials = value.split(/\s+/).map((word) => word[0]).join('').slice(0, 3).toUpperCase();
  return { initials, name: value, role: roles.filter(Boolean).join(' · ') };
}

function isLegacyParticipantChat(item) {
  const sender = String(item?.sender || '').trim();
  const value = demd(item?.text || '');
  if (sender && !/^(chat|meeting chat|shared links)$/i.test(sender)) return false;
  return /^[A-Z?[\]()]{1,10}\s*[-–—]\s*\S+/.test(value) && !!parseParticipantLine(value);
}

export function repairTranscriptParticipants(rec) {
  if (!rec || !Array.isArray(rec.chat) || !rec.chat.length) return false;
  const participants = Array.isArray(rec.participants) ? [...rec.participants] : [];
  const seen = new Set(participants.map((p) => String(p?.name || '').trim().toLowerCase()).filter(Boolean));
  const keepChat = [];
  let changed = false;

  for (let i = 0; i < rec.chat.length; i += 1) {
    if (!isLegacyParticipantChat(rec.chat[i])) {
      keepChat.push(rec.chat[i]);
      continue;
    }

    const run = [];
    while (i < rec.chat.length && isLegacyParticipantChat(rec.chat[i])) {
      run.push(rec.chat[i]);
      i += 1;
    }
    i -= 1;

    if (run.length < 2) {
      keepChat.push(...run);
      continue;
    }

    run.forEach((item) => {
      const participant = parseParticipantLine(item.text);
      const key = String(participant?.name || '').trim().toLowerCase();
      if (participant && key && !seen.has(key)) {
        seen.add(key);
        participants.push(participant);
      }
    });
    changed = true;
  }

  if (!changed) return false;
  rec.chat = keepChat;
  rec.participants = participants;
  return true;
}

export function repairImportedTranscriptDate(rec) {
  if (!rec || rec.platform !== 'imported') return false;
  const oldStart = validTime(rec.startedAt);
  const inferred = inferTranscriptStart('', rec.title || rec.meetingKey || '', oldStart || Date.now());
  if (!oldStart || !inferred || Math.abs(inferred - oldStart) < 60_000) return false;

  const delta = inferred - oldStart;
  const shift = (items) => {
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      if (validTime(item?.t)) item.t += delta;
    });
  };
  rec.startedAt = inferred;
  if (validTime(rec.endedAt)) rec.endedAt += delta;
  else rec.endedAt = inferred;
  shift(rec.segments);
  shift(rec.chat);
  return true;
}

export function parseTranscriptText(text, filename = 'Imported meeting', { now = Date.now() } = {}) {
  const start = inferTranscriptStart(text, filename, now);
  let title = (filename || 'Imported meeting').replace(/\.(md|markdown|txt)$/i, '').replace(/[._-]+/g, ' ').trim();
  let section = 'transcript';
  let segmentIndex = 0;
  let chatIndex = 0;
  const segments = [];
  const chat = [];
  const participants = [];
  const participantNames = new Set();

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) {
      title = demd(h1[1]) || title;
      continue;
    }

    const heading = line.match(/^#{2,6}\s+(.*)$/);
    if (heading) {
      section = sectionKind(heading[1]);
      continue;
    }

    const banner = line.match(/^---\s*(.*?)\s*---$/);
    if (banner) {
      section = sectionKind(banner[1]) || section;
      continue;
    }

    if (/^[-*_]{3,}$/.test(line) || /^_.*_$/.test(line)) continue;
    if (!section) continue;

    if (section === 'participants') {
      const participant = parseParticipantLine(line);
      if (participant && !participantNames.has(participant.name.toLowerCase())) {
        participantNames.add(participant.name.toLowerCase());
        participants.push(participant);
      }
      continue;
    }

    if (section === 'chat' || section === 'links') {
      const item = parseChatLine(line, nextTime(start, chatIndex), section);
      if (item?.text) {
        chat.push(item);
        chatIndex++;
      }
      continue;
    }

    const segment = parseSegmentLine(line, nextTime(start, segmentIndex));
    if (segment.text) {
      segments.push(segment);
      segmentIndex++;
    }
  }

  return {
    title: title || 'Imported meeting',
    startedAt: start,
    endedAt: start + Math.max(segments.length, chat.length, 1) * 4000,
    segments,
    chat,
    participants,
  };
}
