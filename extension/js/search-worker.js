// Off-the-UI-thread history search. The heavy work — tokenizing the whole corpus and
// building the BM25 index — runs here in a Web Worker so the side panel / dashboards
// never jank while a year of chats/meetings is indexed. Reuses the SAME pure ranking
// as the main thread (history-rag-core), so results are identical to the sync path.
//
// Protocol (postMessage):
//   → { type:'load', version, sources }     hand the worker the current corpus
//   → { type:'search', reqId, query, options }   rank a query
//   ← { type:'ready', version }
//   ← { type:'result', reqId, results }
//   ← { type:'error', reqId, message }
//
// Memory: the worker holds the corpus + a small LRU of built indexes (keyed by the
// field/scope options that change the index), and drops them after idle so it doesn't
// pin a large heap. The main thread re-sends `load` when the corpus version changes.

import { buildSearchIndex, runSearch } from './history-rag-core.js';

const IDLE_RELEASE_MS = 90_000;
const MAX_BUILT = 4; // distinct (field/scope) index variants kept at once

let corpus = null;      // { version, sources }
const built = new Map(); // optionKey -> { at, index }
let idleTimer = null;

function optionKey(options = {}) {
  return `${options.field || 'all'}|${options.scope || 'all'}|${options.includeMeetings !== false ? 1 : 0}`;
}

function releaseIdle() {
  corpus = null;
  built.clear();
  idleTimer = null;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseIdle, IDLE_RELEASE_MS);
}

function indexFor(options) {
  const key = optionKey(options);
  let entry = built.get(key);
  if (!entry) {
    entry = { at: 0, index: buildSearchIndex(corpus.sources, options) };
    built.set(key, entry);
    // Evict the least-recently-used variant if we're holding too many.
    if (built.size > MAX_BUILT) {
      let oldestKey = null; let oldest = Infinity;
      for (const [k, v] of built) { if (v.at < oldest) { oldest = v.at; oldestKey = k; } }
      if (oldestKey && oldestKey !== key) built.delete(oldestKey);
    }
  }
  entry.at = Date.now();
  return entry.index;
}

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') {
      corpus = { version: msg.version, sources: msg.sources || [] };
      built.clear();
      touchIdle();
      self.postMessage({ type: 'ready', version: msg.version });
      return;
    }
    if (msg.type === 'search') {
      if (!corpus) { self.postMessage({ type: 'error', reqId: msg.reqId, message: 'no-corpus' }); return; }
      const results = runSearch(indexFor(msg.options || {}), msg.query, msg.options || {});
      touchIdle();
      self.postMessage({ type: 'result', reqId: msg.reqId, results });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId, message: String(err && err.message || err) });
  }
};
