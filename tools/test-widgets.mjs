// A widget is code a model wrote because a user asked. It is useful, and it is untrusted —
// both at once. Every assertion here is about keeping those two facts compatible.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWidget, validateWidgetMessage, effectiveGrants } from '../extension/js/events/widget.js';

const host = readFileSync(new URL('../extension/js/widget-host.js', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../extension/js/sandbox-runner.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../extension/js/widgets-store.js', import.meta.url), 'utf8');
const artifacts = readFileSync(new URL('../extension/js/artifacts.js', import.meta.url), 'utf8');

// IDENTITY COMES FROM THE HOST. A widget naming another widget's id must read its own state.
assert.match(host, /widgetId: manifest\.id/, 'the host supplies the id it mounted');
assert.ok(!/call\.widgetId|msg\.widgetId/.test(host), 'never taken from the message');
{
  const spoofed = validateWidgetMessage(
    { op: 'state.get', callId: 'c1', widgetId: 'someone-else' },
    { widgetId: 'my-timer' },
  );
  assert.equal(spoofed.widgetId, 'my-timer');
}

// A KEPT WIDGET GETS NO POWERS. Saving must not grant anything.
assert.match(artifacts, /saveWidget\(\{ id, name: name\.trim\(\), html, surface: 'panel' \}\)/, 'kept with no requests');
assert.throws(
  () => validateWidgetMessage({ op: 'invoke', callId: 'c', capability: 'history_search' }, { widgetId: 'w', grants: [] }),
  /no grant/,
  'a kept widget cannot call capabilities',
);
// And it cannot grant itself any by re-saving with new requests.
assert.deepEqual(effectiveGrants({ id: 'w', name: 'W', html: '<i>', requests: ['history_search'] }, []), []);

// THE SANDBOX STAYS THE SANDBOX. No re-sandboxing (that re-opaques the origin and breaks the
// runner), and the frame is the manifest sandbox page.
assert.match(host, /frame\.src = sandboxUrl/, 'mounted in the manifest sandbox page');
assert.match(host, /if \(!sandboxUrl\) return null/, 'and refuses to render where there is no sandbox (Firefox)');
assert.ok(!/frame\.sandbox\s*=/.test(host), 'never re-sandboxed');

// THE WRAPPER ONLY RELAYS — it must add no authority of its own.
assert.match(runner, /type: 'chatpanel:widget-call'/, 'relays calls up');
assert.match(runner, /__cpWidgetResult/, 'and results down');
assert.ok(!/grants|state\.get.*storage/s.test(runner.slice(runner.indexOf('__cpWidgetCall'), runner.indexOf('__cpWidgetCall') + 400)),
  'the wrapper makes no policy decision');

// DELETING A WIDGET DELETES ITS STATE — orphaned state would be a quiet leak.
assert.match(store, /delete states\[id\]/, 'state is removed with the widget');

// The manifest is validated before a user is asked to keep anything.
assert.throws(() => validateWidget({ id: 'Bad Id', name: 'x', html: '<i>' }), /lowercase/);
assert.ok(validateWidget({ id: 'pomodoro', name: 'Pomodoro', html: '<div>25:00</div>' }));

// PINNED WIDGETS ARE DISTINGUISHABLE AND UNCAPPED.
{
  const { widgetIcon } = await import('../extension/js/events/widget.js');
  const panel = readFileSync(new URL('../extension/js/widgets-panel.js', import.meta.url), 'utf8');
  const side = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

  // Each pinned widget shows its OWN icon, by name, resolved through the extension's set.
  assert.match(side, /iconName: widgetIcon\(rec\.manifest\)/, 'the rail asks for the widget\'s own icon');
  assert.match(side, /p\.iconName \? icon\(p\.iconName\)/, 'and renders it from the vendored set');
  const icons = ['Pomodoro Timer', 'Standup Notes', 'Habit Tracker'].map((name) => widgetIcon({ name }));
  assert.equal(new Set(icons).size, icons.length, 'three different widgets get three different icons');

  // Every derived name must EXIST in the icon set, or the rail renders an empty square.
  const iconsSrc = readFileSync(new URL('../extension/js/icons.js', import.meta.url), 'utf8');
  for (const name of [...icons, widgetIcon({ name: 'Zxq' })]) {
    assert.ok(new RegExp(`"${name}":`).test(iconsSrc), `icon "${name}" is vendored`);
  }

  // No cap — the rail scrolls instead.
  assert.ok(!/MAX_PINNED/.test(panel), 'pinning is not capped');
  assert.match(css, /overflow-y: auto; overflow-x: hidden/, 'the rail scrolls rather than clipping');
}

console.log('ok — widgets are persistent, sandboxed, powerless until granted, and each pins with its own icon');
