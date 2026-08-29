// Can the in-browser (WebLLM) model actually RUN here?
//
// `navigator.gpu` existing is not the question. WebLLM's runtime (tvmjs) demands
// specific WebGPU *limits* and throws before it even calls requestDevice() if the
// adapter reports less. The one that bites is `maxStorageBuffersPerShaderStage`: tvmjs
// hard-requires **10**, while the WebGPU spec's default is 8 — so a spec-compliant
// implementation that doesn't raise it can never load a WebLLM model, no matter how
// capable the GPU is. Firefox is exactly that case today.
//
// Left to itself the user sees tvmjs's raw internal string:
//   "Cannot initialize runtime because of requested maxStorageBuffersPerShaderStage
//    exceeds limit. requested=10, limit=8."
// …which names no product, no cause and no way forward. This module turns that into a
// verdict the UI can act on BEFORE a 700 MB download starts: which limit fell short, by
// how much, and whether the shortfall is the browser's real ceiling or a privacy
// setting reporting generic numbers.
//
// Pure functions first (shortfall/looksClamped/explain) so the decision is testable
// without a GPU; the probe is the only part that touches the platform.
import { isGecko } from './browser-api.js';

// The floors tvmjs enforces in detectGPUDevice(), mirrored from the vendored runtime.
// maxBufferSize and maxStorageBufferBindingSize are the values AFTER its own fallbacks
// (it tries 1 GB, retries at 256 MB / 128 MB, then throws), so these are the true
// give-up points, not its first ask.
export const WEBLLM_REQUIRED_LIMITS = Object.freeze({
  maxStorageBuffersPerShaderStage: 10,      // no fallback — the one Firefox fails
  maxComputeWorkgroupStorageSize: 32 << 10, // 32 KB, no fallback
  maxBufferSize: 1 << 28,                   // 256 MB
  maxStorageBufferBindingSize: 1 << 27,     // 128 MB
});

// WebGPU's specified default limits. Any implementation must offer at least these, and
// real hardware reports well above several of them — which is what makes an adapter
// reporting EXACTLY these a reliable signature of clamping rather than of a weak GPU.
export const WEBGPU_SPEC_DEFAULT_LIMITS = Object.freeze({
  maxBufferSize: 268435456,             // 256 MB — real GPUs report far more
  maxStorageBufferBindingSize: 134217728, // 128 MB
  maxTextureDimension2D: 8192,          // real hardware is normally 16384
  maxComputeInvocationsPerWorkgroup: 256, // real hardware is normally 1024
  maxStorageBuffersPerShaderStage: 8,
});

// Which requirements this adapter fails, worst-first. Pure: takes a plain object, so a
// test can feed it a Firefox/Chrome limit set without a GPU.
export function shortfall(limits) {
  const out = [];
  for (const [limit, need] of Object.entries(WEBLLM_REQUIRED_LIMITS)) {
    const have = Number(limits?.[limit]);
    if (!Number.isFinite(have) || have < need) out.push({ limit, need, have: Number.isFinite(have) ? have : 0 });
  }
  return out.sort((a, b) => a.have / a.need - b.have / b.need);
}

// Does this adapter look like it is reporting the spec's generic defaults rather than
// the hardware's real capability? Firefox clamps EVERY limit to the default when
// `privacy.resistFingerprinting` is on (its fingerprinting-protection default set does
// NOT include WebGPU limits, so this means full RFP, Tor Browser, or a hardening
// user.js). Requiring several independent limits to match exactly keeps a genuinely
// modest GPU from being mislabelled.
export function looksClamped(limits) {
  const entries = Object.entries(WEBGPU_SPEC_DEFAULT_LIMITS);
  const matches = entries.filter(([k, v]) => Number(limits?.[k]) === v);
  return matches.length === entries.length;
}

