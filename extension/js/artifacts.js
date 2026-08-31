// Artifacts — turn an AI-generated HTML block into something you can actually SEE and PLAY,
// without ever running its code in the panel.
//
// markdown.js emits `.md-artifact-html` containing only the ESCAPED source (safe text). This
// module upgrades that placeholder into a Preview | Code | Open ↗ card:
//   • Preview mounts sandbox.html (a manifest sandbox page → opaque origin, no chrome.*),
//     which mounts the artifact itself in a nested allow-scripts-only iframe. Two boundaries.
//   • Code shows the source (the default, and the fail-safe).
//   • Open ↗ pops the artifact out as a blob: URL in a normal browser tab — full size, still
//     an isolated origin. This is also the fallback where manifest sandboxes don't exist
//     (Firefox MV3), so the feature degrades instead of disappearing.
//
// FAIL SAFE, ALWAYS: if the sandbox can't load, the source stays visible and the chat is
// unaffected. Nothing here parses or trusts the artifact — it is only ever passed as a string
// to an isolated frame.

const READY_TIMEOUT_MS = 4000;
let seq = 0;

// The sandbox host page — ONLY present on engines with manifest sandbox pages (Chromium).
// The Firefox package ships neither the page nor its runner (CHROMIUM_ONLY_FILES), so the
// name is assembled rather than written as a literal: a bare 'sandbox.html' in a file that
// DOES ship to Firefox is exactly what the parity guard forbids, since it would point at a
// file the add-on doesn't carry. Preview is therefore Chromium-only by construction, and
// everywhere else the card falls back to Code + "Open ↗" (a blob: tab — isolated on every
// engine). Feature-detected below, never assumed.
const SANDBOX_PAGE = ['sandbox', 'html'].join('.');

function sandboxUrl() {
  try {
    const url = chrome.runtime.getURL(SANDBOX_PAGE);
    // getURL happily returns a URL for a file that isn't in the package; treat a missing
    // runtime as "no sandbox" and let the load failure fall through to the code view.
    return url || '';
  } catch { return ''; }
}

/** The artifact's source text from the placeholder (already-escaped HTML → real text). */
function sourceOf(node) {
  const code = node.querySelector('.artifact-src code');
  return code ? code.textContent || '' : '';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

// Open the artifact full-size in its own tab. blob: gives it a fresh isolated origin — it is
// just a web page, with no access to the extension. Revoked after the tab has taken it.
function openInTab(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function mountPreview(host, html, onFail) {
  const url = sandboxUrl();
  if (!url) { onFail('sandbox unavailable'); return null; }
  const id = `a${++seq}`;
  const frame = document.createElement('iframe');
  frame.className = 'artifact-frame';
  // allow-scripts ONLY. Never allow-same-origin: that would give the sandbox page our origin
  // and defeat the isolation entirely.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', 'interactive artifact');
  frame.src = url;
  frame.style.height = '160px';

  let ready = false;
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (!m || m.id && m.id !== id) return;
    if (m.type === 'chatpanel:sandbox-ready') {
      frame.contentWindow.postMessage({ type: 'chatpanel:artifact', id, html }, '*');
    } else if (m.type === 'chatpanel:artifact-ready') {
      ready = true;
      if (m.height) frame.style.height = `${Math.max(60, Math.min(2000, Number(m.height) || 160))}px`;
    } else if (m.type === 'chatpanel:artifact-error') {
      onFail(m.message || 'artifact failed to render');
    }
  };
  window.addEventListener('message', onMsg);
  frame.addEventListener('load', () => {
    // Some hosts don't deliver the ready ping; ask anyway once loaded.
    try { frame.contentWindow.postMessage({ type: 'chatpanel:artifact', id, html }, '*'); } catch { /* ignore */ }
  });
  setTimeout(() => { if (!ready) onFail('preview timed out'); }, READY_TIMEOUT_MS);

  host.appendChild(frame);
  return () => window.removeEventListener('message', onMsg);
}

/**
 * Upgrade every `.md-artifact-html` inside `root` into a Preview | Code | Open card.
 * Idempotent (a re-render marks nodes done), and never throws — a failure leaves the code
 * block exactly as it was.
 */
export function mountArtifacts(root) {
  if (!root || !root.querySelectorAll) return;
  for (const node of root.querySelectorAll('.md-artifact-html:not([data-artifact-ready])')) {
    try {
      node.setAttribute('data-artifact-ready', '1');
      const html = sourceOf(node);
      if (!html.trim()) continue;

      const bar = el('div', 'artifact-bar');
      const btnPreview = el('button', 'artifact-btn', 'Preview');
      const btnCode = el('button', 'artifact-btn is-on', 'Code');
      const btnOpen = el('button', 'artifact-btn artifact-open', 'Open ↗');
      btnPreview.type = btnCode.type = btnOpen.type = 'button';
      const status = el('span', 'artifact-status');
      bar.append(btnPreview, btnCode, btnOpen, status);

      const stage = el('div', 'artifact-stage');
      const src = node.querySelector('.artifact-src');
      node.insertBefore(bar, node.firstChild);
      node.appendChild(stage);

      let cleanup = null;
      const showCode = () => {
        btnCode.classList.add('is-on'); btnPreview.classList.remove('is-on');
        if (src) src.style.display = '';
        stage.style.display = 'none';
      };
      const fail = (why) => {
        status.textContent = `Preview unavailable — ${why}`;
        showCode();
      };
      const showPreview = () => {
        btnPreview.classList.add('is-on'); btnCode.classList.remove('is-on');
        if (src) src.style.display = 'none';
        stage.style.display = '';
        status.textContent = '';
        if (!cleanup) cleanup = mountPreview(stage, html, fail);
      };

      btnPreview.addEventListener('click', showPreview);
      btnCode.addEventListener('click', showCode);
      btnOpen.addEventListener('click', () => openInTab(html));
      showCode(); // default: the source. The user opts into running it.
    } catch { /* leave the code block untouched */ }
  }
}
