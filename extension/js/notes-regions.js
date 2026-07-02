// notes-regions.js — collaborative multi-agent regions for the CM6 Notes editor.
//
// Each running agent OWNS a region of the document. This module tracks those regions so that:
//   • they REMAP correctly as anyone edits (other agents streaming, or you typing) — CM's
//     ChangeSet maps every region's [from,to] on every transaction, so concurrent writers
//     never clobber each other's positions;
//   • only an agent's OWN region is locked — a transaction filter drops user edits that touch
//     an active region, but edits ANYWHERE ELSE pass (the Google-Sheets behavior);
//   • each active region shows a live animated "working" widget.
//
// Pure-ish + framework-only: no Notes/DOM state beyond CM. The reducer (regionsField.update)
// and the guard (blocksChange) are plain functions over CM primitives, so they're unit-tested
// headlessly (tools/test-notes-regions.mjs).

import {
  EditorState, StateField, StateEffect, Annotation, EditorView, Decoration, WidgetType,
} from './vendor/codemirror.js';

// Marks a transaction as an AGENT write (carries the region id + author) so the guard lets it
// through and the editor attributes the text to the agent (not "You").
export const agentWrite = Annotation.define();

// Region lifecycle effects.
export const addRegion = StateEffect.define();          // { id, label, from, to }
export const setRegionRange = StateEffect.define();     // { id, from, to }
export const dropRegion = StateEffect.define();         // id (string)

// The live set of agent regions. Each is { id, label, from, to }. On every transaction the
// ranges are mapped through the change set (assoc: from grows left, to grows right, so text
// appended at the region's end stays inside it), THEN the lifecycle effects apply.
export const regionsField = StateField.define({
  create: () => [],
  update(regions, tr) {
    let next = regions;
    if (tr.docChanged) {
      next = regions
        .map((r) => ({ ...r, from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }))
        .filter((r) => r.to >= r.from);
    }
    for (const e of tr.effects) {
      if (e.is(addRegion)) next = [...next.filter((r) => r.id !== e.value.id), { ...e.value }];
      else if (e.is(setRegionRange)) next = next.map((r) => (r.id === e.value.id ? { ...r, from: e.value.from, to: e.value.to } : r));
      else if (e.is(dropRegion)) next = next.filter((r) => r.id !== e.value);
    }
    return next;
  },
});

export const activeRegions = (state) => state.field(regionsField, false) || [];

// PURE: should this transaction be blocked? A user edit (doc change, NOT an agent write) that
// overlaps any active region is dropped — you can't type into the span an agent is writing.
// Everything else (agent writes, edits elsewhere, selection-only changes) passes.
export function blocksChange(tr, regions) {
  if (!tr.docChanged || tr.annotation(agentWrite) || !regions.length) return false;
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const r of regions) { if (fromA < r.to && toA > r.from) hit = true; }
  });
  return hit;
}

// Drop user edits that touch an active agent region; everything else passes.
const regionGuard = EditorState.transactionFilter.of((tr) => (blocksChange(tr, activeRegions(tr.startState)) ? [] : tr));

// The animated "working" chip shown at a region's tail.
class WorkingWidget extends WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(other) { return other.label === this.label; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-agent-working';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<span class="cm-agent-spin"></span>${(this.label || 'Agent')} working…`;
    return el;
  }
  ignoreEvent() { return true; }
}

// Decorations derived from the regions: a subtle line background over each region + the
// animated widget at its end. Recomputed whenever the field changes.
function regionDecorations(state) {
  const regions = activeRegions(state);
  if (!regions.length) return Decoration.none;
  const deco = [];
  for (const r of regions) {
    const from = Math.max(0, Math.min(r.from, state.doc.length));
    const to = Math.max(from, Math.min(r.to, state.doc.length));
    // Line background across the region.
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      deco.push(Decoration.line({ class: 'cm-agent-region' }).range(line.from));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
    // Working chip at the tail.
    deco.push(Decoration.widget({ widget: new WorkingWidget(r.label), side: 1 }).range(to));
  }
  return Decoration.set(deco.sort((a, b) => a.from - b.from || (a.value.startSide || 0) - (b.value.startSide || 0)), true);
}

// The full extension: field + guard + decorations. Dormant (no-op) until a region is added.
export function agentRegionsExtension() {
  return [
    regionsField,
    regionGuard,
    EditorView.decorations.compute([regionsField], regionDecorations),
  ];
}

// ── Imperative API used by the job runner ────────────────────────────────────────
// Begin a region for agent `id` at [from,to] (usually an empty span where the answer goes).
export function beginRegion(view, id, label, from, to = from) {
  view.dispatch({ effects: addRegion.of({ id, label, from, to }) });
}
// Append `text` at the region's end (an agent write) and extend the region to cover it.
export function appendRegion(view, id, text) {
  const r = activeRegions(view.state).find((x) => x.id === id);
  if (!r || !text) return;
  view.dispatch({
    changes: { from: r.to, to: r.to, insert: text },
    effects: setRegionRange.of({ id, from: r.from, to: r.to + text.length }),
    annotations: agentWrite.of({ id, label: r.label }),
    scrollIntoView: true,
  });
}
// Replace the region's whole content (agent write) — for the initial placeholder or a reset.
export function setRegionText(view, id, text) {
  const r = activeRegions(view.state).find((x) => x.id === id);
  if (!r) return;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    effects: setRegionRange.of({ id, from: r.from, to: r.from + text.length }),
    annotations: agentWrite.of({ id, label: r.label }),
  });
}
// Finish agent `id`: unlock + drop the widget. Returns the region's final [from,to] (for
// attribution) or null.
export function finishRegion(view, id) {
  const r = activeRegions(view.state).find((x) => x.id === id);
  view.dispatch({ effects: dropRegion.of(id) });
  return r ? { from: r.from, to: r.to } : null;
}
// The author label of an agent write in this update, or null (used for provenance).
export function agentAuthorOf(update) {
  for (const tr of update.transactions || []) {
    const a = tr.annotation(agentWrite);
    if (a) return a.label || 'Agent';
  }
  return null;
}
