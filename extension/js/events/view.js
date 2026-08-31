// GENERATED — do not edit.
// Source of truth: chatpanel-events/view.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// CAPABILITY VIEWS — a capability may ship its own UI, so a result can be an interactive
// component instead of a paragraph of text.
//
// This is NOT the model writing HTML. That already exists (an ```html artifact runs in the
// sandbox) and is deliberately powerless: it is untrusted text, so it can only draw. A view
// is declared by a capability that a user or admin approved at load time, which is what
// makes it safe to give it something a model-authored page can never have — the ability to
// ACT, by invoking capabilities.
//
// The rule that keeps that safe is one line: a view may invoke only what its own capability
// is already allowed to invoke. A calculator view can compute because its capability may; it
// cannot read history unless that capability was granted `history` in the first place. There
// is no path here that widens a permission — `mayInvoke` can only ever name capabilities the
// declaring capability already lists in `requires`, and validateViewInvocation refuses
// anything outside that set before the kernel is ever consulted.
//
// Pure and host-free by design: no DOM, no postMessage, no chrome.*. The client owns the
// transport; this owns what is legal to say over it.

import { EventError } from './event.js';

const str = (v) => typeof v === 'string' && v.length > 0;

/**
 * Validate a view DECLARATION. Like the rest of the capability contract this must be
 * readable — and therefore approvable — without executing anything.
 */
export function validateView(view, capability = null) {
  if (!view || typeof view !== 'object') throw new EventError('SHAPE', 'view must be an object');
  if (!str(view.id)) throw new EventError('SHAPE', 'view.id required');
  if (!str(view.html)) throw new EventError('SHAPE', 'view.html required — a self-contained document');
  if (view.mayInvoke != null && !(Array.isArray(view.mayInvoke) && view.mayInvoke.every(str))) {
    throw new EventError('SHAPE', 'view.mayInvoke must be string[]');
  }
  // NO PRIVILEGE ESCALATION BY DECLARATION. A view is part of its capability, so it cannot
  // reach past it: every id it wants to call must already be in that capability's `requires`
  // (or be the capability itself). Caught here, at approval time, rather than at call time.
  if (capability && view.mayInvoke?.length) {
    const allowed = new Set([capability.id, ...(capability.requires || [])]);
    const extra = view.mayInvoke.filter((id) => !allowed.has(id));
    if (extra.length) {
      throw new EventError('CONTRADICTION',
        `view.mayInvoke exceeds its capability: ${extra.join(', ')} not in requires`);
    }
  }
  if (view.height != null && !(Number.isInteger(view.height) && view.height > 0 && view.height <= 2000)) {
    throw new EventError('SHAPE', 'view.height must be a positive integer <= 2000');
  }
  return view;
}

/**
 * Turn a message a VIEW sent into a capability invocation the kernel can judge — or refuse
 * it. The view is sandboxed and its messages are untrusted input, so nothing here trusts a
 * field: the capability id is checked against what the declaration allows, not against what
 * the message claims to be entitled to.
 *
 * Returns { capability, args, callId }. Throws EventError otherwise.
 */
export function validateViewInvocation(msg, capability) {
  if (!capability?.view) throw new EventError('SHAPE', 'capability declares no view');
  if (!msg || typeof msg !== 'object') throw new EventError('SHAPE', 'view message must be an object');
  if (!str(msg.callId)) throw new EventError('SHAPE', 'view message needs a callId to correlate its result');
  if (!str(msg.capability)) throw new EventError('SHAPE', 'view message must name a capability');

  const allowed = new Set([capability.id, ...(capability.view.mayInvoke || [])]);
  if (!allowed.has(msg.capability)) {
    // The important refusal. A compromised or buggy view asking for something else stops
    // here, before any kernel guard has to have an opinion about it.
    throw new EventError('DENIED',
      `view of "${capability.id}" may not invoke "${msg.capability}"`);
  }
  if (msg.args != null && (typeof msg.args !== 'object' || Array.isArray(msg.args))) {
    throw new EventError('SHAPE', 'view invocation args must be an object');
  }
  return { capability: msg.capability, args: msg.args || {}, callId: msg.callId };
}

/**
 * The state a view is mounted with, as it appears on a capability RESULT. Kept separate from
 * the canonical value: `value` is what the capability computed and what everything else
 * reasons about; `view`/`state` are only how it is shown. A host that cannot render views
 * ignores these two fields and still has the whole answer.
 */
export function viewResult(value, capability, state = null) {
  if (!capability?.view) return { value };
  return { value, view: capability.view.id, state: state ?? value };
}
