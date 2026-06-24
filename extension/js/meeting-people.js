export const isMeetingImageValue = (value) => typeof value === 'string'
  && /^https?:\/\/\S+$/i.test(value.trim())
  && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)|images\.zoom\.us|\/p\/v2\/|gravatar|avatar|googleusercontent|wbxcdn|teams\.(microsoft|live)/i.test(value);

const GENERIC_SPEAKER_RE = /^speaker(?:\s*[-_#]?\s*\d+)?$/i;
const CHAT_RECIPIENT_RE = /\bto\s+(everyone|all|all panelists|host|hosts|participants?)\b/i;

export function isMeetingPersonName(name) {
  const value = String(name == null ? '' : name).trim();
  return !!value && !GENERIC_SPEAKER_RE.test(value) && !CHAT_RECIPIENT_RE.test(value);
}

function addPerson(set, name) {
  const value = String(name == null ? '' : name).trim();
  if (isMeetingPersonName(value) && !isMeetingImageValue(value)) set.add(value);
}

export function peopleOfMeeting(rec) {
  const set = new Set();
  (rec?.participants || []).forEach((p) => addPerson(set, p?.name));
  (rec?.segments || []).forEach((s) => addPerson(set, s?.speaker));
  return [...set];
}

export function speakerCountOfMeeting(rec) {
  const participants = new Set();
  (rec?.participants || []).forEach((p) => addPerson(participants, p?.name));
  if (participants.size) return participants.size;

  const speakers = new Set();
  (rec?.segments || []).forEach((s) => addPerson(speakers, s?.speaker));
  return speakers.size;
}
