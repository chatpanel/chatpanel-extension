// WRITING to the user's notes — the half of the notes capability that did not exist.
//
// ChatPanel already exposes the user's notes for READING (history_search, history_get_source,
// behind the `find` dispatcher). Asked to save a finding as a note, an agent tried to drive
// the Notes page through browser automation, was correctly blocked from a chrome-extension://
// URL, and answered: "no direct note-write connector is available. I can provide the
// copy-paste-ready text if you'd like." It was right — there was no write tool — and the user
// had to be the clipboard.
//
// Three principles, all borrowed from the page tools rather than invented here:
//
//   ASK BEFORE WRITING. A write to the user's own data is exactly the class of action the page
//   tools already gate: the confirmation IS the grant, it names the concrete intent ("Create a
//   note titled X"), and a decline is final and told to the model plainly so it stops rather
//   than retrying.
//
//   NEVER LOSE WHAT WAS THERE. `update` snapshots the previous body into the note's own
//   version ledger before overwriting, so the destructive-looking action is recoverable from
//   the UI the user already has. There is deliberately no delete.
//
//   SAY WHO WROTE IT. Notes carry an attribution ledger for exactly this — a run of the body
//   written by an agent is recorded as the agent's, so provenance survives the turn.
//
// Platform bits are INJECTED (confirm, open, the store) so this module is testable and the
// side panel keeps ownership of its DOM.

export const NOTE_TOOL_SPECS = [
  {
    name: 'note',
    description:
      "WRITE to the user's ChatPanel notes: create a new note, append to one, or revise one. "
      + 'Use this when the user asks you to save, note down, write up or record something — do '
      + 'NOT try to drive the Notes page with browser tools, and do not hand back text for them '
      + 'to copy. To FIND or READ notes use `find`; this tool only writes. '
      + 'Every write asks the user to confirm, so say what you are saving in your reply.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'append', 'update'], description: 'create a new note, append to the end of one, or revise one.' },
        id: { type: 'string', description: 'The note to change. Required for append and update; get it from `find`.' },
        title: { type: 'string', description: 'Title. Used by create, and by update when renaming.' },
        body: { type: 'string', description: 'Markdown body. The whole note for create/update; use `text` to append.' },
        text: { type: 'string', description: 'Markdown to add to the end of an existing note (append).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['action'],
    },
  },
];

const err = (message, extra = {}) => JSON.stringify({ ok: false, error: message, ...extra });

/**
 * @param store    { createNote, getNote, saveNote } — the notes store.
 * @param confirm  async (detail) => 'allow' | 'deny'. The grant, asked per write.
 * @param onWrote  (id, action) => void — show the user the note, live.
 * @param agentLabel who to record in the attribution ledger.
 * @param needsConfirm whether to ask. Mirrors the page tools' confirm preference; a user who
 *        turned confirmation off for page actions has already answered this question.
 */
export function makeNoteToolExecutor({ store, confirm, onWrote = () => {}, agentLabel = 'AI', needsConfirm = true } = {}) {
  return async function execute(name, input = {}) {
    if (name !== 'note') return err(`Unknown tool "${name}".`);
    const action = String(input.action || '').trim();
    if (!['create', 'append', 'update'].includes(action)) {
      return err(`Unknown action "${action}".`, { actions: ['create', 'append', 'update'] });
    }

    const title = String(input.title || '').trim();
    const body = String(input.body ?? '');
    const text = String(input.text ?? '');

    // Validate BEFORE asking. A confirmation card for a call that cannot succeed spends the
    // user's attention to tell the model something it could have been told directly.
    let existing = null;
    if (action !== 'create') {
      const id = String(input.id || '').trim();
      if (!id) return err(`"${action}" needs the note's id. Use \`find\` to look it up.`);
      existing = await store.getNote(id);
      if (!existing) return err(`No note with id "${id}".`);
      if (action === 'append' && !text.trim()) return err('"append" needs `text`.');
      if (action === 'update' && !body.trim() && !title) return err('"update" needs a `body` or a `title`.');
    } else if (!body.trim() && !title) {
      return err('"create" needs a `title` or a `body`.');
    }

    const clip = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
    const detail = action === 'create'
      ? `Create a note “${clip(title || body)}”`
      : action === 'append'
        ? `Add ${text.length} characters to your note “${clip(existing.title || 'Untitled')}”`
        : `Rewrite your note “${clip(existing.title || 'Untitled')}” (the current version is kept)`;

    if (needsConfirm && (await confirm(detail)) === 'deny') {
      // The same wording the page tools use for a decline: final, and explicit that retrying
      // is not the move. A model told only "denied" tries again with slightly different args.
      return err('The user DECLINED this note write. Do not retry it — stop and ask the user how to proceed.');
    }

    try {
      if (action === 'create') {
        const rec = await store.createNote({
          title, body,
          attribution: [{ by: agentLabel, at: Date.now(), from: 0, to: body.length }],
        });
        onWrote(rec.id, action);
        return JSON.stringify({ ok: true, id: rec.id, title: rec.title, chars: (rec.body || '').length });
      }

      if (action === 'append') {
        const prev = String(existing.body || '');
        const joined = prev ? `${prev.replace(/\s+$/, '')}\n\n${text}` : text;
        const rec = await store.saveNote({
          ...existing,
          body: joined,
          attribution: [...(existing.attribution || []), { by: agentLabel, at: Date.now(), from: prev.length, to: joined.length }],
        });
        onWrote(existing.id, action);
        return JSON.stringify({ ok: true, id: existing.id, title: rec?.title, chars: joined.length, added: text.length });
      }

      // update — NEVER LOSE WHAT WAS THERE. The previous body goes into the note's own version
      // ledger first, which is the same list the Notes UI already offers to revert to.
      const prevBody = String(existing.body || '');
      const rec = await store.saveNote({
        ...existing,
        title: title || existing.title,
        body: body || prevBody,
        versions: [...(existing.versions || []), {
          body: prevBody,
          attribution: existing.attribution || [],
          at: Date.now(),
          by: agentLabel,
          label: `before ${agentLabel} revised it`,
        }],
        attribution: [{ by: agentLabel, at: Date.now(), from: 0, to: (body || prevBody).length }],
      });
      onWrote(existing.id, action);
      return JSON.stringify({ ok: true, id: existing.id, title: rec?.title, chars: (body || prevBody).length, previousVersionKept: true });
    } catch (e) {
      // The Free lifetime cap arrives here as a thrown NoteLimitError. Reported as a fact
      // about the account rather than a tool failure, so the model explains it instead of
      // retrying it.
      return err(String(e?.message || e));
    }
  };
}
