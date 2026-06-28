import assert from 'node:assert/strict';

import { createVault } from '../extension/js/pii-redact.js';
import {
  redactionEnabled, effectiveTier, redactOutbound, redactToolResult, makeStreamRestorer, restore,
  redactionFromSettings, setPiiEntitlement, redactOnce,
} from '../extension/js/pii-pipeline.js';

// --- enable + Pro gating of the entity tier ---
assert.equal(redactionEnabled({ mode: 'off' }), false);
assert.equal(redactionEnabled({ mode: 'deterministic' }), true);
assert.equal(effectiveTier({ tier: 'full' }, true), 'full');
assert.equal(effectiveTier({ tier: 'full' }, false), 'basic', 'entity tier falls back to basic for Free');
assert.equal(effectiveTier({ tier: 'basic' }, true), 'basic');

const baseCfg = { mode: 'deterministic', tier: 'full', scope: { chat: true, context: true, history: true, toolResults: true }, dictionary: [] };
const entities = [{ value: 'Alex Rivera', type: 'PERSON' }];

// --- outbound: content + attachments + system redacted into one shared vault ---
{
  const vault = createVault();
  const messages = [{
    role: 'user',
    content: 'email alex@example.com',
    attachments: [
      { kind: 'page', text: 'notes from Alex Rivera' },
      { kind: 'history-rag', text: 'meeting with Alex Rivera' },
      { kind: 'image', dataUrl: 'data:...' },
    ],
  }];
  const out = redactOutbound({ messages, system: 'You assist Alex Rivera.', vault, cfg: baseCfg, isPro: true, entities });
  assert.equal(out.messages[0].content, 'email [[EMAIL_1]]');
  assert.equal(out.messages[0].attachments[0].text, 'notes from [[PERSON_1]]');
  assert.equal(out.messages[0].attachments[1].text, 'meeting with [[PERSON_1]]', 'same entity -> same token across blocks');
  assert.equal(out.messages[0].attachments[2].kind, 'image', 'image attachments pass through untouched');
  assert.equal(out.system, 'You assist [[PERSON_1]].');
  // originals must be untouched (local history keeps real values)
  assert.equal(messages[0].content, 'email alex@example.com');
  assert.equal(messages[0].attachments[0].text, 'notes from Alex Rivera');
}

// --- scope flags suppress redaction of specific blocks ---
{
  const vault = createVault();
  const messages = [{ role: 'user', content: 'hi', attachments: [
    { kind: 'page', text: 'from Alex Rivera' },
    { kind: 'history-rag', text: 'from Alex Rivera' },
  ] }];
  const cfg = { ...baseCfg, scope: { chat: true, context: false, history: false, toolResults: true } };
  const out = redactOutbound({ messages, vault, cfg, isPro: true, entities });
  assert.equal(out.messages[0].attachments[0].text, 'from Alex Rivera', 'context scope off -> page not redacted');
  assert.equal(out.messages[0].attachments[1].text, 'from Alex Rivera', 'history scope off -> history not redacted');
}

// --- Free tier: names NOT redacted (basic), but emails still are ---
{
  const vault = createVault();
  const messages = [{ role: 'user', content: 'Alex Rivera at alex@example.com' }];
  const out = redactOutbound({ messages, vault, cfg: baseCfg, isPro: false, entities });
  assert.match(out.messages[0].content, /Alex Rivera at \[\[EMAIL_1\]\]/);
}

// --- disabled -> passthrough (no copies, no vault writes) ---
{
  const vault = createVault();
  const messages = [{ role: 'user', content: 'Alex Rivera alex@example.com' }];
  const out = redactOutbound({ messages, vault, cfg: { mode: 'off' }, isPro: true, entities });
  assert.equal(out.messages[0].content, 'Alex Rivera alex@example.com');
}

// --- tool results redacted before返回 to the model; restorable ---
{
  const vault = createVault();
  const red = redactToolResult('Alex Rivera emailed alex@example.com', { vault, cfg: baseCfg, isPro: true, entities });
  assert.equal(red, '[[PERSON_1]] emailed [[EMAIL_1]]');
  assert.equal(restore(red, vault), 'Alex Rivera emailed alex@example.com');
  const off = redactToolResult('Alex Rivera', { vault, cfg: { ...baseCfg, scope: { toolResults: false } }, isPro: true, entities });
  assert.equal(off, 'Alex Rivera', 'toolResults scope off -> not redacted');
}

