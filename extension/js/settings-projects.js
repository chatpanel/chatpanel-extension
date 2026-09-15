// Settings → Agent Teams → Projects (F8 §17.2): the executive over rounds — the goal, its gate,
// budget and spend, and the jobs as cards with who was recruited and why. Read from the
// gateway's project records; the loop itself runs from the `team` tool's project action in any
// chat. Deferred, polling only while shown; the desktop's ProjectsTab over the same records.

import { projectProgress } from './events/project.js';
import { runStore } from './team-host.js';
import { agentAvatar } from './settings-agents.js';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const money = (v) => (Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : null);
const mins = (ms) => (Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 60000)} min` : null);
const TONE = { done: 'good', failed: 'risk', 'in-progress': 'on', recruited: 'on', evaluating: 'warn' };

/** Jobs grouped into rounds: a job's round is one past the deepest job it waits on. */
function rounds(jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const memo = new Map();
  const depth = (id, seen = new Set()) => { if (memo.has(id)) return memo.get(id); if (seen.has(id)) return 0; const j = byId.get(id); const deps = (j?.dependsOn || []).filter((d) => byId.has(d)); const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, new Set([...seen, id])))) : 0; memo.set(id, d); return d; };
  const groups = new Map();
  for (const j of jobs) { const d = depth(j.id); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(j); }
  return [...groups.keys()].sort((a, b) => a - b).map((d) => ({ round: d + 1, jobs: groups.get(d) }));
}

function jobCard(job, pool) {
  const who = job.recruited?.agentId || job.takenBy?.agentId || null;
  const card = who ? pool.find((a) => a.id === who) : null;
  const eng = job.recruited?.engine;
  const engineText = eng ? (typeof eng === 'string' ? eng : `${eng.harnessId || eng.model || eng.id || eng.kind}${eng.model && eng.harnessId ? `/${eng.model}` : ''}`) : '';
  const waiting = job.status === 'open' && job.proposal;
  const n = el('div', { class: `entity s-entity${job.status === 'done' ? ' is-off' : ''}${waiting ? ' is-proposed' : ''}`, 'data-job': job.id });
  n.append(el('div', { class: 'entity-head', style: 'margin-bottom:6px;padding-bottom:6px' },
    el('strong', { text: job.title || job.id }),
    el('span', { class: `org-chip ${TONE[job.status] || ''}`, text: job.status }),
    job.dependsOn?.length ? el('span', { class: 'muted tiny', text: `after ${job.dependsOn.join(', ')}` }) : null,
  ));
  if (job.brief) n.append(el('div', { class: 'muted tiny', style: 'white-space:pre-wrap', text: String(job.brief).slice(0, 240) }));
  if (who) {
    n.append(el('div', { class: 'org-row' }, agentAvatar(card || { id: who, name: who }, { small: true }), el('span', { text: card?.name || who }),
      engineText ? el('span', { class: 'org-chip k', text: engineText }) : null,
      Number.isFinite(job.recruited?.fit) ? el('span', { class: 'muted tiny', text: `fit ${Math.round(job.recruited.fit * 100)}%` }) : null,
      job.recruited?.why ? el('span', { class: 'muted tiny', text: `· ${job.recruited.why}` }) : null));
  } else {
    n.append(el('div', { class: 'org-row' },
      job.applications?.length ? el('span', { class: 'muted tiny', text: `${job.applications.length} applied · best fit ${Math.round(Math.max(...job.applications.map((a) => a.fit || 0)) * 100)}%` }) : el('span', { class: 'muted tiny', text: 'nobody recruited yet' }),
      waiting ? el('span', { class: 'org-chip warn', text: 'a proposed agent waits on you — answer on the Board' }) : null));
  }
  if (job.result) n.append(el('div', { class: 'muted tiny', style: 'white-space:pre-wrap', text: String(job.result).slice(0, 300) }));
  return n;
}

/** Returns a disposer: the list polls while the card is on screen. */
export function renderProjects(root, { settings }) {
  root._projectsDispose?.();
  root.innerHTML = '';
  const store = runStore(settings);
  const pool = (Array.isArray(settings.agentPool) ? settings.agentPool : []).filter((a) => a && a.id);
  const head = el('div', { class: 'card-head' }, el('h2', {}, 'Projects ', el('span', { class: 'sub', text: '' })));
  const note = el('p', { class: 'muted', text: 'A goal the Executive runs: it posts the jobs, recruits from the roster for each, runs a round as one team, reads what came back and asks you where the gate says. Ask in any chat for a goal to be run as a project.' });
  const list = el('div', { class: 'org-filters' });
  const pane = el('div');
  root.append(head, note, list, pane);
  let open = null;
  let alive = true;
  const drawRecord = (rec) => {
    pane.innerHTML = '';
    if (!rec) return;
    const p = projectProgress(rec);
    const cap = rec.page?.budget || {}; const spent = rec.spend || {};
    const gate = rec.page?.gate?.human || null;
    pane.append(el('div', { class: 'entity s-entity' },
      el('div', { class: 'entity-head', style: 'margin-bottom:6px;padding-bottom:6px' },
        agentAvatar(pool.find((a) => a.id === (rec.page?.executive || 'executive')) || { id: 'executive', name: 'Executive' }),
        el('strong', { text: rec.page?.title || rec.id }),
        el('span', { class: `org-chip ${rec.status === 'active' ? 'good' : 'warn'}`, text: `${rec.status}` }),
        el('span', { class: 'muted tiny', style: 'margin-left:auto', text: `budget ${[money(cap.usd), mins(cap.ms), cap.tokens ? `${cap.tokens} tokens` : null].filter(Boolean).join(' / ') || 'none'} · spent ${[money(spent.usd), mins(spent.ms)].filter(Boolean).join(' · ') || '—'} · ${p.done} done · ${p.open} open` })),
      rec.page?.goal ? el('div', { class: 'muted tiny', style: 'white-space:pre-wrap', text: rec.page.goal }) : null,
      rec.page?.doneWhen ? el('div', { class: 'muted tiny', text: `Done when: ${rec.page.doneWhen}` }) : null,
      el('div', { class: 'org-row' }, el('span', { class: 'tiny faint', text: 'GATE' }), ...(gate ? Object.entries(gate).map(([k, v]) => el('span', { class: 'org-chip k', text: `${k}: ${v ? 'ask' : 'auto'}` })) : [el('span', { class: 'org-chip k', text: "ChatPanel's default" })])),
      p.budgetUsed != null ? el('div', { class: 'bar', style: 'height:6px;border-radius:3px;background:var(--field);overflow:hidden;margin-top:6px' }, el('i', { style: `display:block;height:100%;width:${Math.round(p.budgetUsed * 100)}%;background:var(--accent)` })) : null,
    ));
    for (const r of rounds(rec.jobs || [])) {
      pane.append(el('div', { class: 'tiny faint', style: 'margin:10px 0 4px;letter-spacing:.05em;text-transform:uppercase', text: `Round ${r.round}${r.jobs.every((j) => j.status === 'done') ? ' · done' : r.jobs.some((j) => j.status === 'in-progress') ? ' · live' : ''}` }));
      for (const j of r.jobs) pane.append(jobCard(j, pool));
    }
    if (rec.report) pane.append(el('div', { class: 'entity s-entity' }, el('strong', { text: 'Report' }), el('div', { class: 'muted tiny', style: 'white-space:pre-wrap', text: rec.report.text })));
    if (rec.decisions?.length) pane.append(el('div', { class: 'entity s-entity' }, el('strong', { text: 'Decisions' }), ...rec.decisions.slice(-8).map((d) => el('div', { class: 'muted tiny', text: `${when(d.at)} · ${d.by} · ${d.kind}: ${d.text}` }))));
  };
  const openOne = async (id) => { open = id; const r = await store.project(id); if (alive && r.ok) drawRecord(r.data?.project || null); for (const b of list.querySelectorAll('[data-project]')) b.classList.toggle('on', b.getAttribute('data-project') === id); };
  const refresh = async () => {
    const res = await store.projects({ limit: 50 });
    if (!alive) return;
    const sub = head.querySelector('.sub');
    if (!res.ok) { sub.textContent = '— gateway not reachable'; note.textContent = `The gateway did not answer: ${res.error} (projects need gateway 0.6.90+).`; return; }
    const projects = res.data?.projects || [];
    sub.textContent = projects.length ? `${projects.length}` : 'none yet';
    list.innerHTML = '';
    for (const p of projects) list.append(el('button', { type: 'button', class: `org-chip${open === p.id ? ' on' : ''}`, 'data-project': p.id, text: `${p.page?.title || p.id} · ${p.status} · ${p.jobCount ?? 0} jobs`, onclick: () => openOne(p.id) }));
    if (!projects.length) { pane.innerHTML = ''; pane.append(el('p', { class: 'muted tiny', text: 'No projects yet.' })); return; }
    if (!open || !projects.some((p) => p.id === open)) await openOne(projects[0].id); else await openOne(open);
  };
  refresh();
  const timer = setInterval(refresh, 6000);
  const dispose = () => { alive = false; clearInterval(timer); };
  root._projectsDispose = dispose;
  return dispose;
}
