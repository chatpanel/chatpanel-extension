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
      const items = !q ? skills : skills.filter((s) => (
        `${s.name} ${s.id} ${s.description || ''}`.toLowerCase().includes(q)
      ));
      return { items };
    },
    read: async (id) => (await get(url(), `/skills/${encodeURIComponent(id)}`)).skill,
    readFile: async (id, path) => get(
      url(),
      `/skills/${encodeURIComponent(id)}/file/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    ),
  });
}
