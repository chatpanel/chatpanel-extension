// Page actions — the *write* counterpart to context.js.
//
// context.js reads a tab (extract readable text). This module operates on it:
// inspect the page's form fields, fill them, and click elements. Everything runs
// through chrome.scripting.executeScript (the `scripting` + `<all_urls>` host
// permissions we already hold — no new permission is needed), and each injected
// function is fully self-contained, exactly as captureTab's extractReadable is.
//
// Typical flow for an agent:
//   const { fields } = await inspectForms(tabId);   // what's fillable + selectors
//   …model decides values…
//   await fillForm(tabId, [{ selector, value }, …]);
//   await clickElement(tabId, 'button[type=submit]');
//
// This feature is ungated (free). The 🖋 "Act on page" toggle is the user's
// explicit opt-in/consent; there's no Pro check here. (Page writes are local —
// chat traffic never touches the server.)

// Wrap the common "Chrome won't let us touch this page" failure the same way
// captureTab does, so the panel can surface one consistent message.
function injectError(e) {
  return new Error(
    `Couldn't act on that tab (${e.message}). Chrome blocks scripting some pages ` +
      `(chrome://, the Web Store, PDFs, other extensions).`,
  );
}

// --------------------------------------------------------------------------
// Inspect — enumerate fillable fields so the model knows what's on the page
// and gets a stable selector to target each one.
// --------------------------------------------------------------------------

// Injected. Returns a compact description of every visible form control, each
// with a `selector` that fillForm can use to find it again. Must be standalone.
function inspectFormsInPage() {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };

  // Build a selector that's stable AND unique on this page. Prefer #id, then a
  // [name=…] (scoped to its form if the page reuses names), else nth-of-type.
  const cssEscape = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\\]]/g, '\\$&');
  const selectorFor = (el) => {
    if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
      return `#${cssEscape(el.id)}`;
    }
    const tag = el.tagName.toLowerCase();
    if (el.name) {
      const byName = `${tag}[name="${cssEscape(el.name)}"]`;
      if (document.querySelectorAll(byName).length === 1) return byName;
      // Disambiguate among same-named controls (radio groups aside) by index.
      const same = [...document.querySelectorAll(byName)];
      const i = same.indexOf(el);
      if (i >= 0) return `${byName}:nth-of-type(${i + 1})`;
    }
    // Last resort: positional path from the nearest id'd ancestor or body.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const sibs = [...node.parentNode.children].filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ');
  };

  // Find a human label for a control: <label for>, wrapping <label>, aria-label,
  // aria-labelledby, placeholder, or the name — whatever's most descriptive.
  const labelFor = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const lbBy = el.getAttribute('aria-labelledby');
    if (lbBy) {
      const t = lbBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (l) return (l.textContent || '').trim();
    }
    const wrap = el.closest('label');
    if (wrap) return (wrap.textContent || '').replace(el.value || '', '').trim();
    return (el.placeholder || el.name || '').trim();
  };

  const out = [];
  const controls = document.querySelectorAll('input, textarea, select');
  for (const el of controls) {
    const type = (el.type || el.tagName).toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;
    if (el.disabled || el.readOnly || !isVisible(el)) continue;
    const field = {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      type,
      label: labelFor(el).slice(0, 120),
      name: el.name || '',
      required: !!el.required,
      value:
        type === 'checkbox' || type === 'radio'
          ? !!el.checked
          : String(el.value || '').slice(0, 200),
    };
    if (el.tagName === 'SELECT') {
      field.options = [...el.options].map((o) => ({ value: o.value, label: o.text }));
    }
    out.push(field);
  }

  // ARIA / custom widgets that aren't native controls — React form libraries,
  // Google Forms, design systems. A Google Forms radio is a <div role="radio"
  // aria-checked>, not an <input>; setting .value does nothing, it must be
  // CLICKED. We surface these so the model can target them, tagged with their
  // role and group (the question they belong to) so it can pick the right option.
  const WIDGET_ROLES = new Set([
    'radio', 'checkbox', 'switch', 'option', 'combobox', 'textbox',
    'menuitemradio', 'menuitemcheckbox', 'spinbutton',
  ]);
  for (const el of document.querySelectorAll('[role]')) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (!WIDGET_ROLES.has(role) || !isVisible(el)) continue;
    if (el.matches('input, textarea, select')) continue; // already captured natively
    const group = el.closest('[role="radiogroup"], [role="group"], [aria-labelledby]');
    out.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      type: role, // expose the ARIA role as the type so the model knows to click
      widget: true,
      label: labelFor(el).slice(0, 120),
      group: group ? labelFor(group).slice(0, 120) : '',
      value:
        el.getAttribute('aria-checked') === 'true' ||
        el.getAttribute('aria-selected') === 'true' ||
        (el.getAttribute('aria-checked') == null && el.getAttribute('aria-selected') == null
          ? (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 200)
          : false),
    });
  }
  // contentEditable text surfaces (rich editors, Google Docs-style fields).
  for (const el of document.querySelectorAll('[contenteditable=""], [contenteditable="true"]')) {
    if (!isVisible(el)) continue;
    out.push({
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      type: 'textbox',
      widget: true,
      label: labelFor(el).slice(0, 120),
      value: (el.innerText || '').slice(0, 200),
    });
  }

  // Buttons the agent might want to click (submit / named actions).
  const buttons = [];
  for (const el of document.querySelectorAll(
    'button, input[type=submit], input[type=button], [role=button]',
  )) {
    if (el.disabled || !isVisible(el)) continue;
    buttons.push({
      selector: selectorFor(el),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      type: (el.type || '').toLowerCase(),
    });
  }

  // Links — "operate on the page" includes clicking anchors (e.g. a HN comments
  // link), which aren't buttons. Capture visible, labelled, navigable anchors.
  const links = [];
  for (const el of document.querySelectorAll('a[href], [role=link]')) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
    if (!text) continue; // skip icon-only / empty anchors — nothing to match on
    const href = el.getAttribute('href') || '';
    if (href.startsWith('javascript:')) continue;
    links.push({
      selector: selectorFor(el),
      text: text.slice(0, 80),
      href: href.slice(0, 300),
    });
  }

  return { url: location.href, title: document.title, fields: out, buttons, links };
}

