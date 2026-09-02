// Naming and filing a meeting, from wherever its title is on screen.
//
// The side panel shows a meeting's title in three places — the drawer list row, the
// meeting view header, and the live scribe strip — and every one of them is somewhere a
// bad title gets noticed. Making someone open the call to fix its name is the reason
// nobody ever fixes it, so the rename is a shared action rather than one screen's button.
//
// Its own module for two reasons: everything it pulls in (the inline editor, the chip
// control, the tag vocabulary) is action-only, so none of it belongs on the panel's first
// paint; and the panel is already a very large file, which is exactly how a fourth copy
// of "rename a thing" gets written.

import { setMeetingTitle, setMeetingTags, getMeetingIndex } from './store-meetings.js';
import { editTitleInline } from './editable-title.js';
import { mountTagEditor } from './tag-bar.js';
import { tagFacets } from './events/tags.js';

/**
 * Turn a title element into a field, and persist what is typed.
 *
 * onRenamed(next) fires only on a real change; onDone() always fires (commit OR cancel)
 * so the caller can repaint whatever was showing the old title.
 */
export function renameMeetingInline(el, { id, title = '', onRenamed, onDone } = {}) {
  if (!el || !id) return null;
  return editTitleInline(el, {
    value: title,
    placeholder: 'Name this meeting…',
    onCommit: async (next) => {
      const saved = await setMeetingTitle(id, next);
      if (saved) onRenamed?.(saved);
    },
    onDone,
  });
}

/**
 * Mount the tag chips for one meeting. Suggestions come from every tag already in use, so
 * the vocabulary converges instead of fragmenting into synonyms.
 */
export async function mountMeetingTags(host, { id, tags = [], onChange } = {}) {
  if (!host || !id) return null;
  let index = [];
  try { index = await getMeetingIndex(); } catch { /* suggestions are a nicety */ }
  return mountTagEditor(host, {
    tags,
    suggestions: tagFacets(index, (e) => e.tags, { limit: 40 }),
    onChange: async (next) => { onChange?.(await setMeetingTags(id, next)); },
  });
}
