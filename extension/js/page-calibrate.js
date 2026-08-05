// TURN CALIBRATION — turn aiming from a guess into a calculation.
//
// In a pointer-locked app the only way to aim is to turn the view by some number
// of mouse-delta pixels. Nothing tells an agent how much a given delta turns the
// camera: sensitivity varies per app, per settings, per FOV. So it guesses, takes
// a screenshot to see what happened, guesses again — which is both slow and the
// reason a long aiming sequence wanders.
//
// Calibrating removes the guess: turn by a KNOWN delta, measure how far the image
// actually shifted, and report pixels-of-view per unit-of-delta. After that a turn
// is arithmetic, and the agent can move a target under the reticle in one step.
//
// It measures against SCREENSHOTS rather than canvas pixels on purpose — CDP's
// capture works on WebGL and 3D canvases, which is exactly where this is needed
// and where getImageData refuses.

import { cdpScreenshot, cdpMoveMouse } from './page-actions-cdp.js';

// Downsample a screenshot to one grayscale row: average a horizontal band, which
// is stable against vertical noise (HUD, bobbing) while preserving the horizontal
// structure a yaw turn shifts.
async function bandSignature(dataUrl, width = 256) {
  const img = await loadImage(dataUrl);
  const canvas = new OffscreenCanvas(width, 32);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Take the middle band — the horizon in a first-person view, and the busiest
  // part of most 2D scenes.
  ctx.drawImage(img, 0, Math.round(img.height * 0.35), img.width, Math.round(img.height * 0.3), 0, 0, width, 32);
  const { data } = ctx.getImageData(0, 0, width, 32);
  const row = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < 32; y++) {
      const i = (y * width + x) * 4;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    row[x] = sum / 32;
  }
  // Zero-mean so correlation measures structure, not brightness.
  let mean = 0;
  for (let i = 0; i < width; i++) mean += row[i];
  mean /= width;
  for (let i = 0; i < width; i++) row[i] -= mean;
  return row;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}

// Best horizontal shift (in downsampled columns) taking `a` onto `b`, by
// normalized cross-correlation. Returns { shift, score } with score in -1..1;
// a low score means the two frames don't share structure, so the measurement
// must NOT be trusted.
function bestShift(a, b, maxShift) {
  const n = a.length;
  let best = { shift: 0, score: -Infinity };
  for (let s = -maxShift; s <= maxShift; s++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const j = i + s;
      if (j < 0 || j >= n) continue;
      dot += a[i] * b[j];
      na += a[i] * a[i];
      nb += b[j] * b[j];
    }
    const denom = Math.sqrt(na * nb);
    const score = denom > 0 ? dot / denom : 0;
    if (score > best.score) best = { shift: s, score };
  }
  return best;
}

// Turn by `delta`, measure the resulting image shift, then turn back. Runs a
// couple of probe sizes so a too-small turn (lost in noise) or a too-large one
// (structure leaves the frame) can be discarded rather than believed.
export async function calibrateTurn(tabId, { delta = 200, viewportWidth } = {}) {
  const probes = [Math.round(delta / 2), Math.round(delta)].filter((d) => d > 0);
  const samples = [];
  let lastError = null;

  for (const d of probes) {
    try {
      const before = await cdpScreenshot(tabId);
      if (!before) { lastError = 'could not capture the screen'; continue; }
      const turn = await cdpMoveMouse(tabId, { dx: d, dy: 0 });
      if (turn?.ok === false) { lastError = turn.error; continue; }
      // A frame or two for the app to render the new view.
      await new Promise((r) => setTimeout(r, 120));
      const after = await cdpScreenshot(tabId);
      // Always turn back, so calibrating doesn't leave the view somewhere new.
      await cdpMoveMouse(tabId, { dx: -d, dy: 0 });
      if (!after) { lastError = 'could not capture the screen after turning'; continue; }

      const [sa, sb] = await Promise.all([bandSignature(before), bandSignature(after)]);
      const { shift, score } = bestShift(sa, sb, 96);
      samples.push({ delta: d, shiftCols: shift, score });
    } catch (e) {
      lastError = String(e?.message || e);
    }
  }

  // Keep only confident, non-degenerate measurements.
  const good = samples.filter((s) => s.score > 0.5 && Math.abs(s.shiftCols) >= 2);
  if (!good.length) {
    return {
      ok: false,
      samples,
      error:
        (lastError ? `${lastError}. ` : '') +
        'Could not measure a reliable turn. Either the view did not move (is the pointer captured? call ' +
        'capture_pointer first), the scene is too featureless to match, or it moved so far that nothing ' +
        'recognisable stayed on screen — retry with a smaller `delta`. Do NOT assume a sensitivity; aim ' +
        'by turning a little, re-screenshotting, and correcting.',
    };
  }

  // The signature is 256 columns wide regardless of the real viewport, so convert
  // back to viewport pixels before reporting anything the caller can act on.
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : null;
  const ratios = good.map((s) => Math.abs(s.shiftCols) / s.delta);
  const meanCols = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const viewPxPerDelta = vw ? (meanCols * vw) / 256 : null;

  // Agreement between probes is the honest confidence signal: two sizes landing on
  // the same ratio means the response is linear and the number is usable.
  const spread = ratios.length > 1 ? Math.abs(ratios[0] - ratios[1]) / Math.max(...ratios) : 0;

  return {
    ok: true,
    samples: good,
    viewPixelsPerDelta: viewPxPerDelta != null ? Number(viewPxPerDelta.toFixed(3)) : undefined,
    linear: ratios.length > 1 ? spread < 0.25 : undefined,
    ...(vw && viewPxPerDelta > 0
      ? { deltaForFullViewport: Math.round(vw / viewPxPerDelta) }
      : {}),
    note:
      viewPxPerDelta != null
        ? `A move_mouse dx of 1 turns the view about ${viewPxPerDelta.toFixed(2)} viewport pixels. ` +
          `To bring something that sits N pixels to the RIGHT of the reticle onto it, turn dx ≈ N / ${viewPxPerDelta.toFixed(2)}. ` +
          (ratios.length > 1 && spread >= 0.25
            ? 'WARNING: the two probe sizes disagreed, so the response is not linear — treat this as rough and verify after each turn.'
            : 'Verify with a screenshot after the first calculated turn, then trust it.')
        : 'Measured a consistent shift but the viewport width was unknown, so this is in relative units only.',
  };
}

export const CALIBRATE_TOOL_SPEC = {
  name: 'calibrate_turn',
  description:
    'Measure how far a mouse delta actually turns the view, so aiming becomes arithmetic instead of ' +
    'guesswork. Call this ONCE after capture_pointer, before you start aiming in a pointer-locked / ' +
    'first-person app. It turns by a known amount, measures the real image shift, turns back, and returns ' +
    'viewPixelsPerDelta — with that you can put a target under the reticle in one move_mouse instead of ' +
    'a dozen guess-and-screenshot rounds. If it reports ok:false, do not invent a sensitivity: turn ' +
    'small, re-screenshot, correct.',
  parameters: {
    type: 'object',
    properties: {
      delta: { type: 'number', description: 'Probe size in mouse-delta units (default 200).' },
    },
    required: [],
  },
};
