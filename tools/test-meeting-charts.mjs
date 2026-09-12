// The meeting charts: the band across the top of a meeting and the talk-time donut.
//
// These build HTML strings, so the assertions are about what reaches the DOM — that a
// participant-chosen display name cannot carry markup into it, that an avatar URL never
// gets printed as a label, that colour comes from the slot variables rather than a hash,
// and that a meeting with no clock says so instead of drawing invented minutes.

import assert from 'node:assert/strict';

import { speakerBandHtml, talkTimeChartHtml, speakerColors } from '../extension/js/meeting-charts.js';
import { SPEAKER_SLOTS } from '../extension/js/events/meeting-shape.js';

const T0 = Date.UTC(2026, 8, 11, 14, 0, 0);
const at = (sec) => T0 + sec * 1000;

const meeting = {
  segments: [
    { t: at(0), speaker: 'Alex Rivera', text: 'Opening the migration review.' },
    { t: at(20), speaker: 'Alex Rivera', text: 'We are a week behind on the cutover.' },
    { t: at(45), speaker: 'Jordan Blake', text: 'Understood.' },
    { t: at(60), speaker: 'Alex Rivera', text: 'So we cut scope, not the date.' },
    { t: at(95), speaker: 'Jordan Blake', text: 'Agreed. I will write it up tonight.' },
  ],
};

let pass = 0;
const test = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

test('the band paints one bar per bucket, from the slot variables', () => {
  const html = speakerBandHtml(meeting, { buckets: 12 });
  assert.equal((html.match(/class="spk-bar/g) || []).length, 12);
  assert.ok(html.includes('var(--spk-1)'), 'the top talker wears slot 1');
  assert.ok(html.includes('var(--spk-2)'));
  assert.ok(!/#[0-9a-f]{6}/i.test(html), 'colours come from the themed variables, never baked into the markup');
});

test('a meeting with one voice gets no band — there is no shape to show', () => {
  assert.equal(speakerBandHtml({ segments: [{ t: at(0), speaker: 'Alex Rivera', text: 'A monologue.' }] }), '');
  assert.equal(speakerBandHtml({ segments: [] }), '');
  assert.equal(speakerBandHtml({}), '');
});

test('a quiet stretch draws as a baseline stub, not as a missing bar', () => {
  const sparse = {
    segments: [
      { t: at(0), speaker: 'Alex Rivera', text: 'Kicking off.' },
      { t: at(900), speaker: 'Jordan Blake', text: 'Sorry, back.' },
    ],
  };
  const html = speakerBandHtml(sparse, { buckets: 10 });
  assert.ok(html.includes('spk-bar quiet'));
  assert.ok(html.includes('nobody speaking'));
});

test('the band carries an axis and a legend, so identity is never colour alone', () => {
  const html = speakerBandHtml(meeting, { buckets: 8 });
  assert.ok(html.includes('spk-legend'));
  assert.ok(html.includes('Alex Rivera') && html.includes('Jordan Blake'));
  assert.ok(html.includes('elapsed'), 'a clocked meeting shows its real span');
  assert.ok(/role="img"[\s\S]*?aria-label="[^"]*Alex Rivera/.test(html), 'the band names its speakers to a screen reader');
});

test('a clockless meeting labels its axis by position instead of inventing times', () => {
  const flat = {
    segments: [
      { speaker: 'Alex Rivera', text: 'No timestamps here.' },
      { speaker: 'Jordan Blake', text: 'None at all.' },
    ],
  };
  const html = speakerBandHtml(flat, { buckets: 6 });
  assert.ok(html.includes('no per-line timestamps'));
  assert.ok(!html.includes('elapsed'));
});

test('the donut states real minutes, and says who held the floor longest', () => {
  const html = talkTimeChartHtml(meeting);
  assert.ok(html.includes('spk-donut'));
  assert.equal((html.match(/class="spk-slice"/g) || []).length, 2);
  assert.ok(/talk time/.test(html));
  assert.ok(html.includes('Alex Rivera held the floor longest.'));
  assert.ok(/\d+ min|\d+s/.test(html), 'the legend carries durations, not only percentages');
});

test('without a clock the donut shows share and refuses to print minutes', () => {
  const html = talkTimeChartHtml({
    segments: [
      { speaker: 'Alex Rivera', text: 'x'.repeat(300) },
      { speaker: 'Jordan Blake', text: 'y'.repeat(100) },
    ],
  });
  assert.ok(html.includes('no per-line timestamps'));
  assert.ok(html.includes('75%') && html.includes('25%'));
  assert.ok(!/\d+ min/.test(html), 'minutes that were never measured are never shown');
});

test('the slices close the circle — no rounding leaves a wedge of surface', () => {
  const html = talkTimeChartHtml(meeting);
  const dashes = [...html.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)];
  const C = 2 * Math.PI * 54;
  const drawn = dashes.reduce((n, m) => n + Number(m[1]), 0);
  assert.ok(Math.abs(drawn - C) < 8, `slices cover the ring (drew ${drawn.toFixed(1)} of ${C.toFixed(1)})`);
});

test('past five speakers the tail folds into one grey, rather than a sixth hue', () => {
  const crowded = {
    segments: Array.from({ length: 9 }, (_, i) => (
      { t: at(i * 30), speaker: `Person ${i}`, text: 'x'.repeat(60 - i) }
    )),
  };
  const html = talkTimeChartHtml(crowded);
  assert.equal((html.match(/class="spk-slice"/g) || []).length, SPEAKER_SLOTS + 1);
  assert.ok(html.includes('var(--spk-other)'));
  assert.ok(html.includes(`${9 - SPEAKER_SLOTS} others`));
  const one = talkTimeChartHtml({
    segments: Array.from({ length: SPEAKER_SLOTS + 1 }, (_, i) => (
      { t: at(i * 30), speaker: `Person ${i}`, text: 'x'.repeat(60 - i) }
    )),
  });
  assert.ok(one.includes('1 other<') , 'one folded speaker is "1 other", not "1 others"');
  assert.ok(!html.includes('var(--spk-6)'));
});

test('a display name cannot carry markup into the page', () => {
  const hostile = {
    segments: [
      { t: at(0), speaker: '<img src=x onerror=alert(1)>', text: 'One.' },
      { t: at(30), speaker: 'Jordan "Ops" Blake', text: 'Two.' },
    ],
  };
  for (const html of [speakerBandHtml(hostile, { buckets: 4 }), talkTimeChartHtml(hostile)]) {
    assert.ok(!html.includes('<img src=x'), 'the tag is escaped, not rendered');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!/title="[^"]*Jordan "Ops"/.test(html), 'a quote in a name cannot break out of an attribute');
  }
});

