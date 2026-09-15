// GENERATED — do not edit.
// Source of truth: chatpanel-events/team-observe.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// Observe (F8 §17.2) — what is happening, where the time went, what needs you: derived from
// the run store's rows and records and the engine ledger's cards, once, here, so the desktop's
// Observe tab, the extension's and a phone's read the same inbox, the same lanes and the
// same spend rows. Nothing renders; the honesty rule holds — a number is given only where
// it is known (a relayed agent tool reports no tokens: its row says time, never $0).

import { runState, spendOf, LIVE_RUN_STATUSES } from './team-record.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The inbox: every run that needs a person — an ask waiting (`waiting` or a `waiting` count
 * on the row), a live run gone quiet (stalled) — newest first, each with the one action.
 * `runs` are the store's list rows (`GET /v1/teams/runs`) or folded records.
 */
export function observeInbox(runs = [], { now = Date.now() } = {}) {
  const items = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r?.id) continue;
    const st = runState(r, { now });
    const waiting = r.status === 'waiting' || num(r.waiting) > 0 || st.key === 'waiting';
    if (waiting) items.push({ kind: 'ask', runId: r.id, team: r.team || '', request: String(r.request || '').slice(0, 120), count: Math.max(1, num(r.waiting)), action: 'answer', at: num(r.lastEventAt) || num(r.createdAt), detail: st.detail || '' });
    else if (st.key === 'stalled') items.push({ kind: 'stalled', runId: r.id, team: r.team || '', request: String(r.request || '').slice(0, 120), action: 'resume', at: num(r.lastEventAt) || num(r.createdAt), detail: st.detail || '' });
  }
  return items.sort((a, b) => (a.kind === b.kind ? b.at - a.at : a.kind === 'ask' ? -1 : 1));
}

/** The strip's numbers: live runs, stalled, asks waiting, tasks done this window, rotations seen. */
export function observeStrip(runs = [], { now = Date.now(), sinceMs = 7 * 24 * 3600 * 1000 } = {}) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r?.id && num(r.createdAt) >= now - sinceMs);
  const live = list.filter((r) => LIVE_RUN_STATUSES.includes(r.status));
  const stalled = live.filter((r) => runState(r, { now }).key === 'stalled').length;
  const asks = observeInbox(list, { now }).filter((i) => i.kind === 'ask').reduce((n, i) => n + i.count, 0);
  const tasks = list.reduce((a, r) => { for (const t of r.tasks || []) { if (t.status === 'ok') a.done += 1; else if (t.status === 'failed' || t.status === 'unassigned') a.failed += 1; } return a; }, { done: 0, failed: 0 });
  const spend = list.reduce((a, r) => { const s = r.usage?.spent || {}; a.usd += num(s.usd); a.ms += num(s.ms); a.tokens += num(s.tokens); return a; }, { usd: 0, ms: 0, tokens: 0 });
  return { runs: list.length, live: live.length, stalled, asks, tasks, spend, completed: list.filter((r) => r.status === 'completed').length };
}

/**
 * One run's timeline: a lane per task with segments placed on the run's own clock (0..1 of
 * `span`), so a client draws bars without knowing the record. Segments: `working` (started →
 * ended or now), `waiting` (an ask), `declined` (an attempt that failed and rotated),
 * `earlier` (a task that ended before the last start of a live run, drawn grey). A sub-task
 * carries `parent` for nesting.
 */
