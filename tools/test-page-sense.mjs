// Deterministic sensing + the eval_js gates.
//
// Two things are load-bearing here. First, sensing must never hand back a
// credential: page JavaScript is where apps keep tokens, so every value that
// leaves the page is filtered. Second, eval_js must be unreachable unless it was
// explicitly enabled — checked independently of whether its spec was offered.
import assert from 'node:assert/strict';

let injected = null;    // { func, args, world } of the last executeScript
let injectResult = { ok: true };

globalThis.chrome = {
  scripting: {
    async executeScript({ func, args, world }) {
      injected = { func, args, world };
      return [{ result: injectResult }];
    },
  },
  debugger: { async attach() {}, async detach() {}, async sendCommand() {}, onDetach: { addListener() {} } },
  tabs: { async get() { return { windowId: 1 }; } },
  runtime: {},
};

const { readAppState, probeAppState, senseCanvas, REDACTED } = await import('../extension/js/page-sense.js');

// The injected readers are pure functions of the page, so run them against a fake
// document/window rather than asserting on how they are shipped.
function runInjected(fakeGlobals) {
  const { func, args } = injected;
  const saved = {};
  for (const [k, v] of Object.entries(fakeGlobals)) {
    saved[k] = globalThis[k];
    globalThis[k] = v;
  }
  try {
    return func(...(args || []));
  } finally {
    for (const [k] of Object.entries(fakeGlobals)) globalThis[k] = saved[k];
  }
}

// 1) read_app_state refuses an empty request rather than dumping anything.
{
  const r = await readAppState(1, { paths: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /at least one path/);
}

// 2) It reads page JS from the MAIN world — the isolated world cannot see it.
{
  await readAppState(1, { paths: ['game.score'] });
  assert.equal(injected.world, 'MAIN', 'app state must be read in the MAIN world');
}

// 3) THE SECURITY PROPERTY: secret-looking keys never yield their value, at any
//    depth, while ordinary state comes through intact.
{
  await readAppState(1, { paths: ['app'] });
  const out = runInjected({
    window: {
      app: {
        score: 42,
        user: { name: 'Alex Rivera', authToken: 'tok_live_abc', sessionId: 'sid_1' },
        apiKey: 'sk-should-never-appear',
        board: [1, 2, 3],
      },
    },
  });
  const app = out.state.app;
  assert.equal(app.score, 42, 'ordinary values survive');
  assert.deepEqual(app.board, [1, 2, 3]);
  assert.equal(app.user.name, 'Alex Rivera');
  assert.equal(app.apiKey, REDACTED, 'apiKey withheld');
  assert.equal(app.user.authToken, REDACTED, 'nested authToken withheld');
  assert.equal(app.user.sessionId, REDACTED, 'sessionId withheld');
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes('sk-should-never-appear'), 'secret value absent from the whole payload');
  assert.ok(!dumped.includes('tok_live_abc'), 'token value absent from the whole payload');
}

// 4) A missing path reports itself rather than throwing or inventing a value.
{
  await readAppState(1, { paths: ['nope.not.here'] });
  const out = runInjected({ window: {} });
  assert.equal(out.state['nope.not.here'], '[not found]');
}

// 5) probe_app_state returns SHAPES ONLY — it must never carry a value, since it
//    runs before anyone has decided what is safe to read.
{
  await probeAppState(1);
  const fakeWindow = { game: { score: 99, secretToken: 'nope' } };
  Object.setPrototypeOf(fakeWindow, {});
  const out = runInjected({ window: fakeWindow, Element: class {} });
  const game = out.globals.find((g) => g.name === 'game');
  assert.ok(game, 'found the game object');
  assert.deepEqual(game.keys, ['score', 'secretToken'], 'key NAMES are useful');
  assert.ok(!JSON.stringify(out).includes('99'), 'no values, not even harmless ones');
  assert.ok(!JSON.stringify(out).includes('nope'));
}

// 6) sense_canvas reports a real error on a WebGL canvas instead of pretending —
//    getImageData does not work there, and silently returning junk would be worse.
{
  await senseCanvas(1, { cols: 4, rows: 4 });
  const out = runInjected({
    document: { querySelectorAll: () => [{ getContext: () => null, getBoundingClientRect: () => ({ width: 100, height: 100 }) }] },
  });
  assert.equal(out.ok, false);
  assert.equal(out.webgl, true);
  assert.match(out.error, /not 2D/);
}

// 7) sense_canvas turns pixels into a grid + legend. A 2x2 board of two colours
//    must come back as two symbols, not an approximation.
{
  await senseCanvas(1, { cols: 2, rows: 2 });
  // 2x2 canvas: top row red/red, bottom row blue/blue.
  const px = [
    255, 0, 0, 255, 255, 0, 0, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ];
  const canvas = {
    width: 2, height: 2,
    getContext: () => ({ getImageData: () => ({ data: px }) }),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 200 }),
  };
  const out = runInjected({ document: { querySelectorAll: () => [canvas] } });
  assert.equal(out.ok, true);
  assert.equal(out.grid.length, 2);
  assert.equal(out.grid[0][0], out.grid[0][1], 'top row is one colour');
  assert.notEqual(out.grid[0][0], out.grid[1][0], 'rows differ');
  assert.equal(out.legend.length, 2, 'exactly two colours');
  assert.deepEqual(out.canvas.viewport, { x: 10, y: 20, w: 200, h: 200 }, 'rect lets a cell map back to a click');
}

// --- eval_js gating -------------------------------------------------------
const { makePageToolExecutor } = await import('../extension/js/page-tools.js');

// 8) THE GATE: with the developer setting off, eval_js is refused even when
//    called directly — the withheld spec is not the only thing standing in the way.
{
  const exec = makePageToolExecutor(1, { cdp: true, devJs: false });
  const r = JSON.parse(await exec('eval_js', { code: '1+1' }));
  assert.match(r.error, /developer-only feature and is turned OFF/);
}

// 9) Enabled but without trusted events → refused too, rather than half-working.
{
  const exec = makePageToolExecutor(1, { cdp: false, devJs: true });
  const r = JSON.parse(await exec('eval_js', { code: '1+1' }));
  assert.match(r.error, /High-reliability/);
}

console.log('page-sense tests passed');
