#!/usr/bin/env node
// W0 — measure the corpus before building a derived layer on top of it.
//
//   node tools/knowledge-survey.mjs <backup.zip | backup.json | backup.encrypted.json>
//     --passphrase <pw>   (or CHATPANEL_BACKUP_PASSPHRASE) for an encrypted backup
//     --json              emit the report object instead of the text rendering
//     --questions <n>     how many recent user turns to measure spanning over (default 200)
//
// This is a SCRIPT, not a feature. `docs/knowledge-compounding.md` §10 says the first move
// is measurement, and it means it: the thresholds that decide which subjects earn a page
// have to come from a real corpus, not from taste, and the honest outcome of running it is
// possibly "our corpus is not dense enough — go finish retrieval instead".
//
// It runs against a BACKUP rather than live storage because the corpus is encrypted at rest
// inside the extension and there is no product surface for this — and there should not be
// one yet. Export a backup from Settings → Backup & restore, then point this at the file.
//
// Two things it deliberately does NOT do: call a model (every pass here is deterministic,
// which is the point — see curate.js), and write anything anywhere.
//
// The record shapes come from the extension's own conversationSource/meetingSource/
// noteSource, imported directly, so what this measures is exactly what search, RAG, the
// omni palette and the graph see. A simplified mirror here would measure a corpus the
// product does not actually have.

import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

// The source builders reach for chrome.runtime.getURL to make local dashboard links, and
// history-rag wires a storage.onChanged listener for its source cache. Same stub the
// history-rag tests use — nothing is read from it.
globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://survey/${p}` },
  storage: { onChanged: { addListener() {} }, local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

// A tiny hand-rolled parse rather than a dependency: the extension repo ships zero runtime
// deps and its tools follow the same rule.
const VALUE_FLAGS = new Set(['passphrase', 'questions']);
const flags = new Map();
const positional = [];
{
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) { flags.set(name, args[i + 1] ?? ''); i += 1; } else flags.set(name, true);
  }
}
const flag = (name, fallback = null) => (flags.get(name) || fallback);
const has = (name) => flags.get(name) === true;
const file = positional[0];

if (!file) {
  console.error('usage: node tools/knowledge-survey.mjs <backup.zip|.json|.encrypted.json> [--passphrase pw] [--json] [--questions 200]');
  exit(2);
}

async function readBackup(path) {
  const buf = readFileSync(path);
  // Detect by magic bytes, not by extension — a renamed export still has to work, which is
  // the same rule the Settings importer follows.
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const { readZipEntry } = await import('../extension/js/zip.js');
    const text = await readZipEntry(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'chatpanel-data.json');
    if (!text) throw new Error('that zip has no chatpanel-data.json — is it a ChatPanel export?');
    return JSON.parse(text);
  }
  const obj = JSON.parse(buf.toString('utf8'));
  const { isEncryptedBackup, decryptBackup } = await import('../extension/js/crypto-backup.js');
  if (!isEncryptedBackup(obj)) return obj;
  const pass = flag('passphrase', env.CHATPANEL_BACKUP_PASSPHRASE || '');
  if (!pass) throw new Error('that backup is encrypted — pass --passphrase or set CHATPANEL_BACKUP_PASSPHRASE');
  return decryptBackup(obj, pass);
}

/** Backup payload → the source records the product itself builds. */
async function toRecords(data) {
  const { conversationSource, meetingSource, noteSource } = await import('../extension/js/history-rag.js');
  const out = [];
  for (const conv of data?.conversations || []) {
    // The backup stores whole conversations, so the record IS its own index entry.
    const src = conversationSource(conv, conv);
    if (src) out.push(src);
  }
  for (const m of data?.meetings || []) {
    const rec = m?.record || m;
    const src = meetingSource(rec, rec, typeof m?.notes === 'string' ? m.notes : '', m?.topics || null, []);
    if (src) out.push(src);
  }
  for (const n of data?.notes || []) {
    const src = noteSource(n, n);
    if (src) out.push(src);
  }
  return out;
}

/** The most recent user turns — what "a question" means for the spanning measure. */
function recentQuestions(data, limit) {
  const turns = [];
  for (const conv of data?.conversations || []) {
    for (const m of conv?.messages || []) {
      if (m?.role !== 'user' || !m.content) continue;
      turns.push({ at: m.at || m.ts || conv.updatedAt || 0, text: String(m.content) });
    }
  }
  return turns.sort((a, b) => b.at - a.at).slice(0, limit).map((t) => t.text);
}

try {
  const data = await readBackup(file);
  const records = await toRecords(data);
  const questions = recentQuestions(data, Number(flag('questions', 200)) || 200);

  const { surveyCorpus, thresholdSweep, formatSurvey } = await import('../extension/js/events/curate.js');
  const report = surveyCorpus(records, { questions });
  const sweep = thresholdSweep(records);

  if (has('json')) {
    console.log(JSON.stringify({ report, sweep }, null, 2));
  } else {
    console.log(`ChatPanel knowledge survey (W0) — ${file}`);
    console.log(`backup version ${data?.version ?? '?'} · ${questions.length} recent user turns measured\n`);
    console.log(formatSurvey(report, { sweep }));
  }
} catch (err) {
  console.error(`survey failed: ${err?.message || err}`);
  exit(1);
}
