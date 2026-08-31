// The list of things ChatPanel will do without being asked.
//
// rules.js states the reason this exists: an automation you cannot see is one you cannot
// trust, and "it did nothing" has many causes worth telling apart. A job the user created by
// TALKING — "ChatPanel, remind me to take the kids to school at 9am on Wednesday" — is
// exactly the kind that must be visible afterwards, because there is no form they filled in
// to remember it by.
//
// The drawer is built here rather than in sidepanel.html: it reuses the drawer styles that
// already exist, and a pane that ships its own DOM can be added to the rail without editing
// a shared file.

import { icon } from './icons.js';
import {
  listJobs, putJob, removeJob, setJobEnabled, lastRuns, whenNext, formatDuration,
} from './jobs.js';
import {
  timerTrigger, createTriggerRegistry, BUILTIN_TRIGGERS, meetingStartedTrigger,
  personJoinedTrigger, phraseTrigger, topicTrigger, questionTrigger,
} from './events/schedule.js';

const triggers = createTriggerRegistry(BUILTIN_TRIGGERS);
let el = null;
let onToast = () => {};
let getSkills = () => [];

// The triggers worth offering in a form, in the order someone would think of them. The rest
// of the registry stays available to code — this list is about what fits in a narrow panel
// without turning into a configuration language.
const WHEN_OPTIONS = [
  { id: 'daily', label: 'Every day', kind: 'timer' },
  { id: 'weekdays', label: 'Every weekday', kind: 'timer' },
  { id: 'weekly', label: 'Every week on…', kind: 'timer' },
  { id: 'once', label: 'Once, at…', kind: 'timer' },
  { id: meetingStartedTrigger.id, label: 'When a meeting starts', kind: 'event' },
  { id: personJoinedTrigger.id, label: 'When someone joins', kind: 'event', field: 'names', placeholder: 'Alex Rivera, Jordan Blake (blank = anyone)' },
  { id: phraseTrigger.id, label: 'When a phrase is said', kind: 'event', field: 'any', placeholder: 'action item, follow up', required: true },
  { id: topicTrigger.id, label: 'When someone talks about…', kind: 'event', field: 'terms', placeholder: 'pricing, renewal', required: true },
  { id: questionTrigger.id, label: 'When a question is asked', kind: 'event' },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function build() {
  if (el) return el;
  el = document.createElement('aside');
  el.id = 'jobs-drawer';
  el.className = 'live-notes-drawer hidden';
  el.innerHTML = `
    <div class="live-notes-resize" title="Drag to resize"></div>
    <div class="live-notes-head">
      <span class="live-notes-title">${icon('timer')} Scheduled</span>
      <span class="topbar-spacer"></span>
      <button id="jobs-close" class="icon-btn" title="Close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="job-new">
      <div class="job-row">
        <select id="job-what" class="mon-edit-every"></select>
        <select id="job-when" class="mon-edit-every"></select>
      </div>
      <div class="job-row">
        <input id="job-text" class="mon-edit-input" placeholder="What to do" spellcheck="false" hidden />
        <input id="job-param" class="mon-edit-input" spellcheck="false" hidden />
        <select id="job-day" class="mon-edit-every" hidden></select>
        <input id="job-time" class="mon-edit-every" type="time" value="08:00" hidden />
      </div>
      <div class="job-row">
        <button id="job-add" class="mon-add-btn" type="button">Schedule it</button>
        <span id="job-hint" class="mon-edit-lab"></span>
      </div>
    </div>
    <div id="jobs-list" class="live-notes-body"></div>`;
  (document.getElementById('panel-body') || document.body).appendChild(el);
  el.querySelector('#jobs-close').onclick = () => closeJobs();
  wireForm();
  return el;
}

function whenLabel(job, runs) {
  if (job.trigger !== timerTrigger.id) {
    const t = triggers.get(job.trigger);
    return t ? t.label.toLowerCase() : 'when it triggers';
  }
  const at = whenNext(job, Date.now(), runs[job.id] || 0);
  if (!at) return 'done';
  const d = new Date(at);
  const left = at - Date.now();
  // A countdown for anything within the hour — for a ten-minute timer, "in 6 minutes" is the
  // only number anybody wants — and a wall-clock time beyond that.
  if (left > 0 && left < 3_600_000) return `in ${formatDuration(left)}`;
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function repeatLabel(job) {
  const s = job.schedule;
  if (!s || s.kind === 'once') return '';
  if (s.kind === 'interval') return `every ${formatDuration(s.everyMs)}`;
  if (s.kind === 'weekly') return 'weekly';
  return s.weekdaysOnly ? 'every weekday' : 'daily';
}

// The form. Deliberately two selects and at most two fields: a job is "do THIS when THAT",
// and anything needing more than that is better said to the model directly.
function wireForm() {
  const what = el.querySelector('#job-what');
  const when = el.querySelector('#job-when');
  const text = el.querySelector('#job-text');
  const param = el.querySelector('#job-param');
  const day = el.querySelector('#job-day');
  const time = el.querySelector('#job-time');
  const hint = el.querySelector('#job-hint');

  for (const [i, d] of DAYS.entries()) day.add(new Option(d, String(i)));
  day.value = '1';
  for (const o of WHEN_OPTIONS) when.add(new Option(o.label, o.id));

  const paint = () => {
    // A skill is the point — the job says WHEN and the skill stays the definition of the
    // work — so skills come first and a free-text instruction is the fallback.
    const skills = getSkills();
    const keep = what.value;
    what.innerHTML = '';
    for (const sk of skills) what.add(new Option(`Run “${sk.name}”`, `skill:${sk.id}`));
    what.add(new Option('Custom instruction…', 'prompt'));
    if (keep) what.value = keep;
    if (!what.value) what.value = skills.length ? `skill:${skills[0].id}` : 'prompt';
    const opt = WHEN_OPTIONS.find((o) => o.id === when.value) || WHEN_OPTIONS[0];
    text.hidden = what.value !== 'prompt';
    param.hidden = !opt.field;
    param.placeholder = opt.placeholder || '';
    day.hidden = opt.id !== 'weekly';
    time.hidden = opt.kind !== 'timer';
    hint.textContent = skills.length ? '' : 'Tip: write a skill in Settings → Skills to run it on a schedule.';
  };
  what.onchange = paint;
  when.onchange = paint;
  paint();

  el.querySelector('#job-add').onclick = async () => {
    const opt = WHEN_OPTIONS.find((o) => o.id === when.value) || WHEN_OPTIONS[0];
    const skills = getSkills();
    const skill = what.value.startsWith('skill:') ? skills.find((sk) => `skill:${sk.id}` === what.value) : null;
    const instruction = text.value.trim();
    if (!skill && !instruction) { onToast('Say what the job should do'); return; }
    const values = param.value.split(',').map((v) => v.trim()).filter(Boolean);
    if (opt.required && !values.length) { onToast(`Add at least one ${opt.field === 'terms' ? 'topic' : 'phrase'}`); return; }
    const [h, m] = (time.value || '08:00').split(':').map(Number);
    const spec = {
      id: `job_${Date.now().toString(36)}`,
      name: skill ? skill.name : instruction.slice(0, 60),
      trigger: opt.kind === 'timer' ? timerTrigger.id : opt.id,
      schedule: opt.kind !== 'timer' ? null : scheduleFor(opt.id, h, m, Number(day.value)),
      params: opt.field ? { [opt.field]: values } : {},
      action: skill ? { kind: 'skill', skillId: skill.id, skillName: skill.name } : { kind: 'prompt', text: instruction },
      createdAt: Date.now(),
    };
    // Validated by the shared contract on the way in, so a job that cannot run cannot be
    // saved — and the reason is shown rather than swallowed.
    try {
      await putJob(spec);
    } catch (e) {
      onToast(`Couldn’t schedule that — ${e.message}`);
      return;
    }
    text.value = ''; param.value = '';
    onToast(`Scheduled “${spec.name}”`);
    renderJobs();
  };
}

export function scheduleFor(id, hour, minute, weekday) {
  if (id === 'weekly') return { kind: 'weekly', weekday, hour, minute };
  if (id === 'once') {
    // The next time that clock time comes round — today if it is still ahead, else tomorrow.
    const at = new Date();
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    return { kind: 'once', at: at.getTime() };
  }
  return { kind: 'daily', hour, minute, weekdaysOnly: id === 'weekdays' };
}

export async function renderJobs() {
  build();
  const list = el.querySelector('#jobs-list');
  const [jobs, runs] = await Promise.all([listJobs(), lastRuns()]);
  list.innerHTML = '';
  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'mon-empty';
    empty.textContent = 'Nothing scheduled. Say “ChatPanel, set a timer for 10 minutes” during a meeting, or add a job from a skill.';
    list.appendChild(empty);
    return;
  }
  for (const job of jobs) {
    const card = document.createElement('div');
    card.className = 'mon-card' + (job.enabled ? '' : ' mon-closed');
    const head = document.createElement('div');
    head.className = 'mon-card-h';
    const name = document.createElement('span');
    name.className = 'mon-card-q';
    name.textContent = job.name;
    const when = document.createElement('span');
    when.className = 'mon-card-t';
    when.textContent = job.enabled ? [whenLabel(job, runs), repeatLabel(job)].filter(Boolean).join(' · ') : 'paused';
    // Pausing is not deleting: a weekly job you do not want THIS week is the common case,
    // and making the user re-create it is how a scheduler loses its jobs.
    const pause = document.createElement('button');
    pause.className = 'mon-card-min';
    pause.innerHTML = icon(job.enabled ? 'stop' : 'play');
    pause.title = job.enabled ? 'Pause' : 'Resume';
    pause.onclick = async () => { await setJobEnabled(job.id, !job.enabled); renderJobs(); };
    const del = document.createElement('button');
    del.className = 'mon-card-x';
    del.innerHTML = icon('close');
    del.title = 'Delete';
    del.onclick = async () => { await removeJob(job.id); onToast(`Removed “${job.name}”`); renderJobs(); };
    head.append(name, when, pause, del);
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'mon-card-b';
    body.textContent = describe(job);
    card.appendChild(body);
    list.appendChild(card);
  }
}

function describe(job) {
  const a = job.action || {};
  if (a.kind === 'notify') return a.body || 'Reminder';
  if (a.kind === 'skill') return `Runs the “${a.skillName || a.skillId}” skill`;
  if (a.kind === 'monitor') return `Starts a live monitor: ${a.prompt}`;
  return a.text || '';
}

export async function openJobs() {
  build().classList.remove('hidden');
  await renderJobs();
}
export function closeJobs() { el?.classList.add('hidden'); }
export function jobsOpen() { return !!el && !el.classList.contains('hidden'); }

/** Register the rail pane. The panel owns the rail; this owns everything behind the button. */
export function wireJobsPane({ registerPane, toast = () => {}, skills = () => [] } = {}) {
  onToast = toast;
  getSkills = skills;
  build();
  registerPane({
    id: 'jobs',
    icon: '⏱',
    label: 'Jobs',
    title: 'Scheduled jobs, timers & reminders',
    open: () => openJobs(),
    close: () => closeJobs(),
    isOpen: () => jobsOpen(),
  });
}
