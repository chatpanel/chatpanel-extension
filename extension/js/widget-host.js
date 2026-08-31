// Mounts a user's widget and answers what it asks for.
//
// The trust boundary in one paragraph: the widget runs in the same opaque-origin sandbox as
// any artifact (no chrome.*, no extension storage, no same-origin), and it can only speak to
// this host by postMessage. THIS file is the only thing that decides what an answer is. The
// widget's identity is not read from its message — it is whatever this host mounted in that
// frame — so a widget naming another widget's id reads its own state, not theirs.
//
// What a widget gets by default is deliberately tiny: its own state. A timer remembering
// where it got to and a sticky note remembering its text need nothing else, and that covers
// almost everything people ask for. Anything beyond that is a capability the user granted,
// checked by the shared contract before it reaches the kernel.

import { validateWidgetMessage } from './events/widget.js';
import { getWidgetState, setWidgetState } from './widgets-store.js';

// The sandbox host page ships only on engines with manifest sandbox pages (Chromium); the
// Firefox package carries neither it nor its runner. The name is assembled rather than
// written as a literal for the same reason artifacts.js does it — a bare reference in a file
// that DOES ship to Firefox would point at a file the add-on doesn't have. Widgets are
// therefore Chromium-only by construction, and mountWidget returns null elsewhere rather
// than rendering a broken frame.
const SANDBOX_PAGE = ['sandbox', 'html'].join('.');

/**
 * Mount `record` (a stored { manifest, grants }) into `container`.
 * `invokeCapability(id, args)` is supplied by the caller so this module stays unaware of the
 * kernel; pass nothing and a granted call simply fails, which is the safe default.
 */
export function mountWidget(container, record, { invokeCapability = null } = {}) {
  const { manifest, grants = [] } = record || {};
  if (!manifest?.html) return null;
  let sandboxUrl = '';
  try { sandboxUrl = chrome.runtime.getURL(SANDBOX_PAGE); } catch { sandboxUrl = ''; }
  if (!sandboxUrl) return null; // no sandbox page on this engine — no place safe to run it

  const frame = document.createElement('iframe');
  frame.className = 'widget-frame';
  frame.src = sandboxUrl;
  // NO sandbox attribute: sandbox.html is already a manifest sandbox page, and re-sandboxing
  // re-opaques its origin so its own script-src stops matching and the runner never loads.
  frame.height = String(manifest.height || 180);
  container.appendChild(frame);

  const post = (msg) => { try { frame.contentWindow?.postMessage(msg, '*'); } catch { /* gone */ } };

  async function answer(call) {
    // The id comes from what WE mounted, never from the message.
    const req = validateWidgetMessage(call, { widgetId: manifest.id, grants });
    if (req.op === 'state.get') return getWidgetState(manifest.id);
    if (req.op === 'state.set') return setWidgetState(manifest.id, req.state);
    if (req.op === 'invoke') {
      if (!invokeCapability) throw new Error('capabilities are not available here');
      return invokeCapability(req.capability, req.args);
    }
    throw new Error('unsupported');
  }

  const onMessage = async (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'chatpanel:artifact-ready' && !manifest.height) {
      frame.height = String(msg.height || 180);
      return;
    }
    if (msg.type !== 'chatpanel:widget-call' || !msg.call) return;
    const { callId } = msg.call;
    try {
      const value = await answer(msg.call);
      post({ type: 'chatpanel:widget-result', callId, ok: true, value: value ?? null });
    } catch (e) {
      // Refusals travel back to the widget as errors, so it can say so in its own UI rather
      // than hanging on a promise that never settles.
      post({ type: 'chatpanel:widget-result', callId, ok: false, error: String(e?.message || e) });
    }
  };
  window.addEventListener('message', onMessage);

  frame.addEventListener('load', () => {
    post({ type: 'chatpanel:artifact', id: `widget:${manifest.id}`, html: manifest.html, widget: true });
  });

  return {
    frame,
    destroy() {
      window.removeEventListener('message', onMessage);
      frame.remove();
    },
  };
}