// Turn a shortfall into something worth showing a person: what is missing, why, and the
// next thing they can actually do. `browserHint` names the engine when we know it.
export function explain(gaps, { clamped = false, gecko = false } = {}) {
  if (!gaps.length) return '';
  const worst = gaps[0];
  const alternative =
    'ChatPanel still works fully — pick an API endpoint (a free provider key) or a local ' +
    'app like Ollama in Settings, and everything else behaves identically.';
  if (clamped) {
    return (
      `Your browser is reporting generic WebGPU limits instead of your GPU's real ones ` +
      `(${worst.limit} = ${worst.have}, the in-browser model needs ${worst.need}), so it can't start. ` +
      `That is what anti-fingerprinting protection does${gecko ? ' — in Firefox, privacy.resistFingerprinting' : ''}: ` +
      `it hides your hardware behind the spec's default numbers. Turn it off (or allow WebGPU limits) and ` +
      `the in-browser model can run. ${alternative}`
    );
  }
  if (worst.limit === 'maxStorageBuffersPerShaderStage') {
    return (
      `This browser's WebGPU exposes ${worst.have} storage buffers per shader stage and the in-browser ` +
      `model needs ${worst.need}.${gecko ? ' Firefox does not raise this above the WebGPU default yet, so the' +
      ' in-browser model cannot run there regardless of your GPU.' : ''} ${alternative}`
    );
  }
  return (
    `This browser's WebGPU is below what the in-browser model needs ` +
    `(${worst.limit} = ${worst.have}, needs ${worst.need}). ${alternative}`
  );
}

// --- the probe (the only part that touches the platform) --------------------
let _cached = null;   // last verdict, so the UI can read it synchronously
let _inflight = null; // shared so concurrent callers request one adapter

// The verdict without probing: null until webgpuSupport() has run once. Callers that
// must stay synchronous (the target picker) use this and treat null as "don't know yet".
export function cachedWebgpuSupport() {
  return _cached;
}

// Probe once and remember. Never throws: a browser with no WebGPU, a refused adapter and
// a clamped adapter are all just verdicts.
export async function webgpuSupport() {
  if (_cached) return _cached;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    // Engine from the extension APIs present, NOT from the user agent: the very setting
    // that clamps these limits (privacy.resistFingerprinting) also spoofs navigator
    // .userAgent, so UA sniffing would misfire in precisely the case we most need to
    // name. See js/browser-api.js.
    const gecko = isGecko;
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return {
        ok: false, code: 'WEBGPU_UNAVAILABLE', gaps: [], clamped: false,
        message: 'This browser has no WebGPU, so the in-browser model can’t run. Add an API endpoint '
          + '(a free provider key or local Ollama) in Settings.',
      };
    }
    let adapter = null;
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch { /* treated as "no adapter" below */ }
    if (!adapter) {
      return {
        ok: false, code: 'WEBGPU_NO_ADAPTER', gaps: [], clamped: false,
        message: 'No compatible GPU is available to this browser, so the in-browser model can’t run. '
          + 'Add an API endpoint (a free provider key or local Ollama) in Settings.',
      };
    }
    // adapter.limits is a live GPUSupportedLimits, not a plain object — read the keys
    // we care about across, so the pure helpers get something ordinary to work with.
    const limits = {};
    for (const key of new Set([...Object.keys(WEBLLM_REQUIRED_LIMITS), ...Object.keys(WEBGPU_SPEC_DEFAULT_LIMITS)])) {
      limits[key] = adapter.limits?.[key];
    }
    const gaps = shortfall(limits);
    if (!gaps.length) return { ok: true, code: 'OK', gaps: [], clamped: false, limits, message: '' };
    const clamped = looksClamped(limits);
    return {
      ok: false,
      code: clamped ? 'WEBGPU_LIMITS_CLAMPED' : 'WEBGPU_LIMITS_TOO_LOW',
      gaps, clamped, limits,
      message: explain(gaps, { clamped, gecko }),
    };
  })();
  try { _cached = await _inflight; return _cached; }
  finally { _inflight = null; }
}

// Testing seam: drop the memoized verdict.
export function resetWebgpuSupport() { _cached = null; _inflight = null; }
