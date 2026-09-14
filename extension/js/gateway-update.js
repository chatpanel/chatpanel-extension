// Updating the gateway from Settings, as a capability rather than a button handler — the
// gateway's twin of js/bridge-update.js.
//
// The gateway (0.6.107+) updates ITSELF: `POST /update` starts a job — the npm install or
// the binary swap, which can take minutes — and `GET /update` reports it; when the install
// has landed the gateway restarts into it, so the connection drops and a DIFFERENT process
// has to answer on the same port with the new version before anyone may call it done. The
// phases are narrated (`onStatus`), because a silent minute reads as a hang.
//
// Never throws: every failure is a sentence the settings page shows.

import { normalizeGatewayUrl, getGatewayToken, checkGateway } from './gateway.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, path, opts = {}) {
  const token = getGatewayToken();
  const headers = token ? { ...(opts.headers || {}), Authorization: `Bearer ${token}` } : opts.headers;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}${path}`, { ...opts, headers, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, status: res.status, ...json } : { ok: false, status: res.status, error: json?.error?.message || json?.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally { clearTimeout(timer); }
}

/** A fresh check against the gateway's channel (the registry or the release), past the 6 h throttle. */
export async function checkGatewayUpdate(url) {
  const base = normalizeGatewayUrl(url);
  if (!base) return { ok: false, error: 'no gateway URL' };
  const r = await call(base, '/update?force=1');
  return r.ok ? { ok: true, update: r.update, job: r.job } : r;
}

/**
 * Start the update and wait for the new version to answer. Resolves
 * `{ ok, from, to, slow?, manual? }`: `slow` when the install landed but the restart has not
 * answered yet; `manual` when it landed and the gateway has no service to restart itself.
 *
 * `onStatus(phase, detail)` — 'installing' | 'restarting' | 'waiting'.
 */
export async function updateGatewayAndWait(url, { onStatus = () => {}, pollMs = 2000, installTimeoutMs = 20 * 60_000, restartTries = 20, restartGapMs = 1500 } = {}) {
  const base = normalizeGatewayUrl(url);
  if (!base) return { ok: false, error: 'no gateway URL' };
  const started = await call(base, '/update', { method: 'POST' });
  // 404: a gateway from before /update existed — it cannot update itself; say so plainly.
  if (!started.ok) return { ok: false, error: started.status === 404 ? 'this gateway is too old to update itself (needs 0.6.107+) — update it once by hand and it can from then on' : started.error };
  const from = started.job?.from || '';
  onStatus('installing', started.job?.detail || '');
  // Watch the job. The gateway answers GET /update until the moment it restarts; from then
  // on the connection fails, which IS the signal that the restart began.
  const t0 = Date.now();
  let job = started.job || {};
  while (Date.now() - t0 < installTimeoutMs) {
    await sleep(pollMs);
    const r = await call(base, '/update');
    if (!r.ok) { if (job.state === 'restarting' || job.state === 'installing') break; return { ok: false, error: r.error }; }
    job = r.job || {};
    if (job.state === 'failed') return { ok: false, error: job.detail || 'the update failed', from };
    if (job.state === 'done') return { ok: true, from, to: job.to, manual: true, detail: job.detail };
    if (job.state === 'restarting') { onStatus('restarting', job.detail || ''); break; }
    if (job.state === 'idle') return { ok: false, error: 'the gateway did not start the update', from };
    onStatus('installing', job.detail || '');
  }
  if (job.state === 'installing') return { ok: false, error: `the install was still running after ${Math.round(installTimeoutMs / 60000)} minutes`, from };
  // The new process. Success is the version having MOVED — not the old one answering again.
  onStatus('waiting', job.to ? `waiting for v${job.to} to answer` : '');
  await sleep(3000);
  for (let i = 0; i < restartTries; i += 1) {
    const state = await checkGateway(base);
    if (state?.ok && state.version && (!job.to || state.version === job.to || state.version !== from)) {
      if (from && state.version === from) return { ok: false, error: `the gateway came back still on v${from} — the copy that was updated is not the one the service runs`, from, to: state.version };
      return { ok: true, from, to: state.version, state };
    }
    await sleep(restartGapMs);
  }
  // The install landed; the gateway just has not finished coming back (a cold start loads
  // models). Reporting that as a failure sends the user to reinstall something already updated.
  return { ok: true, from, to: job.to, slow: true };
}

/** How to update by hand, when the running gateway cannot do it itself. Beside the capability
 *  so every screen says the same thing. */
export function gatewayInstallCommands(update = {}) {
  if (update?.npmCommand) return [{ label: 'Update the npm install', cmd: update.npmCommand }];
  return [
    { label: 'macOS / Linux', cmd: 'curl -fsSL https://dl.chatpanel.net/install.sh | bash' },
    { label: 'Windows (PowerShell)', cmd: 'irm https://dl.chatpanel.net/install.ps1 | iex' },
  ];
}
