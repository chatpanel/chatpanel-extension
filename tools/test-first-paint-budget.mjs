// First paint, as a number that fails the build rather than a principle people remember.
//
// The rule already exists — "absolute-lowest initial load is a HARD requirement", action-only
// modules get `await import()` at the call site — and nothing checked it. So a static import
// added for a good reason (a service worker CANNOT dynamic-import, so anything it must run has
// to be static) grew the worker from 221 KB to 488 KB, and the first anyone knew was a user
// saying loading "takes forever".
//
// What this measures: the STATIC module graph reachable from each entry point — `import … from`
// only, never `import()`, because a dynamic import is exactly the thing that keeps weight OFF
// this number. Bytes of source, which is what the engine must fetch, parse and instantiate
// before the entry point runs.
//
// A budget going UP needs a reason in the commit message. A budget going DOWN should be
// tightened here in the same change, so the ratchet only turns one way.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'extension');

// KB. Ceilings, not targets — every one of these is above what the tree costs today.
const BUDGET = {
  // Every one of these is a CEILING a few KB above what the tree costs today, so the next
  // addition has to be argued for rather than absorbed. A budget going UP needs a reason in
  // the commit message; a budget going DOWN is tightened here in the same change.
  //
  // 809 → 768. Two things left the panel's first paint in one pass:
  //   • `checkBridge` moved to js/bridge-health.js, so init() no longer dynamically imports
  //     the 382 KB model layer to read one localhost JSON (see NOT_ON_BOOT below);
  //   • meetings, notes, the Notes config and the OAuth sign-ins moved out of store.js and
  //     behind js/backup-payload.js — 42.6 KB of stores that only a backup calls, on the
  //     graph of every page that reads a setting.
  // 768 → 776 for js/monitor-profile.js (~6 KB, no imports). It decides what a monitor turn
  // assembles, so it has to be resolved before the first one runs — and it is a net REMOVAL
  // at run time: the lean default builds no toolset at all, where every monitor tick used to
  // assemble the full chat toolset (web search, history RAG, every MCP server) and put every
  // one of those schemas in the prompt.
  // 786 → 796 for video transcripts and PDF reading — 6.3 KB measured, for two features
  // whose implementations weigh 30 KB and 1.7 MB. What lands here is js/source-kind.js
  // (~1 KB) plus the branches and reasoning at the four call sites in js/context.js. The gate
  // is the one piece that CANNOT be deferred: it decides whether to load a layer, so it has
  // to be resolved first. Everything behind it — js/vendor/pdf.js, js/pdf-text.js,
  // js/youtube-transcript.js and their shared parsers — is `await import()`ed at the call
  // site and is pinned OFF every entry point in OFF_LIMITS below, which is what makes that
  // claim checkable rather than remembered.
  // 796 → 800 for the ECHO-FIRST send path: the user's message now goes into the conversation
  // before any context is read, so a video URL's two round-trips no longer look like a dead
  // Enter key. Comment weight, not code — the change is a reorder.
  // 800 → 806 so a sent `/command` reads as the command. A skill expands into the whole prompt
  // its author wrote, and the user's bubble was echoing all of it back — pushing the answer,
  // and the page the skill was asked to read, off the panel on every run. The message CONTENT
  // is unchanged; what lands here is the label helper in js/slash-commands.js (~1 KB, already
  // on this graph and on no other) plus the chip in renderMessage, which is first paint by
  // definition — restoring a conversation draws these bubbles. The previous ceiling had 0.6 KB
  // left under it, which fails on the next comment anyone writes; this one leaves ~3.7 KB.
  // 806 → 812 for voice out and voice conversation. The engines are all deferred and pinned
  // OFF this graph below — js/speech.js, js/read-aloud.js, js/voice-loop.js, js/voice-mode.js
  // are `await import()`ed from the Speak button and the voice button, and dictation.js
  // already was. What lands here is only what first paint genuinely needs: speakBtn(), which
  // renderMessage calls for every assistant bubble it draws, the ~20-line toggleVoiceMode
  // shim that does nothing but import the session, the turn-completion notifier runStream
  // fires, and one more Lucide glyph in icons.js. ~4 KB, most of it comment, and the engine
  // behind it stays off. Leaves ~5 KB of headroom.
  // 812 → 820. That "~5 KB" is now 0.1 KB — the voice work's shared client helpers
  // (js/gateway.js gained the TTS model and voice calls, reached from this graph)
  // ate it, and a ceiling with 0.1 KB left fails on the next comment anyone writes,
  // which is a bad way to learn about a budget. The engines themselves are still
  // pinned OFF this graph in OFF_LIMITS, so what grew is client plumbing, not the
  // deferral leaking.
  // 820 → 832. The derived layer put NOTHING on this graph — briefs reach a turn through
  // retrieval, so the panel never imports them. What landed is ~3.7 KB: the NER label map in
  // js/pii-detect.js (the ai4privacy vocabulary the active model actually speaks, without
  // which person names went to the model in plaintext) and the Briefs button plus its
  // composer handoff. The remaining ~8 KB of headroom is unrelated in-flight growth in
  // js/confirm-modal.js — RE-TIGHTEN THIS to ~824 when that work lands and can carry its own
  // budget decision, or the ratchet stops turning.
  // 832 → 836 for the redaction preview's four states. It is ~2 KB of branches and copy in a
  // panel that had one state and a bare `catch {}`, and every KB of it is a case where the
  // shield was lit and nothing was being redacted — a silent privacy indicator is worth more
  // than the bytes.
  // 836 → 840 for the render-boundary placeholder scrub. Redaction is for the model's
  // benefit, so a [[PERSON_5]] reaching the screen is always a bug — and not every path has
  // a vault to restore against (a local agent under "redact for remote only" has none),
  // which is why the guarantee has to sit at the one call every path ends at.
  'sidepanel.js': 840,
  // 1162 → 1161. Settings genuinely loads the model layer (Test, Load models, prompt-assist)
  // and its own OAuth screens, so it keeps most of what the panel shed. The remaining fat
  // here is providers.js (122 KB) and the toolset preview behind it — a real target, but one
  // that touches a dozen call sites and belongs in its own change rather than this one.
  //
  // 1163 → 1170 for the detector's two new capabilities, both reached through providers.js:
  //   • a structured-output seam in @chatpanel/pii, so an OpenAI-compatible detector is asked
  //     to ENFORCE the entity shape rather than merely told about it — the difference between
  //     a small local model that answers and one that writes a paragraph;
  //   • egress recording, because detection is the ONE call that sends RAW pre-redaction text
  //     off the device and it was logged nowhere (js/access-log.js).
  // Neither drags weight onto this graph: the 50 KB structured layer and access-log.js are
  // both `await import()`ed at their call sites, which test-structured-call.mjs and
  // test-access-log.mjs assert. The ~7 KB is the code and its reasoning, and shaving the
  // reasoning to fit a byte budget is the wrong trade. Headroom is deliberate — the previous
  // ceiling landed on 1166.0/1166, which fails on the next comment anyone writes.
  // 1170 → 1180: settings reaches js/context.js too, so it pays the same gate, branches and
  // reasoning the panel does — including parseVideoId and the note on why an unreadable video
  // raises instead of quietly degrading into a page capture. The layers themselves are pinned
  // off it in OFF_LIMITS.
  // 1180 → 1190 for the text-to-speech model manager, which sits beside the STT and speaker
  // managers already on this graph and is built the same way — a model list, a voice picker,
  // a precision picker and a Preview. It is page CONTENT, not a deferred capability: the
  // Models section refreshes its three managers together on load, and a fourth that lazy-
  // loaded would show an empty card until it arrived. Settings is also not the latency
  // surface — sidepanel.js is, and the voice engines are pinned off THAT graph below.
  // 1190 → 1198 for the TTS model SEARCH, which is also why 1190 was too tight to keep. The
  // engine drives TWO architectures (Kokoro and VITS/MMS) and Hugging Face returns others
  // under the same pipeline tag, so results are split into runnable and not-runnable with
  // the reason shown rather than quietly filtered — that split is the code, and why it has
  // to exist is the comment. Headroom is deliberate: the previous ceiling landed on
  // 1189.1/1190, which fails on the next sentence anyone writes here.
  // 1198 → 1208 for custom voices: the saved-voice list, the record/stop control and the
  // picker branch that offers YOUR voices instead of Kokoro's when the active model takes a
  // speaker embedding. The recorder itself — getUserMedia and an AudioContext — is in
  // js/voice-record.js and dynamic-imported, pinned off every graph in OFF_LIMITS, so what
  // lands here is the list and the wiring. Same deliberate headroom rule: 1196/1198 would
  // fail on the next comment.
  // 1208 → 1220 for the "Open ChatPanel" button in the header. The 8 KB is js/side-panel.js,
  // and it CANNOT be deferred: openSidePanel() counts as user-initiated only inside the
  // synchronous turn of the click, and a dynamic import() at the call site is itself an
  // await — Firefox's sidebarAction.open() rejects after one. That constraint is the module's
  // own documented reason for being statically imported by every caller, so paying it here is
  // the design working, not a regression. (Its header still says "~2 KB"; it is 8 KB of
  // mostly comments now.) Same deliberate headroom rule: 1216/1216 would fail on the next
  // sentence written in this file.
  // 1220 → 1250 for the derived layer. Measured share: 29.7 KB — js/brief-source.js,
  // js/store-briefs.js and the events model (entity.js + knowledge.js). Settings reaches it
  // the same way background.js does, through history-rag registering briefs as the fourth
  // source, and that registration is the whole point: one register call puts briefs in ⌘K,
  // the graph, the context assembler and warm sync without editing any of those. The
  // DERIVATION half — 60 KB more — is in js/briefs-build.js and is on neither graph.
  // 1255 → 1260 for the brief-source memo. Warm sync runs in the service worker ~30s after
  // ANY corpus write, and during a live meeting captions write constantly — loading briefs
  // the obvious way decrypted every brief BODY on each of those runs to send records that
  // had not changed. A fingerprint of the index makes the repeat runs free.
  'settings.js': 1260,
  // 914 → 415. The vendored CodeMirror bundle (495 KB) was reached through a STATIC import of
  // js/notes-regions.js — more than half this page's first paint, paid by every user who opens
  // Notes, including everyone who never turns Live mode on. Every function it provided was
  // already guarded by the CM editor being mounted, and mounting it dynamically imports
  // notes-regions anyway.
  // 415 → 418 for one predicate. store-notes.js now asks events/redaction-tokens.js whether
  // a [[…]] is a PII placeholder, because [[PERSON_1]] was becoming a backlink and a graph
  // node. That module exists at ~3 KB precisely so this page does not import entity.js
  // (alias resolution + a Levenshtein) to answer a one-line question.
  'notes.js': 418,
  // The worker is the one entry point that CANNOT defer anything: `import()` throws on
  // ServiceWorkerGlobalScope, so every module it may ever need is static. It therefore keeps
  // the backup stores the pages just shed — js/backup-payload.js imports them for it — and
  // this ceiling sits deliberately close to today's cost.
  // 525 → 560 for the derived layer, same 29.7 KB as settings above and for the same
  // reason. The worker earns it: a brief written while no window is open still has to reach
  // the gateway, or a CLI agent asking `search_history` gets a corpus with its synthesis
  // missing. What the worker does NOT get is derivation — deriving decrypts the whole
  // corpus and runs whole-corpus passes, so it lives in js/briefs-build.js, which only
  // pages import. That split is worth 90 KB: importing editDistance from voice-intents.js
  // (79 KB, plus structured.js at 41 KB) for forty lines of arithmetic was the first draft,
  // and events/distance.js exists because of it.
  'background.js': 560,
};

function staticGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = readFileSync(path.join(extDir, rel), 'utf8'); } catch { continue; }
    const from = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
    const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
    for (const re of [from, bare]) {
      let m;
      while ((m = re.exec(src))) {
        if (!m[1].startsWith('.')) continue;
        stack.push(path.relative(extDir, path.resolve(path.dirname(path.join(extDir, rel)), m[1]))
          .split(path.sep).join('/'));
      }
    }
  }
  return seen;
}
const kb = (files) => [...files].reduce((n, f) => {
  try { return n + statSync(path.join(extDir, f)).size; } catch { return n; }
}, 0) / 1024;

const report = [];
for (const [entry, budget] of Object.entries(BUDGET)) {
  const graph = staticGraph(entry);
  const size = kb(graph);
  report.push(`  ${entry.padEnd(15)} ${size.toFixed(1).padStart(7)} KB / ${String(budget).padStart(4)} KB  (${graph.size} modules)`);
  assert.ok(size <= budget,
    `${entry} first paint is ${size.toFixed(1)} KB, over its ${budget} KB budget.\n`
    + '  Anything used only on a user action or after the first turn belongs behind an\n'
    + '  `await import()` at its call site — not a static import at module top. If the weight\n'
    + '  is genuinely required to paint, raise the budget here and say why in the commit.');
}

