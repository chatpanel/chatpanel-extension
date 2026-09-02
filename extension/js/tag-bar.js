// Tag chips and the tag filter bar — one control, four surfaces.
//
// Notes, chats, meetings and the side panel all need the same two things: chips you can
// add to and remove from, and a row of tags you can click to narrow a list. Written per
// page, those become four slightly different widgets — four keyboard behaviours, four
// looks, four bugs. This is the one implementation; the pages supply data and handlers.
//
// Storage-free and page-free on purpose: it takes `tags` and calls `onChange`. What that
// means (a note save, a meeting meta write, a conversation update) is the caller's, so
// the same component works against three different stores.
//
// The stylesheet is injected once by the module rather than copied into notes.css,
// meetings.css and sidepanel.css — three copies would drift, and the point of one
// component is that a tag looks like a tag everywhere. Colours come from each page's own
// variables, with a fallback chain because the side panel names them differently
// (--text-dim / --accent-soft) than the dashboards (--muted / --accent-weak).

import { normalizeTag, normalizeTags, addTag, removeTag, MAX_TAGS } from './events/tags.js';

const CSS = `
.cp-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cp-tags:empty { display: none; }
.cp-tag {
  display: inline-flex; align-items: center; gap: 4px; max-width: 220px;
  font-size: 11.5px; line-height: 1.6; font-weight: 550; border-radius: 999px;
  padding: 2px 4px 2px 9px; border: 1px solid transparent;
  color: var(--accent, #5b5bf0);
  background: var(--accent-weak, var(--accent-soft, rgba(91, 91, 240, .10)));
}
.cp-tag.plain { padding-right: 9px; }
.cp-tag-name {
  appearance: none; border: 0; background: none; padding: 0; margin: 0; cursor: pointer;
  font: inherit; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cp-tag-name[disabled] { cursor: default; }
.cp-tag-x {
  appearance: none; border: 0; background: none; color: inherit; cursor: pointer;
  opacity: .55; font-size: 13px; line-height: 1; padding: 1px 4px; border-radius: 999px;
}
.cp-tag-x:hover { opacity: 1; background: rgba(127, 127, 127, .18); }
.cp-tag-add {
  appearance: none; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 550;
  border: 1px dashed var(--border-strong, var(--border, #d3d8e0));
  background: transparent; color: var(--muted, var(--text-dim, #646b76));
  border-radius: 999px; padding: 2px 10px;
}
.cp-tag-add:hover { border-color: var(--accent, #5b5bf0); color: var(--accent, #5b5bf0); }
.cp-tag-entry { position: relative; display: inline-flex; }
.cp-tag-input {
  font: inherit; font-size: 11.5px; width: 132px; border-radius: 999px; padding: 2px 10px;
  border: 1px solid var(--accent, #5b5bf0);
  background: var(--card, var(--bg-elev, #fff)); color: var(--text, #181b20);
}
.cp-tag-input:focus { outline: none; }
.cp-tag-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 148px;
  max-height: 190px; overflow-y: auto; padding: 4px; border-radius: 10px;
  border: 1px solid var(--border, #e4e7ec); background: var(--card, var(--bg-elev, #fff));
  box-shadow: 0 8px 24px rgba(0, 0, 0, .16);
}
.cp-tag-menu[hidden] { display: none; }
.cp-tag-opt {
  display: flex; justify-content: space-between; gap: 10px; width: 100%;
  appearance: none; border: 0; background: none; cursor: pointer; font: inherit;
  font-size: 12px; color: var(--text, #181b20); padding: 5px 8px; border-radius: 7px;
  text-align: left;
}
.cp-tag-opt:hover, .cp-tag-opt.on { background: var(--accent-weak, var(--accent-soft, rgba(91, 91, 240, .10))); }
.cp-tag-opt .n { color: var(--muted, var(--text-dim, #646b76)); font-variant-numeric: tabular-nums; }
.cp-tag-hint { color: var(--faint, var(--text-dim, #8a909b)); font-size: 11px; }

.cp-tagfilter { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 10px; }
.cp-tagfilter[hidden] { display: none; }
.cp-tagfilter-label {
  font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  color: var(--faint, var(--text-dim, #8a909b)); margin-right: 2px;
}
.cp-facet {
  appearance: none; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 550;
  border-radius: 999px; padding: 3px 10px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border, #e4e7ec);
  background: var(--field, var(--bg-soft, #f7f8fa)); color: var(--muted, var(--text-dim, #646b76));
}
.cp-facet:hover { border-color: var(--accent, #5b5bf0); color: var(--text, #181b20); }
.cp-facet[aria-pressed="true"] {
  border-color: transparent; color: #fff; background: var(--accent, #5b5bf0);
}
.cp-facet .n { font-variant-numeric: tabular-nums; opacity: .7; font-weight: 500; }
.cp-facet-more, .cp-facet-clear { border-style: dashed; background: transparent; }
`;

