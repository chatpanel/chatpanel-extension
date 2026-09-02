// The four stores a full backup carries that store.js deliberately does not keep on its
// own module graph — memory, widgets, jobs and the vault.
//
// Why this file exists at all: store.js is on the side panel's first-paint graph, so these
// four (~137 KB together) may not be static imports there — they serve a button nobody has
// pressed yet. The obvious fix was `await import()` inside exportAllData(), and that is
// exactly what shipped. It was wrong: scheduled backup runs in the MV3 service worker,
// where dynamic import() throws
//   TypeError: import() is disallowed on ServiceWorkerGlobalScope by the HTML specification
// so every unattended backup failed at the first lazy store and left the message in
// `lastError` for the settings page to show. Manual backup kept working, which is why it
// went unnoticed: the settings page is a document, and documents may import().
//
// So the laziness moves out here, behind ONE seam. Callers that live in a document
// `await import('./backup-payload.js')` at the call site and pay nothing before then;
// the service worker imports it statically and can never hit the throw. One seam rather
// than four also means the next store added to a backup is threaded through both callers
// by editing this file alone — the failure mode that produced this bug was per-store
// laziness that a caller could forget.
//
// See tools/test-service-worker-imports.mjs, which fails the build if a dynamic import()
// reappears on a service-worker code path.

import { exportMemories, importMemories } from './store-memory.js';
import { exportWidgets, importWidgets } from './widgets-store.js';
import { exportJobs, importJobs } from './jobs.js';
import { exportVault, importVault } from './vault.js';

/** Everything store.js needs to round-trip the late-arriving stores. */
export const backupExtras = Object.freeze({
  exportMemories, importMemories,
  exportWidgets, importWidgets,
  exportJobs, importJobs,
  exportVault, importVault,
});