export async function inspectForms(tabId) {
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inspectFormsInPage,
    });
    return inj?.result || { fields: [], buttons: [] };
  } catch (e) {
    throw injectError(e);
  }
}

// --------------------------------------------------------------------------
// Fill — set values on the fields the model chose.
// --------------------------------------------------------------------------

// Injected. `fields` is [{ selector, value }]. Handles text/textarea, checkbox &
// radio (truthy → checked), and <select> (match by value then visible label).
// Crucially dispatches input+change events so React/Vue/Angular pick up the
// change — a bare `el.value =` is invisible to framework-controlled inputs.
function fillFormInPage(fields) {
  const results = [];
  const truthy = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1' || v === 'yes';
  const setNative = (el, value) => {
    // React tracks an internal value; go through the native setter so its
    // onChange fires, then bubble input+change for everyone else.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // A full pointer→click sequence — more robust than el.click() for jsaction
  // (Google Forms) and frameworks that listen on pointer/mouse events.
  const fireClick = (el) => {
    const o = { bubbles: true, cancelable: true, view: window };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(
          t.startsWith('pointer') && window.PointerEvent
            ? new PointerEvent(t, o)
            : new MouseEvent(t, o),
        );
      } catch {
        /* element may detach mid-sequence (React re-render) */
      }
    }
  };
  // Read current state back so we can report whether the change actually stuck.
  const readState = (el) => {
    if (el.getAttribute('aria-checked') != null) return el.getAttribute('aria-checked') === 'true';
    if (el.getAttribute('aria-selected') != null) return el.getAttribute('aria-selected') === 'true';
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return !!el.checked;
    if (el.isContentEditable) return (el.innerText || '').trim();
    return String(el.value ?? '').trim();
  };

  for (const { selector, value } of fields || []) {
    let el;
    try {
      el = document.querySelector(selector);
    } catch {
      el = null;
    }
    if (!el) {
      results.push({ selector, ok: false, error: 'not found' });
      continue;
    }
    try {
      el.scrollIntoView({ block: 'center' });
      const role = (el.getAttribute('role') || '').toLowerCase();
      const type = (el.type || el.tagName).toLowerCase();

      if (type === 'checkbox' || type === 'radio') {
        const want = truthy(value);
        if (el.checked !== want) {
          el.focus();
          el.checked = want;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (['radio', 'option', 'menuitemradio'].includes(role)) {
        // ARIA single-select option (e.g. a Google Forms answer): click to select.
        if (el.getAttribute('aria-checked') !== 'true' && el.getAttribute('aria-selected') !== 'true')
          fireClick(el);
      } else if (['checkbox', 'switch', 'menuitemcheckbox'].includes(role)) {
        const want = truthy(value);
        if ((el.getAttribute('aria-checked') === 'true') !== want) fireClick(el);
      } else if (el.tagName === 'SELECT') {
        const v = String(value);
        const opt =
          [...el.options].find((o) => o.value === v) ||
          [...el.options].find((o) => o.text.trim() === v.trim());
        if (!opt) {
          results.push({ selector, ok: false, error: 'no matching option' });
          continue;
        }
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable || role === 'textbox') {
        el.focus();
        el.textContent = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        setNative(el, String(value));
      }

      // Verify: re-read and compare to what was asked, so the agent learns when a
      // write silently didn't take (the #1 cause of "I filled it but it's empty").
      const now = readState(el);
      const want =
        type === 'checkbox' || type === 'radio' || ['checkbox', 'switch', 'menuitemcheckbox'].includes(role)
          ? truthy(value)
          : ['radio', 'option', 'menuitemradio'].includes(role)
            ? true // a selected option reads back as checked/selected
            : String(value).trim();
      const applied = ['radio', 'option', 'menuitemradio'].includes(role)
        ? el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
        : now === want;
      results.push({ selector, ok: true, applied, value: now });
    } catch (e) {
      results.push({ selector, ok: false, error: e.message });
    }
  }
  return results;
}

export async function fillForm(tabId, fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('Nothing to fill — pass [{ selector, value }, …].');
  }
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillFormInPage,
      args: [fields],
    });
    return inj?.result || [];
  } catch (e) {
    throw injectError(e);
  }
}