// The heaviest thing a first paint can carry is a module nobody needs yet. These are the ones
// most recently argued about; each must stay OFF the graphs that do not use it.
const OFF_LIMITS = {
  // The model layer. A chat interface has to PAINT before it can run a turn, and running one
  // is an async user action that cannot tell the difference. Three modules used to pull this
  // statically (sidepanel, suggestions, assist) — deferring any two of them saved nothing,
  // which is why this is asserted rather than remembered.
  // Voice: every one of these is action-only (a Speak button, or the voice button).
  // Pinned off ALL entry points so a future static import fails here rather than
  // quietly costing every panel open ~460 KB of ONNX-adjacent plumbing.
  'js/speech.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/read-aloud.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/voice-loop.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/voice-mode.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/voice-record.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/voice-wave.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/voice-vad.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/providers.js': ['sidepanel.js'],
  'js/qr.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/bridge-update.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/channels.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/backup-payload.js': ['sidepanel.js', 'notes.js', 'settings.js'], // the worker needs it; no document does
  // The sub-tab bar renders after the panel does, and only one panel is ever on screen. It
  // must stay behind an import() at its call site rather than becoming settings' problem.
  'js/subtabs.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  // A widget is a sandboxed iframe and a store read. Neither belongs on any first paint —
  // the side panel mounts them from its drawer, settings from its tab, both on demand.
  'js/widget-host.js': ['sidepanel.js', 'background.js', 'notes.js', 'settings.js'],
  'js/widgets-store.js': ['sidepanel.js', 'notes.js', 'settings.js'],
  // Live mode is opt-in and CodeMirror is 495 KB. Notes must paint without it; it arrives
  // with js/editor-cm.js when someone actually switches Live on.
  'js/vendor/codemirror.js': ['notes.js', 'sidepanel.js', 'settings.js', 'background.js'],
  'js/notes-regions.js': ['notes.js'],
  // THE TWO NEWEST AND HEAVIEST ADDITIONS, on no first paint at all.
  //
  // The PDF engine is 1.7 MB across two files — bigger than everything else on this list put
  // together — and is needed by the fraction of sessions that open a PDF. The transcript
  // layer is ~30 KB and is needed on YouTube tabs. Both are reached through `await import()`
  // behind js/source-kind.js, which is the ~1 KB gate that decides; the gate is the only part
  // that can be on a first-paint graph, because the decision cannot itself be deferred.
  'js/vendor/pdf.js': ['sidepanel.js', 'notes.js', 'settings.js', 'background.js'],
  'js/pdf-text.js': ['sidepanel.js', 'notes.js', 'settings.js', 'background.js'],
  'js/youtube-transcript.js': ['sidepanel.js', 'notes.js', 'settings.js', 'background.js'],
  'js/events/media-transcript.js': ['sidepanel.js', 'notes.js', 'settings.js', 'background.js'],
  'js/events/pdf-layout.js': ['sidepanel.js', 'notes.js', 'settings.js', 'background.js'],
};
for (const [mod, entries] of Object.entries(OFF_LIMITS)) {
  for (const entry of entries) {
    assert.ok(!staticGraph(entry).has(mod),
      `${mod} is statically reachable from ${entry}. It is only needed on a user action — `
      + 'import it at the call site so it costs nothing until then.');
  }
}

