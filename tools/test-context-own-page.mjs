// Own-page context capture: reading our own dashboard tabs (notes/meetings/history)
// from storage by their URL hash id, instead of the script injection Chrome forbids
// on chrome-extension:// pages. Covers origin-spoof protection, the storage read,
// and captureTab's short-circuit (no executeScript for our own pages).
import assert from 'node:assert/strict';

const storage = new Map();
const tabsById = new Map();
let scriptingCalls = 0;

globalThis.chrome = {
  runtime: { id: 'testext', getURL: (p = '') => `chrome-extension://testext/${p}` },
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, storage.get(k)]).filter(([, v]) => v !== undefined));
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return {};
      },
      async set(values) { Object.entries(values).forEach(([k, v]) => storage.set(k, v)); },
      async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => storage.delete(k)); },
    },
  },
  tabs: { async get(id) { const t = tabsById.get(id); if (!t) throw new Error('No tab with id ' + id); return t; } },
  scripting: {
    async executeScript() {
      scriptingCalls++;
      return [{ result: { title: 'Injected', url: 'https://example.com', text: 'page body', selection: '' } }];
    },
  },
};

const { saveNote } = await import('../extension/js/store-notes.js');
const { isOwnDashboardUrl, captureOwnPage, captureTab } = await import('../extension/js/context.js');

const own = (path) => `chrome-extension://testext/${path}`;

// 1) isOwnDashboardUrl recognises our three dashboards, rejects everything else —
//    including the SAME page served from a different (spoofing) extension origin.
{
  assert.equal(isOwnDashboardUrl(own('notes.html#abc')), true);
  assert.equal(isOwnDashboardUrl(own('meetings.html#m1')), true);
  assert.equal(isOwnDashboardUrl(own('history.html#c1')), true);
  assert.equal(isOwnDashboardUrl('https://example.com/notes.html#abc'), false, 'a real web page is not our dashboard');
  assert.equal(isOwnDashboardUrl('chrome-extension://EVIL/notes.html#abc'), false, 'another extension cannot spoof our origin');
  assert.equal(isOwnDashboardUrl(own('settings.html')), false, 'non-readable extension pages are not dashboards');
  assert.equal(isOwnDashboardUrl(''), false);
}

// 2) captureOwnPage reads the note record from storage by the URL's hash id and
//    returns a normal readable attachment (title + markdown body, hashed url).
{
  const rec = await saveNote({ id: 'note-xyz', body: '# My roadmap\n\nShip the warm tier.' });
  const att = await captureOwnPage({ url: own(`notes.html#${rec.id}`) });
  assert.equal(att.kind, 'page');
  assert.equal(att.title, 'My roadmap');
  assert.match(att.text, /Ship the warm tier\./);
  assert.equal(att.url, own('notes.html#note-xyz'), 'attachment url keeps the hash so send-time dedupe is per-note');
  assert.ok(att.chars > 0);
}

// 3) A non-dashboard tab returns null (caller falls through to injection); an open
//    dashboard with nothing selected, or a missing record, throws a helpful error.
{
  assert.equal(await captureOwnPage({ url: 'https://example.com/' }), null);
  assert.equal(await captureOwnPage({ url: 'chrome-extension://EVIL/notes.html#note-xyz' }), null, 'spoofed origin is not read from our storage');
  await assert.rejects(() => captureOwnPage({ url: own('notes.html') }), /No note is open/);
  await assert.rejects(() => captureOwnPage({ url: own('notes.html#does-not-exist') }), /isn't in local storage/);
}

// 4) captureTab short-circuits our own pages to storage (NO script injection), and
//    still injects for ordinary web tabs.
{
  scriptingCalls = 0;
  tabsById.set(1, { id: 1, url: own('notes.html#note-xyz') });
  const own1 = await captureTab(1);
  assert.equal(own1.title, 'My roadmap');
  assert.equal(scriptingCalls, 0, 'own pages must not trigger executeScript');

  tabsById.set(2, { id: 2, url: 'https://example.com/article' });
  const web = await captureTab(2);
  assert.equal(web.title, 'Injected');
  assert.equal(scriptingCalls, 1, 'ordinary web tabs still go through injection');
}

console.log('context own-page tests passed');
