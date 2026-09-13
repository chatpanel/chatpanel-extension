// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-trail.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// A team run as a trail reads it: one line per event in the trail's own vocabulary, and
// the run's lanes — one per task — folded from the same events. Both clients draw a run
// from these; neither decides for itself what "task.done" means in words. The event
// vocabulary is team-run.js's `emit`; the lanes are what a pane, a card or a phone renders.

/** One trail line per team event, in the trail's own vocabulary. */
export function teamLine(ev) {
  const role = ev.role ? `${ev.role}` : 'team';
  switch (ev.type) {
    case 'run.started': return { type: 'status', text: `team ${ev.team}: ${(ev.roles || []).join(', ')}` };
    case 'plan.ready': return { type: 'status', text: `plan: ${(ev.tasks || []).length} task${(ev.tasks || []).length === 1 ? '' : 's'} (${ev.by})` };
    case 'task.started': return { type: 'tool', name: role, text: `${role} · ${ev.title || ev.taskId}` };
    case 'task.tool': return { type: 'tool', name: ev.name, text: `${role} ran ${ev.name}${ev.text ? ` — ${ev.text}` : ''}` };
    case 'task.finding': return { type: 'status', text: `${role}: ${String(ev.finding?.text || '').slice(0, 140)}` };
    case 'task.done': return { type: 'status', text: `${role} done · ${ev.findings || 0} finding${ev.findings === 1 ? '' : 's'}` };
    case 'task.failed': return { type: 'error', text: `${role} ${ev.status || 'failed'}${ev.error ? ` — ${ev.error}` : ''}` };
    case 'run.merging': return { type: 'status', text: `merging (${ev.policy})` };
    case 'run.done': return { type: 'status', text: `team ${ev.status}${ev.usage?.spent?.tokens ? ` · ${ev.usage.spent.tokens} tokens` : ''}` };
    default: return null;
  }
}

/** The run's lanes — one per task — folded from its events, for the pane. */
export function teamLanes(prev, ev) {
  const lanes = prev ? { ...prev, tasks: { ...prev.tasks } } : { runId: ev.runId, team: '', status: 'running', tasks: {}, findings: 0 };
  switch (ev.type) {
    case 'run.started': lanes.team = ev.team; lanes.roles = ev.roles; break;
    case 'plan.ready': for (const t of ev.tasks || []) lanes.tasks[t.id] = { id: t.id, role: t.role, title: t.title, status: 'pending', findings: 0 }; break;
    case 'task.started': lanes.tasks[ev.taskId] = { ...(lanes.tasks[ev.taskId] || { id: ev.taskId, role: ev.role, title: ev.title }), status: 'running' }; break;
    case 'task.delta': if (lanes.tasks[ev.taskId]) lanes.tasks[ev.taskId] = { ...lanes.tasks[ev.taskId], text: ev.text }; break;
    case 'task.finding': lanes.findings += 1; if (lanes.tasks[ev.taskId]) lanes.tasks[ev.taskId] = { ...lanes.tasks[ev.taskId], findings: (lanes.tasks[ev.taskId].findings || 0) + 1 }; break;
    case 'task.done': case 'task.failed': if (lanes.tasks[ev.taskId]) lanes.tasks[ev.taskId] = { ...lanes.tasks[ev.taskId], status: ev.status || 'ok', ms: ev.ms }; break;
    case 'run.done': lanes.status = ev.status; lanes.usage = ev.usage; break;
    default: break;
  }
  return lanes;
}