test('an avatar URL is an identity, not a label — it never reaches the legend as a link', () => {
  const avatars = {
    segments: [
      { t: at(0), speaker: 'https://images.zoom.us/p/v2/abc/avatar.png', text: 'One.' },
      { t: at(30), speaker: 'https://images.zoom.us/p/v2/def/avatar.png', text: 'Two.' },
      { t: at(60), speaker: 'Alex Rivera', text: 'Three.' },
    ],
  };
  const html = talkTimeChartHtml(avatars);
  assert.ok(!html.includes('images.zoom.us'), 'no participant-supplied URL is printed');
  assert.ok(html.includes('Participant 1') && html.includes('Participant 2'), 'distinct people stay distinct rows');
});

test('one unnamed participant is not numbered — there is nothing to tell apart', () => {
  const html = talkTimeChartHtml({
    segments: [
      { t: at(0), speaker: 'https://images.zoom.us/p/v2/abc/avatar.png', text: 'One.' },
      { t: at(30), speaker: 'Alex Rivera', text: 'Two.' },
    ],
  });
  assert.ok(html.includes('>Participant<'));
  assert.ok(!html.includes('Participant 1'));
});

test('the transcript wears the same colour as the band — one slot per person', () => {
  const { colorOf } = speakerColors(meeting);
  assert.equal(colorOf('Alex Rivera'), 'var(--spk-1)');
  assert.equal(colorOf('Jordan Blake'), 'var(--spk-2)');
  assert.equal(colorOf('  Alex Rivera  '), 'var(--spk-1)', 'stray whitespace is not a second person');
  assert.equal(colorOf('Nobody'), 'var(--spk-other)');
  assert.equal(colorOf(null), 'var(--spk-other)');
});

console.log(`\n✓ meeting charts: ${pass} checks passed`);
