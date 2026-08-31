// GENERATED — do not edit.
// Source of truth: chatpanel-events/widget.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// WIDGETS — small apps the user asks for and the model builds, which then live in THEIR
// ChatPanel. A timer, a calculator, a sticky note, a unit converter, a habit tracker: things
// nobody should have to file a feature request for. Two people's ChatPanel can differ
// entirely, without either of them writing code and without us shipping a release.
//
// A widget is NOT a capability. A capability is reviewed and approved before it runs, so it
// can be trusted to act. A widget is written by a model on a user's whim, so it is treated as
// exactly what it is — untrusted code — and given the smallest surface that still makes it
// useful:
//
//   • its own state, and nothing else's. `state` is a private object keyed by widget id. A
//     timer remembers where it got to; a sticky note remembers its text. No widget can read
//     another's, and none can read the user's notes, meetings or chats.
//   • no network, no chrome.*, no DOM outside its sandbox — enforced by the host, not by
//     good behaviour here.
//
// Anything beyond that is a GRANT: a widget may REQUEST capabilities in its manifest, and
// those do nothing until the user approves them. Requesting is not receiving — `grants` is
// stored separately from the manifest precisely so a widget cannot edit its own permissions
// by rewriting its own code.
//
// Pure and host-free: no DOM, no storage, no postMessage. The client owns the transport and
// the persistence; this owns what is legal.

import { EventError } from './event.js';

const str = (v) => typeof v === 'string' && v.length > 0;
const MAX_HTML = 512 * 1024;   // a small app, not a bundled framework
const MAX_STATE = 256 * 1024;  // a note, a lap list — not a database

export const WIDGET_SURFACES = Object.freeze(['panel', 'chat']);

/**
 * Validate a widget MANIFEST — everything a user sees before deciding to keep it.
 */
export function validateWidget(w) {
  if (!w || typeof w !== 'object') throw new EventError('SHAPE', 'widget must be an object');
  if (!str(w.id)) throw new EventError('SHAPE', 'widget.id required');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(w.id)) {
    throw new EventError('SHAPE', 'widget.id must be lowercase [a-z0-9_-], max 64 chars');
  }
  if (!str(w.name)) throw new EventError('SHAPE', 'widget.name required');
  if (!str(w.html)) throw new EventError('SHAPE', 'widget.html required');
  if (w.html.length > MAX_HTML) throw new EventError('SHAPE', `widget.html exceeds ${MAX_HTML} bytes`);
  // An icon NAME (the client maps it to its own icon set), so a pinned widget is
  // recognisable at a glance rather than being one of five identical marks.
  if (w.icon != null && !(str(w.icon) && /^[a-z][a-z0-9-]{0,31}$/.test(w.icon))) {
    throw new EventError('SHAPE', 'widget.icon must be an icon name like "timer"');
  }
  if (w.surface != null && !WIDGET_SURFACES.includes(w.surface)) {
    throw new EventError('SHAPE', `widget.surface must be one of ${WIDGET_SURFACES}`);
  }
  if (w.height != null && !(Number.isInteger(w.height) && w.height > 0 && w.height <= 2000)) {
    throw new EventError('SHAPE', 'widget.height must be a positive integer <= 2000');
  }
  // Requesting is not receiving. This only records what the widget WANTS; the grant lives
  // outside the manifest so rewriting the widget can never widen its own permissions.
  if (w.requests != null && !(Array.isArray(w.requests) && w.requests.every(str))) {
    throw new EventError('SHAPE', 'widget.requests must be string[] (capability ids it asks for)');
  }
  return w;
}

/**
 * Validate a message a widget sent. Untrusted input: nothing is believed, and the widget's
 * own id is supplied by the HOST (which knows which frame sent it), never read from the
 * message — otherwise a widget could name someone else's id and read their state.
 */
