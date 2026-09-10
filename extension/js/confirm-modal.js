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
  .cp-confirm-body{opacity:.82;margin:0 0 16px;word-break:break-word;max-height:38vh;overflow-y:auto}
  .cp-confirm-title{overflow-wrap:anywhere}
  .cp-confirm-card{max-height:86vh;overflow-y:auto}
  /* The buttons must stay reachable no matter what the body does — a confirm you cannot
     click is worse than no confirm at all. */
  .cp-confirm-row{position:sticky;bottom:0;background:inherit;padding-top:2px}
  .cp-confirm-row{display:flex;gap:8px;justify-content:flex-end}
  .cp-confirm-btn{cursor:pointer;border-radius:9px;padding:8px 14px;font:inherit;font-weight:600;border:1px solid transparent}
  .cp-confirm-cancel{background:transparent;color:inherit;border-color:var(--border,#33363d)}
  .cp-confirm-cancel:hover{background:var(--hover,rgba(127,127,127,.12))}
  .cp-confirm-danger{background:var(--danger,#dc2626);color:#fff}
  .cp-confirm-danger:hover{filter:brightness(1.07)}
  .cp-confirm-btn:focus-visible{outline:2px solid var(--accent,#4f7cff);outline-offset:2px}
  @keyframes cp-confirm-fade{from{opacity:0}to{opacity:1}}
  @keyframes cp-confirm-pop{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  .cp-secret-input,.cp-secret-verify{width:100%;box-sizing:border-box;margin-bottom:8px;padding:9px 11px;border-radius:9px;border:1px solid var(--border,#33363d);background:var(--bg,#111318);color:inherit;font:inherit}
  .cp-secret-input:focus,.cp-secret-verify:focus{outline:none;border-color:var(--accent,#4f7cff)}
  .cp-secret-err{color:var(--danger,#dc2626);font-size:12.5px;margin-bottom:8px}
  .cp-secret-ok,.cp-prompt-ok{background:var(--accent,#4f7cff);color:#fff}
  .cp-secret-ok:hover,.cp-prompt-ok:hover{filter:brightness(1.07)}
  .cp-confirm-btn:disabled{opacity:.45;cursor:not-allowed;filter:none}
  /* An ASK is not a warning: the same card, tinted with the accent instead of the danger red. */
  .cp-confirm-ic.cp-ic-ask{background:color-mix(in srgb,var(--accent,#4f7cff) 15%,transparent);color:var(--accent,#4f7cff)}
  .cp-prompt-label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;opacity:.6;margin:0 0 5px}
  .cp-prompt-input,.cp-prompt-select{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid var(--border,#33363d);background:var(--bg,#111318);color:inherit;font:inherit}
  .cp-prompt-input{resize:vertical;min-height:38px;line-height:1.45}
  .cp-prompt-input:focus,.cp-prompt-select:focus{outline:none;border-color:var(--accent,#4f7cff);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#4f7cff) 20%,transparent)}
  .cp-prompt-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:15px;margin:6px 0 12px;font-size:12px;opacity:.6}
  .cp-prompt-count{font-variant-numeric:tabular-nums;margin-left:auto}
  .cp-prompt-count.over{color:var(--danger,#dc2626);opacity:1}
  .cp-prompt-field{margin-bottom:12px}
  .cp-prompt-hint{font-size:12px;opacity:.6;margin-top:5px}
  @media (prefers-reduced-motion:reduce){.cp-confirm-ov,.cp-confirm-card{animation:none}}
  `;
  document.head.appendChild(el);
}

// Trash icon (inline so the modal has no icon-system dependency and paints instantly).
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/**
 * A dialog is never sized by the thing it is asking about.
 *
 * Callers name what is being deleted — "“{title}” will be deleted" — and a chat's title can be
 * the first thing someone dictated into it, which is as long as they kept talking. One of
 * those filled the entire side panel with a wall of transcript and buried the two buttons
 * off-screen, so the only way out of "are you sure?" was to guess.
 *
 * Clamped HERE rather than at each call site: there are a dozen of them, they all interpolate
 * something a user typed, and the next one added will not remember. The CSS cap below is the
 * second line of defence for a long unbroken string that no character count can shorten.
 */
const clamp = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const MAX_TITLE = 80;
const MAX_BODY = 220;

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
    t.textContent = clamp(title, MAX_TITLE) || 'Delete?';
    head.append(ic, t);
    card.append(head);

    const bodyText = clamp(body, MAX_BODY);
    if (bodyText) {
      const b = document.createElement('div');
      b.className = 'cp-confirm-body';
      b.textContent = bodyText;
      // The full text stays reachable on hover for the rare case where the tail mattered.
      if (bodyText !== String(body ?? '').trim()) b.title = String(body);
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

// A passphrase prompt, in the same modal so a request for a secret can never be mistaken for
// part of the page that asked for it.
//
// THE HOST OWNS THIS, ALWAYS. A widget or a page that collected the passphrase itself would
// be a widget that has the passphrase; here it never leaves this dialog — the caller gets an
// unlocked vault or nothing. Enter DOES submit (unlike the destructive dialog, where a stray
// keypress must not delete): typing a password and pressing return is the expected motion.
export function promptSecret({
  title = 'Passphrase', body = '', label = 'Passphrase', confirmLabel = 'Unlock',
  placeholder = '', verify = null,
} = {}) {
  injectStyles();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'cp-confirm-ov';
    ov.setAttribute('role', 'dialog');
    ov.innerHTML = `
      <div class="cp-confirm-card">
        <div class="cp-confirm-head"><div class="cp-confirm-title"></div></div>
        <p class="cp-confirm-body"></p>
        <input type="password" class="cp-secret-input" autocomplete="current-password" spellcheck="false" />
        <input type="password" class="cp-secret-verify" autocomplete="new-password" spellcheck="false" hidden />
        <div class="cp-secret-err" hidden></div>
        <div class="cp-confirm-row">
          <button class="cp-confirm-btn cp-confirm-cancel" type="button">Cancel</button>
          <button class="cp-confirm-btn cp-secret-ok" type="button"></button>
        </div>
      </div>`;
    // Text, never innerHTML: a title can carry an entry name the user typed.
    ov.querySelector('.cp-confirm-title').textContent = clamp(title, MAX_TITLE);
    ov.querySelector('.cp-confirm-body').textContent = clamp(body, MAX_BODY);
    ov.querySelector('.cp-secret-ok').textContent = confirmLabel;
    const input = ov.querySelector('.cp-secret-input');
    const second = ov.querySelector('.cp-secret-verify');
    const err = ov.querySelector('.cp-secret-err');
    input.placeholder = placeholder || label;
    if (verify) {
      second.hidden = false;
      second.placeholder = 'Repeat it';
    }
    document.body.appendChild(ov);
    input.focus();

    const close = (value) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const submit = () => {
      const value = input.value;
      if (!value) { show('Type your passphrase'); return; }
      // A vault whose passphrase was mistyped at creation is a vault nobody can ever open,
      // and there is no recovery path by design — so creation asks twice.
      if (verify && value !== second.value) { show('Those do not match'); return; }
      if (verify && value.length < 8) { show('Use at least 8 characters'); return; }
      close(value);
    };
    function show(msg) { err.hidden = false; err.textContent = msg; }
    ov.querySelector('.cp-confirm-cancel').onclick = () => close(null);
    ov.querySelector('.cp-secret-ok').onclick = submit;
    ov.onclick = (e) => { if (e.target === ov) close(null); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && (e.target === input || e.target === second)) submit();
    };
    document.addEventListener('keydown', onKey);
  });
}

// Pencil glyph — the default for an ask, inline for the same reason the trash one is.
const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

/**
 * ASK FOR A LINE OF TEXT — the non-destructive sibling of `confirmDelete`, and the reason
 * native `prompt()` never has to appear in a ChatPanel surface again.
 *
 * A native prompt is an OS chrome box titled "The extension ChatPanel says", with no styling,
 * no character budget, no hint about what a good answer looks like and no second field. It is
 * also blocked outright in some contexts (side panels, sandboxed frames), so a feature built on
 * it is a feature that silently does nothing. Everything that asked the user to type something
 * comes here instead.
 *
 * Enter submits (Shift+Enter makes a newline in a multiline field) — the value is one short
 * line and typing it then pressing return is the expected motion; Escape, the backdrop and
 * Cancel all resolve null. Submit stays disabled until the text is long enough and within
 * `maxLength`, so the modal enforces the same bounds the store would, before the round trip.
 *
 * @param opts.choice  optional second field: `{ label, value, options: [{value,label,hint}] }`
 *                     — for a value that has a TYPE as well as a text (a memory's kind).
 * @returns Promise<{text: string, choice: string}|null> — null when dismissed.
 */
export function promptText({
  title = 'Add', body = '', label = '', placeholder = '', value = '',
  confirmLabel = 'Save', cancelLabel = 'Cancel', hint = '',
  multiline = false, maxLength = 0, minLength = 1,
  icon = PENCIL_ICON, choice = null,
} = {}) {
  injectStyles();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'cp-confirm-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'cp-confirm-card';

    const head = document.createElement('div');
    head.className = 'cp-confirm-head';
    const ic = document.createElement('div');
    ic.className = 'cp-confirm-ic cp-ic-ask';
    ic.innerHTML = icon;
    const t = document.createElement('div');
    t.className = 'cp-confirm-title';
    t.textContent = clamp(title, MAX_TITLE) || 'Add';
    head.append(ic, t);
    card.append(head);

    if (body) {
      const b = document.createElement('div');
      b.className = 'cp-confirm-body';
      b.style.marginBottom = '12px';
      b.textContent = clamp(body, MAX_BODY);
      card.append(b);
    }

    if (label) {
      const l = document.createElement('label');
      l.className = 'cp-prompt-label';
      l.textContent = label;
      l.htmlFor = 'cp-prompt-input';
      card.append(l);
    }

    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.id = 'cp-prompt-input';
    input.className = 'cp-prompt-input';
    input.value = String(value ?? '');
    input.placeholder = placeholder;
    input.spellcheck = true;
    if (multiline) input.rows = 2;
    // maxLength is a hint here, not the guard: the counter below is what tells the user why
    // the button is dead, and a hard cap that silently eats keystrokes reads as a broken field.
    const cap = Number(maxLength) || 0;
    card.append(input);

    const foot = document.createElement('div');
    foot.className = 'cp-prompt-foot';
    if (hint) {
      const h = document.createElement('span');
      h.textContent = hint;
      foot.append(h);
    }
    const count = document.createElement('span');
    count.className = 'cp-prompt-count';
    if (cap) foot.append(count);
    if (foot.childElementCount) card.append(foot);
    else input.style.marginBottom = '12px';

    let choiceSel = null;
    if (choice?.options?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'cp-prompt-field';
      if (choice.label) {
        const cl = document.createElement('label');
        cl.className = 'cp-prompt-label';
        cl.textContent = choice.label;
        cl.htmlFor = 'cp-prompt-choice';
        wrap.append(cl);
      }
      choiceSel = document.createElement('select');
      choiceSel.id = 'cp-prompt-choice';
      choiceSel.className = 'cp-prompt-select';
      for (const o of choice.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label || o.value;
        if (o.hint) opt.title = o.hint;
        opt.selected = o.value === choice.value;
        choiceSel.append(opt);
      }
      const ch = document.createElement('div');
      ch.className = 'cp-prompt-hint';
      const hintFor = (v) => choice.options.find((o) => o.value === v)?.hint || '';
      ch.textContent = hintFor(choiceSel.value);
      choiceSel.onchange = () => { ch.textContent = hintFor(choiceSel.value); };
      wrap.append(choiceSel, ch);
      card.append(wrap);
    }

    const row = document.createElement('div');
    row.className = 'cp-confirm-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cp-confirm-btn cp-confirm-cancel';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'cp-confirm-btn cp-prompt-ok';
    ok.textContent = confirmLabel;
    row.append(cancel, ok);
    card.append(row);
    ov.append(card);

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(v);
    };
    const text = () => input.value.trim();
    const valid = () => text().length >= minLength && (!cap || text().length <= cap);
    const sync = () => {
      if (cap) {
        count.textContent = `${text().length}/${cap}`;
        count.classList.toggle('over', text().length > cap);
      }
      ok.disabled = !valid();
      if (multiline) {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      }
    };
    const submit = () => { if (valid()) done({ text: text(), choice: choiceSel ? choiceSel.value : (choice?.value ?? '') }); };

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    input.oninput = sync;
    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      submit();
    };
    cancel.onclick = () => done(null);
    ok.onclick = submit;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    sync();
    input.focus();
    if (input.value) input.select();
  });
}
