// GENERATED — do not edit.
// Source of truth: chatpanel-events/subject-kinds.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// The subject vocabulary, alone in a file so both halves of subject identity can name it
// without either importing the other.

/** What a subject can be. `title` is a record title someone linked to with [[…]]. */
export const SUBJECT_KINDS = Object.freeze(['person', 'topic', 'tag', 'title']);