export function validateWidgetMessage(msg, { widgetId, grants = [] } = {}) {
  if (!str(widgetId)) throw new EventError('SHAPE', 'host must supply the sending widget id');
  if (!msg || typeof msg !== 'object') throw new EventError('SHAPE', 'widget message must be an object');
  if (!str(msg.callId)) throw new EventError('SHAPE', 'widget message needs a callId');

  switch (msg.op) {
    case 'state.get':
      return { op: 'state.get', widgetId, callId: msg.callId };

    case 'state.set': {
      if (msg.state === undefined) throw new EventError('SHAPE', 'state.set needs state');
      let size = 0;
      try { size = JSON.stringify(msg.state ?? null).length; }
      catch { throw new EventError('SHAPE', 'widget state must be JSON-serialisable'); }
      if (size > MAX_STATE) throw new EventError('SHAPE', `widget state exceeds ${MAX_STATE} bytes`);
      return { op: 'state.set', widgetId, callId: msg.callId, state: msg.state };
    }

    case 'invoke': {
      if (!str(msg.capability)) throw new EventError('SHAPE', 'invoke must name a capability');
      // THE REFUSAL THAT MATTERS. A widget gets what the user granted it and nothing else —
      // checked here, before any kernel guard has to have an opinion, and against the stored
      // grants rather than against anything the widget or its manifest claims.
      if (!grants.includes(msg.capability)) {
        throw new EventError('DENIED',
          `widget "${widgetId}" has no grant for "${msg.capability}" — the user must approve it first`);
      }
      if (msg.args != null && (typeof msg.args !== 'object' || Array.isArray(msg.args))) {
        throw new EventError('SHAPE', 'invoke args must be an object');
      }
      return { op: 'invoke', widgetId, callId: msg.callId, capability: msg.capability, args: msg.args || {} };
    }

    default:
      throw new EventError('SHAPE', `unknown widget op "${msg.op}"`);
  }
}

/**
 * The permissions a widget actually holds: the intersection of what it asked for and what the
 * user approved. Asking for more later cannot grant it — a request that was never approved
 * stays absent, so an updated widget re-asking silently gains nothing.
 */
export function effectiveGrants(widget, approved = []) {
  const asked = new Set(widget?.requests || []);
  return (approved || []).filter((id) => asked.has(id));
}

// Pick an icon for a widget from what it is called. A pinned widget sits in a narrow strip
// next to the others, so five identical marks are worse than no icon at all — the point of
// pinning is to find the thing without reading.
//
// Returns an icon NAME, not a glyph: the client owns how it is drawn (the extension resolves
// these through its vendored set, a mobile client through its own), and a name survives that
// mapping in a way an emoji does not. Every name here exists in the extension's icon set.
const ICON_WORDS = [
  [/\b(timers?|pomodoro|stopwatch|countdowns?|intervals?)\b/i, 'timer'],
  [/\b(calc|calculators?|math|arithmetic|tip)\b/i, 'hash'],
  [/\b(notes?|sticky|scratch|memos?|journals?)\b/i, 'notebook-pen'],
  [/\b(todos?|tasks?|checklists?|habits?|trackers?)\b/i, 'list-checks'],
  [/\b(charts?|graphs?|stats?|metrics?|dashboards?)\b/i, 'bar-chart-3'],
  [/\b(convert|converters?|units?|currency|exchange|weights?)\b/i, 'scale'],
  [/\b(calendars?|schedules?|agendas?|dates?)\b/i, 'calendar'],
  [/\b(clocks?|time|timezones?|zones?)\b/i, 'clock'],
  [/\b(goals?|targets?|focus|okrs?)\b/i, 'target'],
  [/\b(ideas?|brainstorm|prompts?)\b/i, 'lightbulb'],
  [/\b(dice|random|rolls?|roller|coins?|shuffle)\b/i, 'zap'],
  [/\b(search|find|lookup)\b/i, 'search'],
  [/\b(web|urls?|links?|browser)\b/i, 'globe'],
  [/\b(mood|mind|memory|brain)\b/i, 'brain'],
  [/\b(password|secrets?|vault|lock)\b/i, 'lock'],
  [/\b(quotes?|sayings?)\b/i, 'quote'],
  [/\b(meetings?|standups?|people|team)\b/i, 'users'],
  [/\b(music|player|sound|audio)\b/i, 'play'],
  [/\b(photos?|images?|gallery)\b/i, 'image'],
  [/\b(files?|documents?|docs?)\b/i, 'file-text'],
];

/** The widget's own icon if it declared one, else one derived from its name. */
export function widgetIcon(widget) {
  if (widget?.icon) return widget.icon;
  const name = String(widget?.name || '');
  for (const [re, iconName] of ICON_WORDS) if (re.test(name)) return iconName;
  return 'app-window'; // generic, but never the mark the shelf itself uses
}