let cssDone = false;
function injectCss(doc = document) {
  if (cssDone || !doc?.head || doc.getElementById('cp-tag-css')) { cssDone = true; return; }
  const style = doc.createElement('style');
  style.id = 'cp-tag-css';
  style.textContent = CSS;
  doc.head.appendChild(style);
  cssDone = true;
}

// --------------------------------------------------------------------------
// Chips (read-only or editable)
// --------------------------------------------------------------------------

/**
 * Render a record's tags into `host`.
 *
 * opts:
 *   tags         current tags (normalized on the way in)
 *   editable     show the × on each chip and a "+ tag" affordance (default true)
 *   suggestions  tags already used elsewhere, offered while typing — reusing the
 *                user's own vocabulary is what keeps a tag list from fragmenting
 *   onChange(next)  called with the new list on every add/remove
 *   onSelect(tag)   clicking a chip's name (e.g. "filter the list by this tag")
 *   addLabel     text on the add button
 *
 * Returns { update(tags), focusAdd(), destroy() } so a caller can refresh in place.
 */
export function mountTagEditor(host, opts = {}) {
  if (!host) return { update() {}, focusAdd() {}, destroy() {} };
  injectCss(host.ownerDocument || document);
  const state = {
    tags: normalizeTags(opts.tags),
    editable: opts.editable !== false,
    suggestions: [],
    onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
    onSelect: typeof opts.onSelect === 'function' ? opts.onSelect : null,
    addLabel: opts.addLabel || '+ tag',
    emptyHint: opts.emptyHint || '',
  };
  setSuggestions(opts.suggestions);
  host.classList.add('cp-tags');

  function setSuggestions(list) {
    state.suggestions = (Array.isArray(list) ? list : [])
      .map((s) => (typeof s === 'string' ? { tag: normalizeTag(s), count: 0 } : { tag: normalizeTag(s?.tag), count: s?.count || 0 }))
      .filter((s) => s.tag);
  }

  function commit(next) {
    state.tags = next;
    render();
    state.onChange?.(next);
  }

  function render() {
    host.textContent = '';
    for (const tag of state.tags) {
      const chip = document.createElement('span');
      chip.className = 'cp-tag' + (state.editable ? '' : ' plain');
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'cp-tag-name';
      name.textContent = `#${tag}`;
      if (state.onSelect) {
        name.title = `Show everything tagged #${tag}`;
        name.onclick = () => state.onSelect(tag);
      } else {
        name.disabled = true;
      }
      chip.appendChild(name);
      if (state.editable) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'cp-tag-x';
        x.textContent = '×';
        x.title = `Remove #${tag}`;
        x.setAttribute('aria-label', `Remove tag ${tag}`);
        x.onclick = () => commit(removeTag(state.tags, tag));
        chip.appendChild(x);
      }
      host.appendChild(chip);
    }
    if (!state.editable) {
      if (!state.tags.length && state.emptyHint) {
        const hint = document.createElement('span');
        hint.className = 'cp-tag-hint';
        hint.textContent = state.emptyHint;
        host.appendChild(hint);
      }
      return;
    }
    if (state.tags.length >= MAX_TAGS) {
      const hint = document.createElement('span');
      hint.className = 'cp-tag-hint';
      hint.textContent = `${MAX_TAGS} tags max`;
      host.appendChild(hint);
      return;
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'cp-tag-add';
    add.textContent = state.addLabel;
    add.title = 'Add a tag';
    add.onclick = () => openEntry(add);
    host.appendChild(add);
  }

  // The add field: type, pick from what you've used before, Enter to commit. Escape
  // cancels, Backspace on an empty field deletes the last chip (the behaviour every
  // token input has, and the one people try first).
  function openEntry(addBtn) {
    const wrap = document.createElement('span');
    wrap.className = 'cp-tag-entry';
    const input = document.createElement('input');
    input.className = 'cp-tag-input';
    input.placeholder = 'tag, then ↵';
    input.setAttribute('aria-label', 'Add a tag');
    const menu = document.createElement('div');
    menu.className = 'cp-tag-menu';
    menu.hidden = true;
    wrap.append(input, menu);
    addBtn.replaceWith(wrap);
    input.focus();

    let options = [];
    let cursor = -1;
    let closed = false;

    const paintMenu = () => {
      const typed = normalizeTag(input.value);
      const own = new Set(state.tags);
      options = state.suggestions
        .filter((s) => !own.has(s.tag) && (!typed || s.tag.includes(typed)))
        .slice(0, 8);
      menu.textContent = '';
      if (!options.length) { menu.hidden = true; return; }
      options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cp-tag-opt' + (i === cursor ? ' on' : '');
        b.innerHTML = '';
        const label = document.createElement('span');
        label.textContent = `#${opt.tag}`;
        b.appendChild(label);
        if (opt.count) {
          const n = document.createElement('span');
          n.className = 'n';
          n.textContent = String(opt.count);
          b.appendChild(n);
        }
        // mousedown, not click: blur fires first on click and would close the menu.
        b.onmousedown = (e) => { e.preventDefault(); pick(opt.tag); };
        menu.appendChild(b);
      });
      menu.hidden = false;
    };

    const close = (next) => {
      if (closed) return;
      closed = true;
      if (next !== undefined) commit(next);
      else render();
    };
    const pick = (value) => close(addTag(state.tags, value));
    const commitTyped = () => {
      const value = normalizeTag(input.value);
      close(value ? addTag(state.tags, value) : undefined);
    };

    input.oninput = () => { cursor = -1; paintMenu(); };
    input.onkeydown = (e) => {
      e.stopPropagation(); // a page-level shortcut must not fire while typing a tag
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (cursor >= 0 && options[cursor]) pick(options[cursor].tag);
        else commitTyped();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!options.length) return;
        e.preventDefault();
        cursor = e.key === 'ArrowDown'
          ? (cursor + 1) % options.length
          : (cursor <= 0 ? options.length - 1 : cursor - 1);
        paintMenu();
      } else if (e.key === 'Backspace' && !input.value && state.tags.length) {
        e.preventDefault();
        close(state.tags.slice(0, -1));
      }
    };
    input.onblur = () => commitTyped();
    paintMenu();
  }

  render();
  return {
    update(tags, suggestions) {
      state.tags = normalizeTags(tags);
      if (suggestions !== undefined) setSuggestions(suggestions);
      render();
    },
    focusAdd() { host.querySelector('.cp-tag-add')?.click(); },
    destroy() { host.textContent = ''; host.classList.remove('cp-tags'); },
  };
}