// --------------------------------------------------------------------------
// Click — operate a button / link (submit, next, etc.).
// --------------------------------------------------------------------------

function clickInPage(selector) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    el = null;
  }
  if (!el) return { ok: false, error: 'not found' };
  el.scrollIntoView({ block: 'center' });
  const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80);
  // Full pointer sequence first (jsaction / framework listeners), then the native
  // .click() as a fallback for plain anchors/buttons that only handle it.
  const o = { bubbles: true, cancelable: true, view: window };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    try {
      el.dispatchEvent(t.startsWith('pointer') && window.PointerEvent ? new PointerEvent(t, o) : new MouseEvent(t, o));
    } catch {
      /* element may detach mid-sequence */
    }
  }
  el.click();
  return { ok: true, text };
}

export async function clickElement(tabId, selector) {
  if (!selector) throw new Error('clickElement needs a selector.');
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickInPage,
      args: [selector],
    });
    const r = inj?.result;
    if (!r?.ok) throw new Error(r?.error || 'element not found');
    return r;
  } catch (e) {
    if (e.upsell) throw e;
    throw injectError(e);
  }
}

// --------------------------------------------------------------------------
// Click by text — find a button/link by its visible text or accessible name,
// for when the model doesn't have a precise selector (e.g. a "Search" button on
// a heavy SPA). Ranks exact > prefix > substring match, visible only.
// --------------------------------------------------------------------------

// Injected (fully self-contained): match a clickable by text, then click it via
// the robust pointer sequence. `role`: 'button' | 'link' | 'any'.
function clickByTextInPage(text, role) {
  const want = String(text || '').trim().toLowerCase();
  if (!want) return { ok: false, error: 'no text' };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  let sel =
    'button, a[href], input[type=submit], input[type=button], [role=button], [role=link], [role=menuitem], [role=tab], [role=option]';
  if (role === 'button') sel = 'button, input[type=submit], input[type=button], [role=button]';
  else if (role === 'link') sel = 'a[href], [role=link]';
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '').trim().toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!isVisible(el)) continue;
    const n = nameOf(el);
    if (!n) continue;
    const score = n === want ? 3 : n.startsWith(want) ? 2 : n.includes(want) ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return { ok: false, error: `no ${role === 'any' ? 'element' : role} matching "${text}"` };
  best.scrollIntoView({ block: 'center' });
  const matched = (best.innerText || best.value || best.getAttribute('aria-label') || '').trim().slice(0, 80);
  const o = { bubbles: true, cancelable: true, view: window };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    try {
      best.dispatchEvent(t.startsWith('pointer') && window.PointerEvent ? new PointerEvent(t, o) : new MouseEvent(t, o));
    } catch {
      /* element may detach mid-sequence */
    }
  }
  best.click();
  return { ok: true, matched };
}

export async function clickByText(tabId, text, role = 'any') {
  if (!text) throw new Error('clickByText needs text.');
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickByTextInPage,
      args: [text, role],
    });
    const r = inj?.result;
    if (!r?.ok) throw new Error(r?.error || 'no match');
    return r;
  } catch (e) {
    if (e.upsell) throw e;
    throw injectError(e);
  }
}
