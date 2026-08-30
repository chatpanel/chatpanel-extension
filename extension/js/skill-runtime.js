import { sourceCitationSystem } from './tool-hints.js';

function normalizeHistoryContext(value) {
  const v = String(value || 'none').toLowerCase();
  if (v === 'chat' || v === 'chats') return 'chats';
  if (v === 'meeting' || v === 'meetings') return 'meetings';
  if (v === 'all' || v === 'both' || v === 'history') return 'all';
  return 'none';
}

function normalizeMcpMode(value) {
  const v = String(value || 'none').toLowerCase();
  if (v === 'none' || v === 'off') return 'none';
  if (v === 'selected' || v === 'select') return 'selected';
  return 'default';
}

function enabledServers(servers) {
  return (servers || []).filter((s) => s && s.enabled !== false && (s.url || s.command || s.tools?.length));
}

// A skill can be switched OFF in settings instead of deleted — it then disappears
// from the skills menu, /commands, #mentions and meeting monitors, but keeps its
// prompt. Skills saved before this flag existed have no `enabled`, so absence
// means enabled; every surface must go through these two so "off" means off
// everywhere rather than in whichever list remembered to check.
export function isSkillEnabled(skill) {
  return !!skill && skill.enabled !== false;
}

export function enabledSkills(skills) {
  return (Array.isArray(skills) ? skills : []).filter(isSkillEnabled);
}

export function skillRunFromSkill(skill = {}, { includeMeetings = false } = {}) {
  const requested = normalizeHistoryContext(skill.historyContext);
  let history = null;
  if (requested !== 'none') {
    const wantsMeetings = requested === 'meetings' || requested === 'all';
    const blocked = wantsMeetings && !includeMeetings ? 'meetings' : '';
    history = {
      enabled: !blocked,
      scope: requested,
      includeMeetings: wantsMeetings && !!includeMeetings,
      requested,
      ...(blocked ? { blocked } : {}),
    };
  }

  return {
    skillId: skill.id || '',
    history,
    mcp: {
      mode: normalizeMcpMode(skill.mcpMode),
      serverIds: Array.isArray(skill.mcpServerIds) ? skill.mcpServerIds.filter(Boolean) : [],
    },
    // A package skill carries reference documents it deliberately does NOT inline — that
    // is what progressive disclosure means in this format. Without carrying the index the
    // prompt arrives referring to files the model has no way to open, which reads to the
    // user as the skill being broken rather than starved.
    files: skillPackageFiles(skill),
    origin: skill.origin && skill.origin.source ? { source: skill.origin.source, id: skill.origin.id || '' } : null,
  };
}

/**
 * The readable, non-executable files a skill ships, as `<kind>/<name>` paths.
 *
 * `scripts` is deliberately excluded. It is tier-3 code that runs in the bridge behind the
 * scanner, not text for a model to read — and handing a script's SOURCE to the model would
 * be the worst of both: the injection surface of running it with none of the usefulness.
 */
export function skillPackageFiles(skill) {
  const files = skill?.files;
  if (!files || typeof files !== 'object') return [];
  const out = [];
  for (const kind of ['references', 'assets', 'templates', 'examples']) {
    for (const name of Array.isArray(files[kind]) ? files[kind] : []) {
      if (typeof name === 'string' && name) out.push(`${kind}/${name}`);
    }
  }
  return out.slice(0, 60); // an index, not a manifest dump
}

export function filterMcpServersForSkill(servers, skillRun) {
  const usable = enabledServers(servers);
  const mode = skillRun?.mcp?.mode || 'none';
  if (mode === 'none') return [];
  if (mode !== 'selected') return usable;
  const ids = new Set(skillRun?.mcp?.serverIds || []);
  if (!ids.size) return [];
  return usable.filter((s) => ids.has(s.id));
}

function serverToolText(server) {
  const tools = (server.tools || []).map((t) => t.name).filter(Boolean).slice(0, 12);
  return tools.length ? `${server.name || server.id}: ${tools.join(', ')}` : `${server.name || server.id}`;
}

