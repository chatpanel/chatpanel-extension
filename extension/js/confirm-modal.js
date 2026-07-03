// Branded confirm dialog for DESTRUCTIVE actions — one modal, one look, called EVERYWHERE
// instead of native confirm() (which is also unreliable inside side panels). Reusable across
// every ChatPanel surface: notes, chats, meetings, settings, the side panel.
//
// Promise-based: resolves true ONLY on an explicit confirm click. Escape, the backdrop, and
// Cancel resolve false; Enter does NOT confirm — a stray keypress can never delete — and
// Cancel is focused by default. Dependency-free and self-contained (injects its own scoped,
// theme-aware styles once) so it can be dynamic-imported at a delete call site with zero
// first-paint cost. Styling rides the host page's CSS vars (--panel/--text/--border/--accent),
// with dark fallbacks, so it looks native on every page + theme.

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || document.getElementById('cp-confirm-styles')) { stylesInjected = true; return; }
  stylesInjected = true;
  const el = document.createElement('style');
  el.id = 'cp-confirm-styles';
  el.textContent = `
  .cp-confirm-ov{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(10,12,16,.45);padding:16px;animation:cp-confirm-fade .12s ease}
  .cp-confirm-card{width:100%;max-width:420px;background:var(--panel,var(--card,var(--bg,#1b1d22)));color:var(--text,var(--fg,#e8e8ea));border:1px solid var(--border,#33363d);border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.45);padding:18px 18px 16px;font:13.5px/1.5 var(--font,system-ui,-apple-system,sans-serif);animation:cp-confirm-pop .14s cubic-bezier(.2,.9,.3,1.2)}
  .cp-confirm-head{display:flex;align-items:center;gap:11px;margin-bottom:10px}
  .cp-confirm-ic{flex:none;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:color-mix(in srgb,var(--danger,#dc2626) 15%,transparent);color:var(--danger,#dc2626)}
  .cp-confirm-ic svg{width:18px;height:18px}
  .cp-confirm-title{font-weight:650;font-size:14.5px}
  .cp-confirm-body{opacity:.82;margin:0 0 16px;word-break:break-word}
  .cp-confirm-row{display:flex;gap:8px;justify-content:flex-end}
  .cp-confirm-btn{cursor:pointer;border-radius:9px;padding:8px 14px;font:inherit;font-weight:600;border:1px solid transparent}
  .cp-confirm-cancel{background:transparent;color:inherit;border-color:var(--border,#33363d)}
  .cp-confirm-cancel:hover{background:var(--hover,rgba(127,127,127,.12))}
  .cp-confirm-danger{background:var(--danger,#dc2626);color:#fff}
  .cp-confirm-danger:hover{filter:brightness(1.07)}
  .cp-confirm-btn:focus-visible{outline:2px solid var(--accent,#4f7cff);outline-offset:2px}
  @keyframes cp-confirm-fade{from{opacity:0}to{opacity:1}}
  @keyframes cp-confirm-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.cp-confirm-ov,.cp-confirm-card{animation:none}}
  `;
  document.head.appendChild(el);
}

// Trash icon (inline so the modal has no icon-system dependency and paints instantly).
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// Resolve true only on an explicit confirm. `icon` accepts inline SVG markup (defaults to a
// trash glyph). Pass `confirmLabel` for the danger button (e.g. 'Delete' | 'Reset' | 'Clear').
export function confirmDelete({ title = 'Delete?', body = '', confirmLabel = 'Delete', icon = TRASH_ICON } = {}) {
  injectStyles();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'cp-confirm-ov';
    ov.setAttribute('role', 'alertdialog');
    ov.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'cp-confirm-card';

    const head = document.createElement('div');
    head.className = 'cp-confirm-head';
    const ic = document.createElement('div');
    ic.className = 'cp-confirm-ic';
    ic.innerHTML = icon;
    const t = document.createElement('div');
    t.className = 'cp-confirm-title';
    t.textContent = title;
    head.append(ic, t);
    card.append(head);

    if (body) {
      const b = document.createElement('div');
      b.className = 'cp-confirm-body';
      b.textContent = body;
      card.append(b);
    }

    const row = document.createElement('div');
    row.className = 'cp-confirm-row';

    let settled = false;
    const done = (v) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };

    const cancel = document.createElement('button');
    cancel.className = 'cp-confirm-btn cp-confirm-cancel';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(false);

    const ok = document.createElement('button');
    ok.className = 'cp-confirm-btn cp-confirm-danger';
    ok.textContent = confirmLabel;
    ok.onclick = () => done(true);

    row.append(cancel, ok);
    card.append(row);
    ov.append(card);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    cancel.focus(); // safe default — Enter can't confirm
  });
}
