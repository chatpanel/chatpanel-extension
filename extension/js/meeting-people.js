export const isMeetingImageValue = (value) => typeof value === 'string'
  && /^https?:\/\/\S+$/i.test(value.trim())
  && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)|images\.zoom\.us|\/p\/v2\/|gravatar|avatar|googleusercontent|wbxcdn|teams\.(microsoft|live)/i.test(value);

const GENERIC_SPEAKER_RE = /^(?:unknown\s+)?speaker(?:\s*[-_#]?\s*\d+)?$/i;
const CHAT_RECIPIENT_RE = /\bto\s+(everyone|all|all panelists|host|hosts|participants?)\b/i;

function cleanSpaces(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

export function isMeetingPersonName(name) {
  const value = cleanSpaces(name);
  return !!value && !GENERIC_SPEAKER_RE.test(value) && !CHAT_RECIPIENT_RE.test(value);
}

function looksLikePersonName(value) {
  const name = cleanSpaces(value);
  if (!name || CHAT_RECIPIENT_RE.test(name) || GENERIC_SPEAKER_RE.test(name)) return false;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every((p) => /[A-Za-z]/.test(p) && !/^[A-Z]{2,}$/.test(p));
}

function initialsFor(name) {
  return cleanSpaces(name)
    .split(/\s+/)
    .map((part) => part[0] || '')
    .join('')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 4)
    .toUpperCase();
}

function trailingNameFromRole(role) {
  const value = cleanSpaces(role);
  if (!value) return null;

  const dotParts = value.split(/\s+·\s+/).map(cleanSpaces).filter(Boolean);
  if (dotParts.length >= 2 && looksLikePersonName(dotParts.at(-1))) {
    return { name: dotParts.at(-1), role: dotParts.slice(0, -1).join(' · ') };
  }

  const dashParts = value.split(/\s+[-–—]\s+/).map(cleanSpaces).filter(Boolean);
  if (dashParts.length >= 3 && looksLikePersonName(dashParts.at(-1))) {
    return { name: dashParts.at(-1), role: dashParts.slice(0, -1).join(' - ') };
  }

  return null;
}

function baseSpeakerName(name) {
  return cleanSpaces(name)
    .replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, ' ')
    .replace(/\s+[-–—]\s+(?:host|co-?host|speaker)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function personKey(name) {
  return baseSpeakerName(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function participantRow(p) {
  let name = cleanSpaces(p?.name);
  let initials = cleanSpaces(p?.initials).toUpperCase();
  let role = cleanSpaces(p?.role);
  const trailing = trailingNameFromRole(role);
  const compactName = name.replace(/[^A-Za-z]/g, '');
  if (trailing && (compactName.length <= 2 || initials === initialsFor(trailing.name))) {
    name = trailing.name;
    role = trailing.role;
    if (!initials) initials = initialsFor(name);
  }
  if (!initials) initials = initialsFor(name);
  if (!isMeetingPersonName(name) || isMeetingImageValue(name)) return null;
  return { name, initials, role };
}

function participantRows(rec) {
  const out = [];
  const seen = new Set();
  for (const raw of rec?.participants || []) {
    const row = participantRow(raw);
    const key = personKey(row?.name);
    if (!row || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function speakerName(speaker) {
  const value = baseSpeakerName(speaker);
  if (!isMeetingPersonName(value) || isMeetingImageValue(value)) return '';
  return value;
}

export function participantRowsOfMeeting(rec) {
  const participants = participantRows(rec);
  const rows = [...participants];
  const seen = new Set(rows.map((p) => personKey(p.name)).filter(Boolean));

  for (const segment of rec?.segments || []) {
    const name = speakerName(segment?.speaker);
    const key = personKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, initials: initialsFor(name), role: 'Speaker' });
  }

  return rows;
}

export function peopleOfMeeting(rec) {
  return participantRowsOfMeeting(rec).map((p) => p.name);
}

export function speakerCountOfMeeting(rec) {
  const participants = participantRows(rec);
  if (participants.length) return participants.length;
  return participantRowsOfMeeting(rec).length;
}
