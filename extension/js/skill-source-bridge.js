// The local bridge as a skill source.
//
// The first registration against the shared contract, and deliberately the LOCAL one
// rather than a hub: the bytes are already on this machine, put there by the user or by
// another agent CLI they run, so nothing here crosses the network and nothing needs the
// scanner that gates fetched packages. A hub source is the same three functions with a
// different fetch behind them.
//
// The payoff is the cross-tool one. The bridge scans `~/.agents/skills/` as well as its
// own directory, so a skill written in another agent CLI shows up here with no export
// step — which is the argument for putting the store in the bridge rather than in one
// client, made visible.

import { defineSkillSource } from './events/skill-sources.js';

// Which agent's folder a skill was found in. The bridge sends an id; the label lives
// HERE rather than travelling with the record, because a label that arrived with the data
// would be a string a future remote source could set to anything reassuring.
const SOURCE_LABELS = {
  local: 'ChatPanel',
  'agents-dir': 'Shared ~/.agents',
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  gemini: 'Antigravity / Gemini',
  opencode: 'OpenCode',
  kiro: 'Kiro',
  pi: 'Pi',
  hermes: 'Hermes',
  external: 'Custom folder',
};

/** Human name for an agent-folder id; an unknown one is shown as itself, not hidden. */
export function skillOriginLabel(foundIn) {
  const src = String(foundIn || '');
  return SOURCE_LABELS[src] || src || '';
}

const base = (bridgeUrl) => (bridgeUrl || 'http://127.0.0.1:4319').replace(/\/$/, '');

async function get(bridgeUrl, path) {
  const res = await fetch(`${base(bridgeUrl)}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);
  const json = await res.json();
  if (json.ok === false) throw new Error(json.error || 'bridge refused');
  return json;
}

/**
 * @param bridgeUrl   read at call time, not captured, so changing it in Settings takes
 *                    effect without re-registering the source
 * @param supported   () => boolean — whether /health advertised `skills`. An older bridge
 *                    omits it, and asking it for /skills would 404; a source that cannot
 *                    answer is ABSENT rather than an error the user must interpret.
 */
export function bridgeSkillSource({ bridgeUrl, supported }) {
  const url = () => (typeof bridgeUrl === 'function' ? bridgeUrl() : bridgeUrl);
  return defineSkillSource({
    id: 'bridge',
    label: 'Your machine (bridge)',
    // Local files on the user's own machine, reached over loopback. Not `net`: this
    // declaration is what a reviewer reads, and calling loopback "network access" would
    // make the statement useless by making everything say the same thing.
    trust: 'local',
    reads: ['files'],
    available: () => (typeof supported === 'function' ? !!supported() : !!supported),
    list: async ({ query = '' } = {}) => {
      const { skills = [] } = await get(url(), '/skills');
      const q = query.trim().toLowerCase();
      // Filtering happens here rather than over the wire: the bridge serves a bounded
      // local list, so a query parameter would be a second thing to keep in step for no
      // latency saved.
      const hits = !q ? skills : skills.filter((s) => (
        `${s.name} ${s.id} ${s.description || ''}`.toLowerCase().includes(q)
      ));
      // `foundIn` is which agent's folder held it — the registry stamps origin.source with
      // the SOURCE id ('bridge'), which is correct for provenance but loses the detail the
      // user cares about when the same skill sits in four agents' folders. Set here from
      // the bridge's own answer, and overwritten unconditionally so a payload cannot
      // supply its own.
      const items = hits.map((s) => ({ ...s, foundIn: s.origin?.source || '' }));
      return { items };
    },
    read: async (id) => (await get(url(), `/skills/${encodeURIComponent(id)}`)).skill,
    readFile: async (id, path) => get(
      url(),
      `/skills/${encodeURIComponent(id)}/file/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    ),
  });
}

/**
 * Read one file from a skill package, for the `skill_file` tool.
 *
 * Separate from the source registry on purpose: a TURN needs one file from a skill the user
 * already added, not a registry of places to browse. Building the registry to fetch one
 * document would drag the browse path onto every turn that uses a packaged skill.
 *
 * `origin.id` is the bridge's own path for the skill (`.system/imagegen`), which is what
 * its routes expect — not the local id the user may have renamed.
 */
export async function readSkillFile({ bridgeUrl, origin, path }) {
  const skillId = String(origin?.id || '').split('/').pop();
  if (!skillId) throw new Error('this skill has no package on disk');
  return get(
    bridgeUrl,
    `/skills/${encodeURIComponent(skillId)}/file/${String(path).split('/').map(encodeURIComponent).join('/')}`,
  );
}