// --- streaming restore reassembles a token split across chunks ---
{
  const vault = createVault();
  // seed the vault so [[PERSON_1]] -> Alex
  redactOutbound({ messages: [{ role: 'user', content: 'Alex' }], vault, cfg: baseCfg, isPro: true, entities: [{ value: 'Alex', type: 'PERSON' }] });
  const r = makeStreamRestorer(vault);
  let shown = '';
  shown += r.push('Hi [[PER');
  shown += r.push('SON_1]] there');
  shown += r.flush();
  assert.equal(shown, 'Hi Alex there', 'placeholder split across chunks still restores');
}

// --- Free gating: chat-only scope, dictionary cap (3), basic tier — even if cfg asks for more ---
{
  const cfg = {
    mode: 'deterministic', tier: 'full',
    scope: { chat: true, context: true, history: true, toolResults: true },
    dictionary: [{ value: 'Acme' }, { value: 'Globex' }, { value: 'Initech' }, { value: 'Umbrella' }],
  };
  const ents = [{ value: 'Alex Rivera', type: 'PERSON' }];
  const messages = () => [{
    role: 'user',
    content: 'Acme Globex Initech Umbrella; Alex Rivera at alex@example.com',
    attachments: [{ kind: 'page', text: 'Acme secret' }],
  }];

  const free = redactOutbound({ messages: messages(), vault: createVault(), cfg, isPro: false, entities: ents });
  assert.match(free.messages[0].content, /\[\[EMAIL_1\]\]/, 'free still redacts secrets');
  assert.match(free.messages[0].content, /Alex Rivera/, 'free does NOT redact names (basic tier)');
  assert.match(free.messages[0].content, /\bUmbrella\b/, 'free caps the dictionary at 3 entries');
  assert.doesNotMatch(free.messages[0].content, /\bAcme\b/, 'first dictionary entries still apply on free');
  assert.equal(free.messages[0].attachments[0].text, 'Acme secret', 'free is chat-only: context not redacted');
  assert.equal(redactToolResult('Acme alex@example.com', { vault: createVault(), cfg, isPro: false }),
    'Acme alex@example.com', 'tool-result redaction is Pro-only');

  const pro = redactOutbound({ messages: messages(), vault: createVault(), cfg, isPro: true, entities: ents });
  assert.doesNotMatch(pro.messages[0].content, /Alex Rivera/, 'Pro redacts names');
  assert.doesNotMatch(pro.messages[0].content, /\bUmbrella\b/, 'Pro: unlimited dictionary');
  assert.doesNotMatch(pro.messages[0].attachments[0].text, /Acme secret/, 'Pro redacts context scope');
}

// --- default redaction path: covers auxiliary callers (topic extraction, scribe…) ---
{
  assert.equal(redactionFromSettings({ ui: { piiRedaction: { mode: 'off' } } }), null);
  assert.equal(redactionFromSettings({}), null);
  const r = redactionFromSettings({ ui: { piiRedaction: { mode: 'deterministic', tier: 'basic' } } });
  assert.ok(r && r.vault && r.cfg.mode === 'deterministic', 'enabled settings -> default redaction context');
  // the topic-extraction leak: a phone in arbitrary content is redacted by the default path
  const out = redactOutbound({ messages: [{ role: 'user', content: 'call 832-394-2334' }], vault: r.vault, cfg: r.cfg, isPro: r.isPro });
  assert.match(out.messages[0].content, /\[\[PHONE_1\]\]/);
  // entitlement controls the tier ceiling on the default path
  setPiiEntitlement(true);
  assert.equal(redactionFromSettings({ ui: { piiRedaction: { mode: 'deterministic', tier: 'full' } } }).isPro, true);
  setPiiEntitlement(false);
  assert.equal(redactionFromSettings({ ui: { piiRedaction: { mode: 'deterministic', tier: 'full' } } }).isPro, false);
}

// --- redactOnce: single-string path (raw-fetch bridge autocomplete) ---
{
  setPiiEntitlement(false);
  const { text, vault } = redactOnce('call me at 832-394-2334', { ui: { piiRedaction: { mode: 'deterministic', tier: 'basic' } } });
  assert.match(text, /\[\[PHONE_1\]\]/, 'redactOnce redacts a phone in a bare string');
  assert.equal(restore(text, vault), 'call me at 832-394-2334', 'redactOnce output restores');
  assert.deepEqual(redactOnce('x', { ui: { piiRedaction: { mode: 'off' } } }), { text: 'x', vault: null }, 'disabled -> passthrough');
}

console.log('pii pipeline tests passed');
