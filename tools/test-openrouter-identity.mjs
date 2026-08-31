// OpenRouter gates some models to apps it recognises, identified by HTTP-Referer / X-Title.
// That identity must follow the DESTINATION, not the preset dropdown — choosing
// "Custom / self-hosted" and typing the OpenRouter URL used to send nothing at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/js/providers.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('function openRouterIdentityHeaders'));
const body = fn.slice(0, fn.indexOf('\n}\n'));

assert.match(body, /isOpenRouterEndpoint\(agent, base\)/, 'keyed on the endpoint host, not the preset');
assert.match(body, /HTTP-Referer/, 'sends the referer OpenRouter attributes by');
assert.match(body, /X-Title/, 'and the app title');
assert.match(body, /has\('HTTP-Referer'\)/, "a user's own header is never overwritten");

// It is applied on the chat path AND the models-list path, so "Load models" and a real turn
// present the same identity.
const applied = src.match(/Object\.assign\(headers, openRouterIdentityHeaders\(agent, base\)\)/g) || [];
assert.ok(applied.length >= 2, `identity applied on every OpenRouter request path (found ${applied.length})`);

// The preset keeps working too — it is now a convenience, not the only source of identity.
const presets = readFileSync(new URL('../extension/js/provider-presets.js', import.meta.url), 'utf8');
assert.match(presets, /'HTTP-Referer': 'https:\/\/chatpanel\.net'/, 'the OpenRouter preset still declares it');

console.log('ok — OpenRouter identity follows the endpoint host, on every request path');
