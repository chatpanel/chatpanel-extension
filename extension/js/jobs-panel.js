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
  listJobs, putJob, removeJob, setJobEnabled, lastRuns, whenNext, formatDuration, runHistory,
  recordRun, DEFAULT_MAX_PER_DAY,
} from './jobs.js';
import {
  timerTrigger, createTriggerRegistry, BUILTIN_TRIGGERS, meetingStartedTrigger, meetingEndedTrigger,
  personJoinedTrigger, phraseTrigger, topicTrigger, questionTrigger, TRIGGER_SOURCES,
} from './events/schedule.js';

const triggers = createTriggerRegistry(BUILTIN_TRIGGERS);
// The job being edited, or null when the form is creating. The form IS the editor: a second
// one would drift, and the reason jobs felt uneditable is that there was only ever the first.
let editing = null;
// Bound by wireForm, which owns the field references. Null until the drawer is built.
let loadIntoForm = null;
let stopEditing = () => { editing = null; };
let el = null;
let onToast = () => {};
let getSkills = () => [];
let openConv = null;

// The triggers worth offering in a form, in the order someone would think of them. The rest
// of the registry stays available to code — this list is about what fits in a narrow panel
// without turning into a configuration language.
const WHEN_OPTIONS = [
  { id: 'daily', label: 'Every day', kind: 'timer' },
  { id: 'weekdays', label: 'Every weekday', kind: 'timer' },
  { id: 'weekly', label: 'Every week on…', kind: 'timer' },
  { id: 'once', label: 'Once, at…', kind: 'timer' },
  { id: meetingStartedTrigger.id, label: 'When a meeting starts', kind: 'event' },
  // The one people ask for first — "when the call is over, do the write-up" — and the only
  // meeting trigger whose job has the WHOLE transcript to work from.
  { id: meetingEndedTrigger.id, label: 'When a meeting ends', kind: 'event' },
  { id: personJoinedTrigger.id, label: 'When someone joins', kind: 'event', field: 'names', placeholder: 'Alex Rivera, Jordan Blake (blank = anyone)' },
  { id: phraseTrigger.id, label: 'When a phrase is said', kind: 'event', field: 'any', placeholder: 'action item, follow up', required: true, speaker: true },
  { id: topicTrigger.id, label: 'When someone talks about…', kind: 'event', field: 'terms', placeholder: 'pricing, renewal', required: true, speaker: true },
  { id: questionTrigger.id, label: 'When a question is asked', kind: 'event', speaker: true },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// WHERE a text trigger watches. Only the text triggers get the choice — a meeting starting,
// or someone joining one, has nowhere else it could possibly happen.
const SOURCE_LABELS = { meeting: 'in meetings', note: 'in notes', chat: 'in chats' };
const TEXT_TRIGGERS = new Set([phraseTrigger.id, topicTrigger.id, questionTrigger.id]);

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
        <!-- WHOSE speech. These triggers default to other people — right for an interview,
             where the questions come from the interviewer, and baffling when you are testing
             alone and nothing happens. The default was neither visible nor changeable. -->
        <select id="job-speaker" class="mon-edit-every" hidden title="Whose speech to watch">
          <option value="others">others speak</option>
          <option value="anyone">anyone speaks</option>
          <option value="me">I speak</option>
        </select>
        <!-- Absent on a stored job means meetings only, which is what every job created
             before this control existed was pointed at. See sourceAllowed(). -->
        <select id="job-where" class="mon-edit-every" hidden multiple size="3"
                title="Where to watch — a phrase is worth acting on wherever it is written"></select>
        <select id="job-day" class="mon-edit-every" hidden></select>
        <input id="job-time" class="mon-edit-every" type="time" value="08:00" hidden />
      </div>
      <div class="job-row">
        <button id="job-add" class="mon-add-btn" type="button">Schedule it</button>
        <button id="job-cancel" class="mon-skill-btn" type="button" hidden>Cancel</button>
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
// The action kinds this form can express. A job whose action it cannot (a live monitor
// started by voice) is still editable — its action is offered back as "keep", so editing when
// it runs never silently rewrites what it does.
const FORM_ACTIONS = ['skill', 'prompt', 'notify'];

/** Which WHEN option a stored job corresponds to, or '' when the form cannot express it. */
export function whenValueFor(job) {
  if (!job) return '';
  if (job.trigger !== timerTrigger.id) return WHEN_OPTIONS.some((o) => o.id === job.trigger) ? job.trigger : '';
  const s = job.schedule || {};
  if (s.kind === 'once') return 'once';
  if (s.kind === 'weekly') return 'weekly';
  if (s.kind === 'daily') return s.weekdaysOnly ? 'weekdays' : 'daily';
  return ''; // an interval schedule — spoken into existence, not offered in the form
}

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;

function timeValueFor(job) {
  const s = job?.schedule || {};
  if (s.kind === 'once' && s.at) { const d = new Date(s.at); return hhmm(d.getHours(), d.getMinutes()); }
  if (Number.isInteger(s.hour)) return hhmm(s.hour, s.minute);
  return '08:00';
}

/** The words a job's action is stored as, back in the box the user typed them into. */
function actionTextFor(job) {
  const a = job?.action || {};
  if (a.kind === 'prompt') return a.text || '';
  if (a.kind === 'notify') return a.body || a.title || '';
  return '';
}

function wireForm() {
  const what = el.querySelector('#job-what');
  const when = el.querySelector('#job-when');
  const text = el.querySelector('#job-text');
  const param = el.querySelector('#job-param');
  const speaker = el.querySelector('#job-speaker');
  const where = el.querySelector('#job-where');
  const day = el.querySelector('#job-day');
  const time = el.querySelector('#job-time');
  const hint = el.querySelector('#job-hint');
  const add = el.querySelector('#job-add');
  const cancel = el.querySelector('#job-cancel');

  for (const [i, d] of DAYS.entries()) day.add(new Option(d, String(i)));
  day.value = '1';

  const paint = () => {
    // A skill is the point — the job says WHEN and the skill stays the definition of the
    // work — so skills come first and a free-text instruction is the fallback.
    const skills = getSkills();
    const keepWhat = what.value;
    what.innerHTML = '';
    for (const sk of skills) what.add(new Option(`Run “${sk.name}”`, `skill:${sk.id}`));
    what.add(new Option('Custom instruction…', 'prompt'));
    // The action a timer or a reminder has. Both are usually created by talking, and both
    // were uneditable here because the form could only make the other two.
    what.add(new Option('Just notify me…', 'notify'));
    if (editing && !FORM_ACTIONS.includes(editing.action?.kind)) {
      what.add(new Option(`Keep: ${describe(editing)}`.slice(0, 60), '__keep'));
    }
    if (keepWhat) what.value = keepWhat;
    if (!what.value) what.value = skills.length ? `skill:${skills[0].id}` : 'prompt';

    const keepWhen = when.value;
    when.innerHTML = '';
    for (const o of WHEN_OPTIONS) when.add(new Option(o.label, o.id));
    if (editing && !whenValueFor(editing)) when.add(new Option(`Keep: ${repeatLabel(editing) || 'as set'}`, '__keep'));
    if (!where.options.length) {
      for (const src of TRIGGER_SOURCES) where.add(new Option(SOURCE_LABELS[src] || src, src));
      where.options[0].selected = true; // meetings, matching the contract's default
    }
    if (keepWhen) when.value = keepWhen;
    if (!when.value) when.value = WHEN_OPTIONS[0].id;

    const opt = WHEN_OPTIONS.find((o) => o.id === when.value) || null;
    const freeText = what.value === 'prompt' || what.value === 'notify';
    text.hidden = !freeText;
    text.placeholder = what.value === 'notify' ? 'What to say when it fires' : 'What to do';
    param.hidden = !opt?.field;
    param.placeholder = opt?.placeholder || '';
    speaker.hidden = !opt?.speaker;
    where.hidden = !TEXT_TRIGGERS.has(opt?.id);
    day.hidden = opt?.id !== 'weekly';
    time.hidden = opt?.kind !== 'timer';
    add.textContent = editing ? 'Save changes' : 'Schedule it';
    cancel.hidden = !editing;
    hint.textContent = editing
      ? `Editing “${editing.name}”`
      : (skills.length ? '' : 'Tip: write a skill in Settings → Skills to run it on a schedule.');
  };
  what.onchange = paint;
  when.onchange = paint;

  // Load a stored job back into the form. Everything the form can express is filled in;
  // anything it cannot is offered back as "keep" rather than quietly replaced.
  loadIntoForm = (job) => {
    editing = job;
    const a = job.action || {};
    what.value = a.kind === 'skill' ? `skill:${a.skillId}` : FORM_ACTIONS.includes(a.kind) ? a.kind : '__keep';
    when.value = whenValueFor(job) || '__keep';
    text.value = actionTextFor(job);
    const p = job.params || {};
    param.value = (p.any || p.terms || p.names || []).join(', ');
    speaker.value = p.speaker || 'others';
    const want = new Set(Array.isArray(p.sources) && p.sources.length ? p.sources : ['meeting']);
    for (const o of where.options) o.selected = want.has(o.value);
    day.value = String(job.schedule?.weekday ?? 1);
    time.value = timeValueFor(job);
    paint();
    // A skill the job points at may have been deleted; the select then has no such option and
    // would silently fall back to the first skill. Say so instead of rewriting the job.
    if (a.kind === 'skill' && what.value !== `skill:${a.skillId}`) {
      onToast(`“${a.skillName || 'That skill'}” no longer exists — pick what this job should run`, 5000);
    }
    el.querySelector('.job-new')?.scrollIntoView({ block: 'nearest' });
    (text.hidden ? when : text).focus();
  };

  stopEditing = () => { editing = null; text.value = ''; param.value = ''; paint(); };
  cancel.onclick = () => { stopEditing(); renderJobs(); };

  paint();

  add.onclick = async () => {
    const was = editing;
    const keepAction = what.value === '__keep' && was;
    const keepWhen = when.value === '__keep' && was;
    const opt = keepWhen ? null : WHEN_OPTIONS.find((o) => o.id === when.value) || WHEN_OPTIONS[0];
    const skills = getSkills();
    const skill = what.value.startsWith('skill:') ? skills.find((sk) => `skill:${sk.id}` === what.value) : null;
    const instruction = text.value.trim();
    if (!keepAction && !skill && !instruction) { onToast('Say what the job should do'); return; }
    const values = param.value.split(',').map((v) => v.trim()).filter(Boolean);
    if (opt?.required && !values.length) { onToast(`Add at least one ${opt.field === 'terms' ? 'topic' : 'phrase'}`); return; }
    const [h, m] = (time.value || '08:00').split(':').map(Number);

    const action = keepAction ? was.action
      : skill ? { kind: 'skill', skillId: skill.id, skillName: skill.name }
        : what.value === 'notify' ? { kind: 'notify', title: was?.action?.title || was?.name || 'ChatPanel', body: instruction }
          : { kind: 'prompt', text: instruction };
    // The name follows the work when the work has a name of its own, and follows the words
    // when it was derived from them. A reminder named by voice ("Timer — tea") keeps its name
    // when its body is edited, instead of being renamed to its own message.
    const derived = !was || was.name === actionTextFor(was).slice(0, 60) || was.action?.kind === 'skill';
    const name = skill ? skill.name
      : keepAction ? was.name
        : derived ? instruction.slice(0, 60) || was?.name || 'Job'
          : was.name;

    const spec = {
      // Spread first so everything the form does not own — enabled, limits, onMissed, source,
      // approval — survives an edit instead of being reset to defaults.
      ...(was || {}),
      id: was ? was.id : `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      action,
      createdAt: was ? was.createdAt : Date.now(),
      ...(keepWhen ? {} : {
        trigger: opt.kind === 'timer' ? timerTrigger.id : opt.id,
        schedule: opt.kind !== 'timer' ? null : scheduleFor(opt.id, h, m, Number(day.value)),
        params: {
          ...(opt.field ? { [opt.field]: values } : {}),
          ...(opt.speaker ? { speaker: speaker.value || 'others' } : {}),
          // Only written for a trigger that can watch more than one place; elsewhere it
          // would be a stored field that means nothing.
          ...(TEXT_TRIGGERS.has(opt.id) ? { sources: selectedSources(where) } : {}),
        },
      }),
    };
    // Validated by the shared contract on the way in, so a job that cannot run cannot be
    // saved — and the reason is shown rather than swallowed.
    try {
      await putJob(spec);
    } catch (e) {
      onToast(`Couldn’t ${was ? 'save' : 'schedule'} that — ${e.message}`);
      return;
    }
    // Moving a job's time means "from now on", not "you missed today's". The watermark is
    // what dueJobs measures missed occurrences against, so leaving it behind would fire the
    // job the instant you finished editing it — which reads as a bug, not a schedule.
    if (was && JSON.stringify(was.schedule) !== JSON.stringify(spec.schedule)) {
      await recordRun(spec.id, Date.now());
    }
    stopEditing();
    onToast(`${was ? 'Saved' : 'Scheduled'} “${spec.name}”`);
    renderJobs();
  };
}

/** The surfaces ticked, never empty — an empty list would read as "everywhere". */
function selectedSources(where) {
  const on = [...where.options].filter((o) => o.selected).map((o) => o.value);
  return on.length ? on : ['meeting'];
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
    // Editing was the missing verb. Everything else about a job could be changed by deleting
    // it and typing it again — which is how a scheduler loses the job you meant to adjust.
    const edit = document.createElement('button');
    edit.className = 'mon-card-min';
    edit.innerHTML = icon('edit');
    edit.title = 'Edit this job';
    edit.onclick = () => loadIntoForm?.(job);
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
    head.append(name, when, edit, pause, del);
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'mon-card-b';
    body.textContent = describe(job);
    card.appendChild(body);
    const log = await runHistory(job.id);
    const why = statusLine(job, log);
    if (why) {
      const note = document.createElement('div');
      note.className = 'job-why';
      note.textContent = why;
      card.appendChild(note);
    }
    card.appendChild(historyOf(job, log));
    list.appendChild(card);
  }
}

/**
 * What this job has actually done.
 *
 * A job announces itself in a toast, and a toast is exactly what someone is not there for —
 * being away is the reason the job exists. Folded shut so the list stays a list, and every
 * run that produced an answer opens it.
 */
function historyOf(job, entries) {
  const runs = entries;
  const ran = runs.filter((r) => !r.skipped);
  const wrap = document.createElement('details');
  wrap.className = 'mon-earlier job-runs';
  const sum = document.createElement('summary');
  sum.textContent = runs.length
    ? `${ran.length} run${ran.length === 1 ? '' : 's'} · last activity ${timeAgo(runs[0].at)}`
    : 'No runs yet';
  wrap.appendChild(sum);
  if (!runs.length) return wrap;
  for (const run of runs) {
    const row = document.createElement('div');
    row.className = 'job-run';
    const when = document.createElement('span');
    when.className = 'mon-when';
    when.textContent = new Date(run.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const what = document.createElement('span');
    what.className = 'job-run-why';
    // The trigger reason first: "why did this run" is the question a surprising run raises,
    // and it is the one thing a chat transcript cannot answer.
    what.textContent = run.skipped
      ? `skipped${run.n > 1 ? ` ${run.n}×` : ''} — ${run.why}`
      : [run.why, run.note].filter(Boolean).join(' — ').slice(0, 180) || 'ran';
    // A skip is not a failure: it is the scheduler declining on purpose, and colouring it red
    // would make a working ceiling look like a broken job.
    if (run.skipped) what.classList.add('job-run-skip');
    else if (!run.ok) what.classList.add('job-run-bad');
    row.append(what, when);
    if (run.convId && openConv) {
      const open = document.createElement('button');
      open.className = 'mon-skill-btn';
      open.textContent = 'Open';
      open.onclick = () => { closeJobs(); openConv(run.convId); };
      row.appendChild(open);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * The one line worth reading when a job has not done what you expected.
 *
 * Three separate questions get asked as one — "is it off?", "did something stop it?", "does
 * it even need me here?" — so all three are answered in the same place, newest cause first.
 */
function statusLine(job, log) {
  if (!job.enabled) return 'Paused — it will not run until you resume it.';
  const head = log[0];
  if (head?.skipped) return `Last time: skipped ${timeAgo(head.at)} — ${head.why}${head.n > 1 ? ` (${head.n}×)` : ''}`;
  const t = triggers.get(job.trigger);
  // Standing facts, not failures — but each is a reason a job "did nothing" that no amount of
  // staring at the job itself explains.
  if (t && t.kind === 'meeting') return 'Fires during a live meeting, and only while the side panel is open.';
  if (job.action?.kind !== 'notify') return 'Needs a model, so it runs when the side panel is next open.';
  return '';
}

function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
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
export function wireJobsPane({ registerPane, toast = () => {}, skills = () => [], openConversation = null } = {}) {
  onToast = toast;
  getSkills = skills;
  openConv = openConversation;
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
