import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WEBLLM_REQUIRED_LIMITS, shortfall, looksClamped, explain,
  webgpuSupport, cachedWebgpuSupport, resetWebgpuSupport,
} from '../extension/js/webgpu-support.js';

// THE BUG THIS PREVENTS. `navigator.gpu` existing does NOT mean the in-browser model can
// run: WebLLM's runtime demands WebGPU limits above the spec defaults and throws its own
// raw internal string if they're missing. On Firefox that is guaranteed to happen, and
// without this check the user pays a ~700 MB download to receive
// "Cannot initialize runtime because of requested maxStorageBuffersPerShaderStage
//  exceeds limit. requested=10, limit=8." — which names no product and no way forward.

// ── the requirement must track the vendored runtime, not a memory of it ────
// If web-llm.js is re-vendored with different floors, our pre-flight would start
// passing builds the runtime then rejects (or vice versa). Read them back out.
const vendor = readFileSync(new URL('../extension/js/vendor/web-llm.js', import.meta.url), 'utf8');
const vendored = (name) => {
  const m = new RegExp(`${name}\\s*=\\s*([0-9]+(?:\\s*<<\\s*[0-9]+)?)`).exec(vendor);
  assert.ok(m, `could not read ${name} out of the vendored web-llm runtime — did its shape change?`);
  const [a, b] = m[1].split('<<').map((x) => Number(x.trim()));
  return b === undefined ? a : a << b;
};
assert.equal(WEBLLM_REQUIRED_LIMITS.maxStorageBuffersPerShaderStage, vendored('requiredMaxStorageBuffersPerShaderStage'),
  'WEBLLM_REQUIRED_LIMITS drifted from the vendored runtime’s own floor');
assert.equal(WEBLLM_REQUIRED_LIMITS.maxComputeWorkgroupStorageSize, vendored('requiredMaxComputeWorkgroupStorageSize'),
  'WEBLLM_REQUIRED_LIMITS drifted from the vendored runtime’s own floor');

// ── representative adapters ───────────────────────────────────────────────
const CHROME = { maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32768, maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483648, maxTextureDimension2D: 16384, maxComputeInvocationsPerWorkgroup: 1024 };
// Firefox reporting its REAL numbers: a capable GPU, but the spec-default 8 storage
// buffers per shader stage that Firefox does not raise.
const FIREFOX = { ...CHROME, maxStorageBuffersPerShaderStage: 8 };
// Firefox with privacy.resistFingerprinting: EVERY limit clamped to the spec default.
const FIREFOX_RFP = { maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupStorageSize: 16384, maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxTextureDimension2D: 8192, maxComputeInvocationsPerWorkgroup: 256 };

assert.deepEqual(shortfall(CHROME), [], 'a normal Chromium adapter must pass');
assert.equal(looksClamped(CHROME), false);

const ffGaps = shortfall(FIREFOX);
assert.equal(ffGaps.length, 1, 'Firefox fails on exactly one limit');
assert.equal(ffGaps[0].limit, 'maxStorageBuffersPerShaderStage');
assert.deepEqual({ have: ffGaps[0].have, need: ffGaps[0].need }, { have: 8, need: 10 });
// A capable GPU reporting one low limit is NOT the fingerprinting clamp — telling that
// user to change a privacy setting would send them on a wild goose chase.
assert.equal(looksClamped(FIREFOX), false, 'one low limit must not be mistaken for the RFP clamp');

assert.ok(shortfall(FIREFOX_RFP).length >= 2);
assert.equal(looksClamped(FIREFOX_RFP), true, 'every limit at the spec default is the clamp signature');

// ── the message has to be worth reading ───────────────────────────────────
const plain = explain(ffGaps, { clamped: false, gecko: true });
assert.match(plain, /storage buffers per shader stage/);
assert.match(plain, /\b8\b/); assert.match(plain, /\b10\b/);
assert.match(plain, /Ollama|API endpoint/, 'must point at something that DOES work');
assert.doesNotMatch(plain, /resistFingerprinting/, 'do not blame a privacy setting that is not the cause');

const clampedMsg = explain(shortfall(FIREFOX_RFP), { clamped: true, gecko: true });
assert.match(clampedMsg, /resistFingerprinting/, 'when it IS the clamp, name the setting');
assert.match(clampedMsg, /Ollama|API endpoint/);

assert.equal(explain([], {}), '', 'no gaps, no message');

// ── the probe: every failure is a verdict, never a throw ──────────────────
const realNavigator = globalThis.navigator;
const setNavigator = (value) => {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
};

setNavigator({ userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/128.0', gpu: undefined });
resetWebgpuSupport();
let v = await webgpuSupport();
assert.equal(v.ok, false); assert.equal(v.code, 'WEBGPU_UNAVAILABLE');
assert.match(v.message, /Settings/);

setNavigator({ userAgent: 'Gecko/20100101', gpu: { requestAdapter: async () => null } });
resetWebgpuSupport();
v = await webgpuSupport();
assert.equal(v.code, 'WEBGPU_NO_ADAPTER');

// An adapter that throws is still just "no GPU here", not an exception for callers.
setNavigator({ userAgent: 'Gecko/20100101', gpu: { requestAdapter: async () => { throw new Error('boom'); } } });
resetWebgpuSupport();
assert.equal((await webgpuSupport()).code, 'WEBGPU_NO_ADAPTER');

setNavigator({ userAgent: 'Gecko/20100101', gpu: { requestAdapter: async () => ({ limits: FIREFOX }) } });
resetWebgpuSupport();
v = await webgpuSupport();
assert.equal(v.ok, false);
assert.equal(v.code, 'WEBGPU_LIMITS_TOO_LOW');
assert.equal(v.clamped, false);
assert.equal(cachedWebgpuSupport(), v, 'the verdict must be readable synchronously afterwards');

setNavigator({ userAgent: 'Gecko/20100101', gpu: { requestAdapter: async () => ({ limits: FIREFOX_RFP }) } });
resetWebgpuSupport();
assert.equal((await webgpuSupport()).code, 'WEBGPU_LIMITS_CLAMPED');

// Chromium passes, and the probe runs once however many callers ask.
let adapterRequests = 0;
setNavigator({ userAgent: 'Chrome/140', gpu: { requestAdapter: async () => { adapterRequests++; return { limits: CHROME }; } } });
resetWebgpuSupport();
const [a, b] = await Promise.all([webgpuSupport(), webgpuSupport()]);
assert.equal(a.ok, true); assert.equal(b.ok, true);
assert.equal(adapterRequests, 1, 'concurrent callers must share one adapter request');
assert.equal(await webgpuSupport(), a, 'and later callers get the memoized verdict');

assert.equal(cachedWebgpuSupport(), a);
resetWebgpuSupport();
assert.equal(cachedWebgpuSupport(), null, 'unprobed means "don’t know", not "unsupported"');

setNavigator(realNavigator);
console.log('✓ webgpu support: limits checked (not just navigator.gpu), clamp told apart from a real cap, probed once');