export function runLanes(run, { now = Date.now() } = {}) {
  const has = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '';
  const start = has(run?.startedAt) ? Number(run.startedAt) : has(run?.createdAt) ? Number(run.createdAt) : now;
  const live = LIVE_RUN_STATUSES.includes(run?.status);
  const end = live ? now : Math.max(start + 1, num(run?.endedAt) || num(run?.lastEventAt) || now);
  const span = Math.max(1, end - start);
  const at = (t) => Math.max(0, Math.min(1, (t - start) / span));
  const lanes = [];
  for (const t of run?.tasks || []) {
    const segs = [];
    const s0 = has(t.startedAt) ? Number(t.startedAt) : null;
    const e0 = has(t.endedAt) ? Number(t.endedAt) : (t.status === 'running' || t.status === 'waiting' ? end : null);
    for (const a of t.attempts || []) {
      if (!has(a.startedAt) || !has(a.endedAt) || !(a.status === 'failed' || a.rotated)) continue;
      const as = Number(a.startedAt), ae = Number(a.endedAt);
      segs.push({ kind: 'declined', from: at(as), to: at(Math.max(ae, as + span / 200)), label: a.error || a.model || 'declined' });
    }
    if (s0 !== null && e0 !== null) segs.push({ kind: t.status === 'waiting' ? 'waiting' : 'working', from: at(s0), to: at(Math.max(e0, s0 + span / 200)), label: t.status });
    const ms = s0 !== null ? (e0 ?? end) - s0 : num(t.ms);
    lanes.push({ id: t.id, role: t.role || null, title: t.title || t.id, status: t.status, parent: t.parent || null, kind: t.kind || 'task', findings: num(t.findings), ms, segments: segs });
  }
  return { start, end, span, live, lanes };
}

/**
 * Spend by agent (the role's card id when the role names one, else the role), by team, or
 * by engine — from the run rows' `usage.spent` and each task's share where the record has
 * it. `usd` is `null`, not 0, when no run priced it; `ms` is always known.
 */
export function spendRows(runs = [], { by = 'team', now = Date.now() } = {}) {
  const rows = new Map();
  const add = (key, label, spent, { priced }) => {
    const r = rows.get(key) || { key, label, ms: 0, tokens: 0, usd: null, calls: 0, runs: 0 };
    r.ms += num(spent.ms); r.tokens += num(spent.tokens); r.calls += num(spent.calls); r.runs += 1;
    if (priced) r.usd = num(r.usd) + num(spent.usd);
    rows.set(key, r);
  };
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run?.id) continue;
    const s = spendOf(run, { now })?.spent || run.usage?.spent || {};
    const priced = num(s.usd) > 0 || num(s.tokens) > 0;
    if (by === 'team') add(run.team || '?', run.team || '?', s, { priced });
    else if (by === 'agent') {
      const tasks = (run.tasks || []).filter((t) => t.role);
      const share = tasks.length ? 1 / tasks.length : 0;
      for (const t of tasks) {
        const role = (run.roles || []).find((r) => r.id === t.role);
        const key = role?.agent || `${run.team || '?'}-${t.role}`;
        add(key, role?.agent || t.role, { ms: num(t.ms) || num(s.ms) * share, tokens: num(s.tokens) * share, usd: num(s.usd) * share, calls: num(s.calls) * share }, { priced });
      }
    } else if (by === 'engine') {
      for (const t of run.tasks || []) { const k = t.engine ? `${t.engine.kind}:${t.engine.id}${t.engine.model ? `/${t.engine.model}` : ''}` : (t.model || '?'); add(k, k, { ms: num(t.ms), tokens: 0, usd: 0, calls: 0 }, { priced: false }); }
    }
  }
  const out = [...rows.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.ms - a.ms);
  const max = Math.max(1, ...out.map((r) => (r.usd ?? 0) || 0), ...out.map((r) => r.ms / 60000));
  return out.map((r) => ({ ...r, share: r.usd != null && r.usd > 0 ? r.usd / max : (r.ms / 60000) / max }));
}

/** An engine card as one strip: 24 hour cells (`ok` · `declined` · `none`), the rate, and whether it is declining now. */
export function engineStrip(card) {
  const a = card?.availability || {};
  const hours = Array.isArray(a.byHour) ? a.byHour : Array.from({ length: 24 }, () => ({ calls: 0, declines: 0 }));
  return {
    key: card?.key || '?',
    label: card?.engine ? `${card.engine.id}${card.engine.model ? ` · ${card.engine.model}` : ''}` : (card?.key || '?'),
    rate: a.rate ?? null,
    decliningNow: !!a.decliningNow,
    p50: card?.latency?.total?.p50 ?? null,
    calls: num(card?.calls),
    cells: hours.map((h) => (num(h.declines) > 0 && num(h.declines) >= num(h.calls) ? 'declined' : num(h.calls) > 0 ? 'ok' : 'none')),
  };
}