// --------------------------------------------------------------------------
// Filter bar
// --------------------------------------------------------------------------

const DEFAULT_VISIBLE = 12;

/**
 * A row of clickable tag pills with counts.
 *
 * Deliberately dumb about state: it renders `selected` and calls `onToggle(tag)`. Each
 * page keeps the selection in ONE place — its search query (`tag:x` round-trips through
 * events/tags.js) — so the box always shows what the list is filtered by, and there is
 * no second hidden filter to get out of sync with it.
 *
 * Returns { update({ facets, selected }), destroy() }.
 */
export function mountTagFilter(host, opts = {}) {
  if (!host) return { update() {}, destroy() {} };
  injectCss(host.ownerDocument || document);
  const state = {
    facets: opts.facets || [],
    selected: normalizeTags(opts.selected),
    onToggle: typeof opts.onToggle === 'function' ? opts.onToggle : null,
    onClear: typeof opts.onClear === 'function' ? opts.onClear : null,
    label: opts.label || '',
    visible: opts.visible || DEFAULT_VISIBLE,
    expanded: false,
  };
  host.classList.add('cp-tagfilter');

  function render() {
    host.textContent = '';
    // Nothing tagged yet → no bar at all. An empty filter row is pure noise on a fresh
    // install, and this is above the list on every page.
    host.hidden = !state.facets.length;
    if (host.hidden) return;
    if (state.label) {
      const l = document.createElement('span');
      l.className = 'cp-tagfilter-label';
      l.textContent = state.label;
      host.appendChild(l);
    }
    const sel = new Set(state.selected);
    const shown = state.expanded ? state.facets : state.facets.slice(0, state.visible);
    // A selected tag pushed past the cut would vanish while still filtering the list.
    for (const f of state.facets) if (sel.has(f.tag) && !shown.includes(f)) shown.push(f);
    for (const f of shown) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-facet';
      b.setAttribute('aria-pressed', sel.has(f.tag) ? 'true' : 'false');
      b.title = sel.has(f.tag) ? `Stop filtering by #${f.tag}` : `Filter by #${f.tag}`;
      const name = document.createElement('span');
      name.textContent = `#${f.tag}`;
      b.appendChild(name);
      if (f.count) {
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = String(f.count);
        b.appendChild(n);
      }
      b.onclick = () => state.onToggle?.(f.tag);
      host.appendChild(b);
    }
    const hidden = state.facets.length - shown.length;
    if (hidden > 0 || state.expanded) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'cp-facet cp-facet-more';
      more.textContent = state.expanded ? 'Show fewer' : `+${hidden} more`;
      more.onclick = () => { state.expanded = !state.expanded; render(); };
      host.appendChild(more);
    }
    if (state.selected.length) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'cp-facet cp-facet-clear';
      clear.textContent = 'Clear';
      clear.title = 'Clear the tag filter';
      clear.onclick = () => (state.onClear ? state.onClear() : state.selected.forEach((t) => state.onToggle?.(t)));
      host.appendChild(clear);
    }
  }

  render();
  return {
    update({ facets, selected } = {}) {
      if (facets !== undefined) state.facets = facets || [];
      if (selected !== undefined) state.selected = normalizeTags(selected);
      render();
    },
    destroy() { host.textContent = ''; host.classList.remove('cp-tagfilter'); },
  };
}