// ---------------------------------------------------------------------------
// THE BLIND SPOT. Everything above follows STATIC imports only, which is right — a dynamic
// import is exactly what keeps weight off the number. But it means the check cannot see an
// `await import()` that boot itself performs, and that is not a hypothetical gap:
//
//   init() → refreshBridge() → await import('./js/providers.js')
//
// ran on every panel open and pulled 382 KB across 25 modules onto the boot path, to read one
// JSON object from localhost. The budget read 769 KB and passed; the panel loaded 939 KB. A
// deferral undone at boot is not a deferral, and the test that guards the deferral has to be
// able to say so.
//
// So: follow init()'s own dynamic imports, and those of the functions it calls by name —
// one level, which is the shape the regression actually takes.
// ---------------------------------------------------------------------------

/** The body of `function name(...)` / `async function name(...)`, brace-matched. */
function fnBody(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

const dynamicSpecs = (body) => [...body.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);

/** Modules an entry point pulls in DYNAMICALLY while booting, resolved to repo-relative paths. */
function bootDynamicImports(entry) {
  const src = readFileSync(path.join(extDir, entry), 'utf8');
  const init = fnBody(src, 'init');
  if (!init) return new Set();
  const specs = new Set(dynamicSpecs(init));
  // …and one level out: a function init calls, whose import lands just as early.
  for (const [, callee] of init.matchAll(/(?:^|[\s;{}=(])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const body = fnBody(src, callee);
    if (body) for (const spec of dynamicSpecs(body)) specs.add(spec);
  }
  const dir = path.dirname(path.join(extDir, entry));
  return new Set([...specs].map((spec) =>
    path.relative(extDir, path.resolve(dir, spec)).split(path.sep).join('/')));
}

// Reached from boot, however it is imported. Being behind an `await import()` is not an
// excuse when boot is what awaits it.
const NOT_ON_BOOT = {
  'sidepanel.js': ['js/providers.js'],
};
for (const [entry, mods] of Object.entries(NOT_ON_BOOT)) {
  const boot = bootDynamicImports(entry);
  for (const mod of mods) {
    assert.ok(!boot.has(mod),
      `${entry} dynamically imports ${mod} on its boot path (init(), or something init calls).\n`
      + '  Deferring a module and then loading it during boot costs MORE than a static import,\n'
      + '  not less: the same bytes, plus a round trip, and the budget above cannot see it.\n'
      + '  Move what boot needs into a small module of its own — see js/bridge-health.js.');
  }
  // The saving is the point, so state it. A future reader can see what boot really costs.
  const bootGraph = new Set(staticGraph(entry));
  for (const mod of boot) for (const f of staticGraph(mod)) bootGraph.add(f);
  report.push(`  ${(entry + ' +boot').padEnd(15)} ${kb(bootGraph).toFixed(1).padStart(7)} KB `
    + `/    — KB  (${bootGraph.size} modules, incl. idle-deferred)`);
}

console.log('first-paint budgets:\n' + report.join('\n'));
