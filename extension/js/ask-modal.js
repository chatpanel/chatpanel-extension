// The card a turn asks a person on — "allow this destructive action?", "save this recipe?",
// "save this team?". Its own module so the side panel's first paint carries the delete
// confirm and the secret prompt only; a card that appears mid-turn is loaded mid-turn.
// Vendored into the desktop (sync:editor) as the same card over the same styles.

import { modalParts } from './confirm-modal.js';

const { injectStyles, clamp, MAX_TITLE, MAX_BODY, TRASH_ICON } = modalParts;
const ASK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>';

/**
 * A turn asking the person: "allow this destructive action?", "save this recipe?".
 *
 * Three answers, like the side panel's page-action card: Decline (Escape, backdrop, the
 * focused default), Allow, and — when `scopeLabel` is given — a standing allow ("Allow for
 * this tool") that resolves 'always'. The body is pre-wrapped, because a recipe's dry run is
 * a list of steps and reads as one line otherwise. Enter never allows: the safe default is
 * the focused Decline, and a stray keystroke must not run a destructive action.
 *
 * @returns 'allow' | 'always' | 'deny'
 */
export function askPerson({ title = 'Allow this?', body = '', scopeLabel = null, allowLabel = 'Allow', danger = false } = {}) {
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
    ic.className = `cp-confirm-ic${danger ? '' : ' cp-ic-ask'}`;
    ic.innerHTML = danger ? TRASH_ICON : ASK_ICON;
    const t = document.createElement('div');
    t.className = 'cp-confirm-title';
    t.textContent = clamp(title, MAX_TITLE) || 'Allow this?';
    head.append(ic, t);
    card.append(head);
    const bodyText = clamp(body, MAX_BODY * 4);
    if (bodyText) {
      const b = document.createElement('div');
      b.className = 'cp-confirm-body';
      b.style.whiteSpace = 'pre-wrap';
      b.textContent = bodyText;
      card.append(b);
    }
    const why = document.createElement('div');
    why.className = 'cp-confirm-body';
    why.style.cssText = 'opacity:.6;font-size:11.5px;margin-top:-8px';
    why.textContent = 'Requested by the AI based on the conversation — review before allowing. Esc declines.';
    card.append(why);
    const row = document.createElement('div');
    row.className = 'cp-confirm-row';
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('deny'); } };
    const mk = (label, value, cls) => {
      const b = document.createElement('button');
      b.className = `cp-confirm-btn ${cls}`;
      b.textContent = label;
      b.onclick = () => done(value);
      return b;
    };
    const deny = mk('Decline', 'deny', 'cp-confirm-cancel');
    row.append(deny);
    if (scopeLabel) row.append(mk(scopeLabel, 'always', 'cp-confirm-cancel'));
    row.append(mk(allowLabel, 'allow', danger ? 'cp-confirm-danger' : 'cp-prompt-ok'));
    card.append(row);
    ov.append(card);
    // A stray click is not an answer: the card insists, as a browser permission prompt does.
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) deny.focus(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    deny.focus();
  });
}
