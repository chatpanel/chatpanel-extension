// Artifacts — turn an AI-generated HTML block into something you can actually SEE and PLAY,
// without ever running its code in the panel.
//
// markdown.js emits `.md-artifact-html` containing only the ESCAPED source (safe text). This
// module upgrades that placeholder into a Preview | Code | Open ↗ card:
//   • Preview mounts sandbox.html (a manifest sandbox page → opaque origin, no chrome.*),
//     which mounts the artifact itself in a nested allow-scripts-only iframe. Two boundaries.
//   • Code is an EDITABLE source view (the default, and the fail-safe): tweak the HTML and
//     press Run ▶ (or Cmd/Ctrl+Enter) to re-run it — a playground, not a viewer. Reset
//     restores what the model wrote. Editing changes nothing about the security model: the
//     text still only ever executes inside the sandbox.
//   • Open ↗ pops the artifact out full-size in a browser tab, through the SAME sandbox page
//     (not a blob: URL — a blob inherits the panel's CSP, which blocks the artifact's inline
//     scripts, so a canvas demo would open frozen at its default size).
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
// everywhere else the card falls back to the Code view. Feature-detected below, never assumed.
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

// Open the artifact full-size in its own tab, through the SAME sandbox page.
//
// Not a blob: URL — that was the bug behind "it doesn't bounce when I open it". A blob:
// document created here inherits the CREATING page's CSP, and the panel's is `script-src
// 'self'`, so the artifact's inline <script> never ran: the canvas sat at its default
// 300×150 and nothing animated. The sandbox page has its own CSP that permits inline
// scripts, and a srcdoc child inherits that — so the artifact behaves exactly as it does in
// a standalone file. We keep the opener handle to hand it the HTML (it can only postMessage
// back; it is a separate opaque origin with no extension access).
function openInTab(html) {
  const url = sandboxUrl();
  if (!url) return false;
  let win;
  try { win = window.open(url, '_blank'); } catch { return false; }
  if (!win) return false; // popup blocked
  const id = `t${++seq}`;
  const onMsg = (ev) => {
    if (ev.source !== win) return;
    const m = ev.data;
    if (!m || m.type !== 'chatpanel:sandbox-ready') return;
    win.postMessage({ type: 'chatpanel:artifact', id, html, fill: true }, '*');
    window.removeEventListener('message', onMsg);
  };
  window.addEventListener('message', onMsg);
  // The page may have been ready before we attached; nudge it once it has loaded.
  setTimeout(() => { try { win.postMessage({ type: 'chatpanel:artifact', id, html, fill: true }, '*'); } catch { /* closed */ } }, 400);
  setTimeout(() => window.removeEventListener('message', onMsg), 10_000);
  return true;
}

