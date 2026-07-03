// One-time microphone grant page. The side panel can't show Chrome's mic
// permission prompt (SpeechRecognition there just fails with `not-allowed`), so
// dictation opens this page in a tab: a normal extension page CAN prompt via
// getUserMedia, and the grant is per-origin — once given here it covers the
// side panel, Notes, and every other extension page.
const btn = document.getElementById('grant');
const status = document.getElementById('status');

async function grant() {
  btn.disabled = true;
  status.textContent = 'Waiting for Chrome’s permission prompt…';
  status.className = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop(); // we only needed the grant, not the audio
    status.textContent = '✓ Microphone allowed — you can close this tab and dictate away.';
    status.className = 'ok';
    btn.textContent = 'Done';
    setTimeout(() => window.close(), 1600); // best-effort; fine if Chrome ignores it
  } catch (e) {
    btn.disabled = false;
    status.className = 'err';
    status.textContent = e?.name === 'NotAllowedError'
      ? '✕ Blocked. Click the mic icon in the address bar (or Site settings) and allow the microphone, then try again.'
      : '✕ ' + (e?.message || 'Could not access the microphone.');
  }
}

btn.onclick = grant;
// If permission is already granted, say so instead of making the user click.
navigator.permissions?.query({ name: 'microphone' }).then((p) => {
  if (p.state === 'granted') {
    status.textContent = '✓ Microphone is already allowed — dictation is ready.';
    status.className = 'ok';
    btn.textContent = 'Done';
  }
}).catch(() => {});
