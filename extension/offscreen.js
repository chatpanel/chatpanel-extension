// Offscreen blob builder (see offscreen.html for the why).
//
// The service worker does ALL the work — export, compress, encrypt — because it
// has chrome.storage and an offscreen document does NOT. Our only job here is the
// one thing a service worker can't do: URL.createObjectURL. The SW hands us the
// finished payload (already-compressed) as `text` or base64 `b64`; we return a
// blob: URL, which the SW downloads. This sidesteps the base64 data: URL size
// ceiling that broke large backups.
//
// SECURITY: the payload is the SW's own backup bytes — a blob: URL is in-memory
// and extension-scoped; nothing is rendered or sent anywhere.

const urls = new Set();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'cp-blob-url') {
    try {
      const mime = msg.mime || 'application/octet-stream';
      let blob;
      if (typeof msg.text === 'string') blob = new Blob([msg.text], { type: mime });
      else if (typeof msg.b64 === 'string') blob = new Blob([b64ToBytes(msg.b64)], { type: mime });
      else {
        sendResponse({ error: 'no backup payload' });
        return false;
      }
      const url = URL.createObjectURL(blob);
      urls.add(url);
      sendResponse({ url, bytes: blob.size });
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
    return false; // synchronous response
  }
  if (msg?.type === 'cp-backup-revoke') {
    if (msg.url && urls.has(msg.url)) {
      try {
        URL.revokeObjectURL(msg.url);
      } catch {
        /* already gone */
      }
      urls.delete(msg.url);
    }
    sendResponse?.({ ok: true });
    return false;
  }
  return false;
});