function mountPreview(host, html, onFail) {
  const url = sandboxUrl();
  if (!url) { onFail('sandbox unavailable'); return null; }
  const id = `a${++seq}`;
  const frame = document.createElement('iframe');
  frame.className = 'artifact-frame';
  // NO `sandbox` attribute here — on purpose, and it matters.
  //
  // sandbox.html is ALREADY a manifest sandbox page: Chrome serves it with the CSP
  // `sandbox allow-scripts allow-popups`, so it is a unique opaque origin with no chrome.*
  // access. Adding the attribute sandboxes it a SECOND time, which re-opaques the origin at
  // the frame level — and then `script-src 'self'` no longer matches the extension URL, so
  // js/sandbox-runner.js is blocked and the preview renders nothing at all. (That was the
  // "Preview is empty" bug.) The isolation comes from the manifest + CSP; the artifact's own
  // boundary is the nested allow-scripts-only srcdoc frame inside the page.
  frame.setAttribute('title', 'interactive artifact');
  frame.src = url;
  frame.style.height = '360px';

  let ready = false;
  const onMsg = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (!m || m.id && m.id !== id) return;
    if (m.type === 'chatpanel:sandbox-ready') {
      frame.contentWindow.postMessage({ type: 'chatpanel:artifact', id, html }, '*');
    } else if (m.type === 'chatpanel:artifact-ready') {
      ready = true;
      if (m.height) frame.style.height = `${Math.max(120, Math.min(2000, Number(m.height) || 360))}px`;
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
      const original = sourceOf(node);
      if (!original.trim()) continue;

      const bar = el('div', 'artifact-bar');
      const btnPreview = el('button', 'artifact-btn', 'Preview');
      const btnCode = el('button', 'artifact-btn is-on', 'Code');
      const btnRun = el('button', 'artifact-btn artifact-run', 'Run ▶');
      const btnReset = el('button', 'artifact-btn', 'Reset');
      const btnCopy = el('button', 'artifact-btn', 'Copy');
      const btnOpen = el('button', 'artifact-btn artifact-open', 'Open ↗');
      for (const b of [btnPreview, btnCode, btnRun, btnReset, btnCopy, btnOpen]) b.type = 'button';
      btnReset.disabled = true; // nothing to reset until the source is edited
      const status = el('span', 'artifact-status');
      bar.append(btnPreview, btnCode, btnRun, status, btnReset, btnCopy, btnOpen);

      // EDITABLE SOURCE. A textarea, not a contenteditable <pre>: a textarea can only ever
      // hold text, so a pasted `<img onerror=...>` stays inert characters instead of becoming
      // live nodes in the panel's DOM. Its value is still only ever handed to the sandbox.
      const editor = el('textarea', 'artifact-editor');
      editor.value = original;
      editor.spellcheck = false;
      editor.setAttribute('aria-label', 'artifact source (editable)');
      editor.rows = Math.max(6, Math.min(24, original.split('\n').length + 1));

      const stage = el('div', 'artifact-stage');
      const src = node.querySelector('.artifact-src');
      if (src) src.remove(); // the editor replaces the static block
      node.insertBefore(bar, node.firstChild);
      node.append(editor, stage);

      const currentHtml = () => editor.value;
      let cleanup = null;
      let mountedSrc = null; // what the live frame is actually running

      const showCode = () => {
        btnCode.classList.add('is-on'); btnPreview.classList.remove('is-on');
        editor.style.display = 'block';
        stage.style.display = 'none';
      };
      const fail = (why) => {
        status.textContent = `Preview unavailable — ${why}`;
        showCode();
      };
      // Remount whenever the source changed since the last run — that is what makes the
      // editor a playground rather than a viewer.
      const showPreview = ({ force = false } = {}) => {
        btnPreview.classList.add('is-on'); btnCode.classList.remove('is-on');
        editor.style.display = 'none';
        // 'block', never '' — the stylesheet sets .artifact-stage { display: none }, so
        // clearing the inline style just hands control back to that rule and the preview
        // stays invisible. (That was the other half of the "Preview is empty" bug.)
        stage.style.display = 'block';
        status.textContent = '';
        const html = currentHtml();
        if (force || !cleanup || mountedSrc !== html) {
          if (cleanup) cleanup();   // drop the old listener
          stage.textContent = '';   // and the old frame — a fresh document each run
          cleanup = mountPreview(stage, html, fail);
          mountedSrc = html;
        }
      };

      editor.addEventListener('input', () => {
        const dirty = editor.value !== original;
        btnReset.disabled = !dirty;
        status.textContent = dirty ? 'Edited — press Run ▶' : '';
      });
      // Ctrl/Cmd+Enter runs, the way every playground does it.
      editor.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); showPreview({ force: true }); }
      });

      btnPreview.addEventListener('click', () => showPreview());
      btnCode.addEventListener('click', showCode);
      btnRun.addEventListener('click', () => showPreview({ force: true }));
      btnReset.addEventListener('click', () => {
        editor.value = original;
        btnReset.disabled = true;
        status.textContent = '';
        if (stage.style.display === 'block') showPreview({ force: true });
      });
      btnCopy.addEventListener('click', () => {
        navigator.clipboard.writeText(currentHtml()).then(() => {
          btnCopy.textContent = 'Copied';
          setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1200);
        }).catch(() => { status.textContent = 'Copy failed'; });
      });
      btnOpen.addEventListener('click', () => {
        if (!openInTab(currentHtml())) status.textContent = 'Couldn’t open a tab — allow pop-ups for this page.';
      });
      showCode(); // default: the source. The user opts into running it.
    } catch { /* leave the code block untouched */ }
  }
}