export function skillToolSystem(skillRun, allServers = []) {
  if (!skillRun) return '';
  const lines = [];
  if (skillRun.history?.enabled) {
    const label = skillRun.history.scope === 'all'
      ? 'chat and meeting history'
      : skillRun.history.scope === 'meetings'
        ? 'meeting history'
        : 'chat history';
    lines.push(`This skill has ${label} tools available. Use history_search first when prior local context would improve the answer, then history_get_source or history_related when useful.`);
  }
  if (skillRun.history?.blocked === 'meetings') {
    lines.push('Meeting history was requested for this skill, but it is not available for the current plan.');
  }
  // Level 0 of progressive disclosure: the model is told what exists and how to open it,
  // and pays for CONTENT only when it decides a file is worth reading.
  if (skillRun.files?.length) {
    lines.push(
      `This skill ships reference files: ${skillRun.files.join(', ')}. `
      + 'Their contents are NOT included above. Call skill_file with one of those exact paths to read one, '
      + 'and only when the task needs it — read the smallest set that answers the question.',
    );
  }
  if (skillRun.mcp?.mode === 'none') {
    lines.push('MCP tools are disabled for this skill.');
  } else if (skillRun.mcp?.mode === 'selected') {
    const selected = filterMcpServersForSkill(allServers, skillRun);
    if (selected.length) {
      lines.push(`This skill is scoped to these MCP servers/tools: ${selected.map(serverToolText).join(' | ')}. Prefer these tools when they help complete the skill.`);
    } else {
      lines.push('This skill selected MCP tools, but none of the selected MCP servers are currently enabled.');
    }
  }
  if (skillRun.history?.enabled || skillRun.mcp?.mode === 'selected' || skillRun.mcp?.mode === 'default') {
    lines.push(sourceCitationSystem());
  }
  return lines.join('\n');
}


// --------------------------------------------------------------------------
// Skill DISCOVERY — level 0 of progressive disclosure for the whole skill set.
//
// A skill used to be invisible until you typed its /command. That is fine when you know
// the skill exists, and useless when you do not — the model answering a question a skill
// was built for had no idea the skill was there. Discovery gives the model a compact
// CATALOG (name + one line each) and one tool, skill_open, to load the full instructions
// of whichever skill fits. The full prompt is paid for only on a match; the catalog itself
// is a line per skill, and it is added ONLY on turns that already arm tools — so a
// greeting or a simple question carries none of it.
// --------------------------------------------------------------------------

// How a skill is addressed in the catalog and to skill_open — its slash command if it has
// one (what a user would type), else its name.
export function skillHandle(skill) {
  return String(skill?.command || skill?.name || '').trim().toLowerCase();
}

const CATALOG_CAP = 14;

// Cheap keyword overlap with the request, so the most likely skills lead a capped list.
// Not a ranker to be proud of — deliberately: it costs nothing, runs on every armed turn,
// and only has to float the obvious match to the top of a short list the model then reads.
function scoreSkill(skill, words) {
  if (!words.size) return 0;
  const hay = `${skill.name} ${skill.command} ${skill.description || ''}`.toLowerCase();
  const keys = new Set(hay.split(/\W+/).filter((w) => w.length > 3));
  let score = 0;
  for (const w of words) if (keys.has(w)) score += 1;
  return score;
}

export function rankSkills(skills, userText = '') {
  const list = enabledSkills(skills);
  const words = new Set(String(userText || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  // Stable: a relevance tie keeps original order, so the list does not reshuffle between
  // turns of the same conversation for no reason the user can see.
  return list
    .map((s, i) => ({ s, i, score: scoreSkill(s, words) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.s);
}

const trunc = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * The catalog block for the system prompt, or '' when there is nothing to advertise.
 * Relevance-ranked and capped; a `skillRun` (an explicitly invoked skill) means the user
 * already chose, so the caller passes no catalog then.
 */
export function skillCatalogSystem(skills, { userText = '', cap = CATALOG_CAP } = {}) {
  const ranked = rankSkills(skills, userText);
  if (!ranked.length) return '';
  let shown = ranked.slice(0, cap);
  // If the request NAMES a skill by its handle or name, that skill must be in the catalog
  // even past the cap — "use the foundry skill" should never fail because foundry ranked
  // 15th. rankSkills already floats keyword matches up, so this only rescues an exact name
  // mention in a very long list.
  const q = String(userText || '').toLowerCase();
  if (q) {
    const named = ranked.filter((s) => {
      const h = skillHandle(s);
      const n = String(s.name || '').toLowerCase();
      return (h && q.includes(h)) || (n.length > 2 && q.includes(n));
    });
    for (const s of named) if (!shown.includes(s)) shown = [s, ...shown].slice(0, cap);
  }
  const line = (s) => `- ${skillHandle(s) || s.name}: ${trunc(String(s.description || s.name), 90)}`;
  const more = ranked.length > shown.length
    ? `\n(+${ranked.length - shown.length} more — the user can type /command to run any skill directly.)`
    : '';
  return [
    'SKILLS AVAILABLE — reusable procedures the user has set up. If the request clearly '
    + 'matches one, call skill_open with its name to load its full instructions, then follow '
    + 'them. For a simple or unrelated request, answer directly and do not open a skill.',
    shown.map(line).join('\n') + more,
  ].join('\n');
}
