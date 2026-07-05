// History storage seam — the provider boundary for conversation storage.
//
// Every conversation lives in chrome.storage.local, which is scoped to the
// extension ID and bounded in size. This file defines a provider boundary so a
// future cold tier can be added as a one-file change. Callers go through
// getHistoryStore() instead of touching chrome.storage directly; the index stays
// local in every implementation. LocalHistoryStore is the current behavior
// (delegates to store.js) and is the default. GatewayHistoryStore is a not-yet-
// implemented cold-tier stub.
//
// CONTRACT (per provider):
//   listIndex()            → [{id,title,agentId,updatedAt,msgs}]  (always local, hot)
//   getConversation(id)    → full conversation | null
//   putConversation(conv)  → void   (persist a full conversation)
//   deleteConversation(id) → void
//   clear()                → void   (drop all conversations in this tier)
//
// ZERO-KNOWLEDGE RULE for any remote provider: the client encrypts each record
// with a user-held content key (see crypto-backup.js — same AES-GCM/PBKDF2
// primitives) BEFORE it leaves the device. The gateway/R2 only ever sees
// ciphertext; ChatPanel cannot read it. Restore = fetch ciphertext + decrypt
// locally. This is the Bitwarden model: encrypted at rest, key with the user.

import {
  getIndex,
  getConversation,
  saveConversation,
  deleteConversation,
  clearAllConversations,
} from './store.js';

// Current behavior: everything in chrome.storage.local via store.js. Hot + cold
// are the same tier here — nothing leaves the device.
export class LocalHistoryStore {
  get id() {
    return 'local';
  }
  listIndex() {
    return getIndex();
  }
  getConversation(id) {
    return getConversation(id);
  }
  putConversation(conv) {
    return saveConversation(conv);
  }
  deleteConversation(id) {
    return deleteConversation(id);
  }
  clear() {
    return clearAllConversations();
  }
}

// Cold tier served by the ChatPanel Gateway. The index stays local; only full-record
// reads/writes would hit the gateway, and every body is client-side encrypted first.
// Endpoints (to define on the gateway): GET/PUT/DELETE /v1/history/conversations/:id,
// GET /v1/history/index.
//
// Not yet implemented — left as the integration point so callers don't change when
// it lands.
export class GatewayHistoryStore {
  constructor({ baseUrl, contentKey } = {}) {
    this.baseUrl = baseUrl; // gateway origin, e.g. http://127.0.0.1:4320 or a hosted URL
    this.contentKey = contentKey; // user-held key/passphrase; gateway never sees plaintext
  }
  get id() {
    return 'gateway';
  }
  async listIndex() {
    throw new Error('GatewayHistoryStore: not yet available.');
  }
  async getConversation(_id) {
    throw new Error('GatewayHistoryStore: not yet available.');
  }
  async putConversation(_conv) {
    throw new Error('GatewayHistoryStore: not yet available.');
  }
  async deleteConversation(_id) {
    throw new Error('GatewayHistoryStore: not yet available.');
  }
  async clear() {
    throw new Error('GatewayHistoryStore: not yet available.');
  }
}

// Select the active provider from settings. Defaults to local; opt into the
// gateway tier via settings.ui.historyStore = { mode:'gateway', baseUrl, ... }.
// Until GatewayHistoryStore is implemented, callers should treat a non-local
// store as best-effort and keep the local index authoritative.
export function getHistoryStore(settings) {
  const cfg = settings?.ui?.historyStore;
  if (cfg && cfg.mode === 'gateway' && cfg.baseUrl) {
    return new GatewayHistoryStore({ baseUrl: cfg.baseUrl, contentKey: cfg.contentKey });
  }
  return new LocalHistoryStore();
}
