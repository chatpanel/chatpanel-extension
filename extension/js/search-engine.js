// Main-thread front end for off-thread history search. Owns the Web Worker
// (search-worker.js), keeps it fed with the current corpus, and forwards queries —
// falling back to the synchronous main-thread path whenever a Worker isn't available
// (unit tests, older runtimes) or errors. Results are identical either way (same pure
// ranking runs in both places), so callers can't tell which path served them.

import { searchHistorySources } from './history-rag-core.js';

let worker = null;
let workerDead = false;
let sentKey = null; // the corpus signature last handed to the worker
let reqSeq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker || workerDead) return worker;
  try {
    if (typeof Worker === 'undefined' || !globalThis.chrome?.runtime?.getURL) { workerDead = true; return null; }
    worker = new Worker(chrome.runtime.getURL('js/search-worker.js'), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      const p = m.reqId != null ? pending.get(m.reqId) : null;
      if (!p) return;
      pending.delete(m.reqId);
      if (m.type === 'result') p.resolve(m.results);
      else p.reject(new Error(m.message || 'search-failed'));
    };
    worker.onerror = () => killWorker();
    worker.onmessageerror = () => killWorker();
  } catch { workerDead = true; worker = null; }
  return worker;
}

function killWorker() {
  workerDead = true;
  try { worker?.terminate(); } catch { /* ok */ }
  worker = null;
  sentKey = null;
  for (const p of pending.values()) p.reject(new Error('worker-gone'));
  pending.clear();
}

function searchOnWorker(w, query, options) {
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    w.postMessage({ type: 'search', reqId, query, options });
    setTimeout(() => {
      if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('worker-timeout')); }
    }, 8000);
  });
}

// Rank `query` over already-loaded `sources`. Tries the worker; on ANY problem, runs
// the identical ranking synchronously on the main thread so search never breaks.
export async function rankHistorySources(sources, query, options = {}, { version = 0 } = {}) {
  const w = ensureWorker();
  if (!w) return searchHistorySources(sources, query, options);
  // Re-send the corpus only when it actually changed (version bump), or its identity
  // shifted (includeMeetings scope / count). Otherwise the worker reuses its index.
  const loadKey = `${version}:${options.includeMeetings !== false ? 1 : 0}:${sources.length}`;
  try {
    if (loadKey !== sentKey) {
      w.postMessage({ type: 'load', version: loadKey, sources });
      sentKey = loadKey;
    }
    return await searchOnWorker(w, query, options);
  } catch {
    return searchHistorySources(sources, query, options); // fallback: never fail a search
  }
}
