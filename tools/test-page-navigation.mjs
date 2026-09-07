// Going somewhere — and the two ways it could have been done wrongly.
//
// The page toolset had 24 actions and none of them opened a URL, so "go to google.com and
// search for chat panel" — asked four different ways in one session — reached a model with
// click, type and screenshot and no way to arrive anywhere. It fell back on eval_js
// window.open(), which is developer-only, needs trusted events, and is the single most
// privileged tool in the set: the workaround for a missing safe capability was the most
// dangerous one available.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const tools = read('js/page-tools.js');
const nav = read('js/tab-nav.js');
const panel = read('sidepanel.js');
const search = read('js/web-search.js');

// ── NOT a new permission ───────────────────────────────────────────────────
//
// Web search has opened background tabs since it shipped, so the manifest already carries
// everything this needs. A store reviewer sees no new capability, and if that ever stops
// being true it must be a decision, not a side effect of adding a tool.
{
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('tabs'), 'tabs was already granted — for web search');
  assert.ok(manifest.host_permissions.includes('<all_urls>'), 'and so were host permissions');
  // Nothing here may need anything else. These are the ones a navigation feature might be
  // tempted to reach for, and none of them is required to open or point a tab.
  for (const extra of ['browsingData', 'history', 'sessions', 'declarativeNetRequest', 'proxy']) {
    assert.ok(!manifest.permissions.includes(extra), `${extra} must not appear — navigation does not need it`);
  }
}

// ── one implementation, not two ────────────────────────────────────────────
{
  assert.match(search, /await import\('\.\/tab-nav\.js'\)/,
    'web search takes the extracted wait rather than keeping its own');
  assert.doesNotMatch(search, /^import .*tab-nav\.js/m,
    'at its call site — a top-level import puts it on two first-paint graphs for a path most sessions never take');
  assert.doesNotMatch(search, /chrome\.tabs\.onUpdated\.addListener/,
    'and its copy is gone, not merely unused');
  assert.match(search, /timeoutMs: NAV_TIMEOUT_MS, settleMs: RENDER_SETTLE_MS/,
    'while keeping the timings it tuned against real search pages');
  assert.match(tools, /import \{ openTab, navigateTab \} from '\.\/tab-nav\.js'/,
    'and the page tools take the same one');
}

// ── every URL is guarded, twice ────────────────────────────────────────────
//
// The URL is chosen by a model that has been reading page text, tool results and meeting
// captions, so it is attacker-influenced by construction. "Open http://127.0.0.1:4319/…"
// points the user's own browser at their own bridge; 169.254.169.254 is cloud credentials.
{
  assert.match(nav, /import \{ assertFetchable \} from '\.\/context\.js'/,
    'the same guard the fetch paths use — not a second opinion about what is private');
  const openFn = /export async function openTab[\s\S]*?\n}/.exec(nav)[0];
  const navFn = /export async function navigateTab[\s\S]*?\n}\n/.exec(nav)[0];
  assert.match(openFn, /assertFetchable/, 'before opening');
  assert.equal((navFn.match(/assertFetchable/g) || []).length, 2,
    'and twice for a navigation — a public URL is free to redirect onto a blocked host');
  assert.match(navFn, /await waitForTabComplete/,
    'a navigation that returns before the load hands back the OLD page to read and click');
}

// ── the browser is never sent somewhere without being asked ────────────────
{
  assert.match(panel, /ALWAYS_CONFIRM_TOOLS = new Set\(\['eval_js', 'open_tab', 'navigate'\]\)/,
    'a site grant means "act on THIS site" — going to another one is outside it');
  assert.match(panel, /case 'open_tab': return `Open a new tab at \$\{String\(input\.url \|\| ''\)\}`/,
    'and the user sees the whole URL, unclipped — this prompt IS the review');
  assert.match(panel, /case 'navigate': return `Leave \$\{host\} and go to/);
}

// ── …except where the user themselves said where to go ────────────────────
//
// The dialog is the review of a MODEL-chosen URL, and it is the right answer for one. It is
// the wrong answer for a URL the user said out loud: "okay chat panel, go to google.com and
// search for chat panel" was spoken four ways in one meeting and nothing happened any of the
// four times, because the review was a modal in a side panel nobody in a call is looking at.
//
// The narrowing has to be exactly this narrow, so each half is asserted.
{
  const { spokenNamesHost } = await import('../extension/js/events/voice-intents.js');
  const spoken = 'go to google.com and search for chat panel';
  assert.equal(spokenNamesHost('https://www.google.com/search?q=chat+panel', spoken), true,
    'the host the user named, said in full');
  assert.equal(spokenNamesHost('https://www.google.com/search?q=x', 'go to google and search for x'), true,
    'or by its name, for a two-label host');
  // The whole point: the URL is model-chosen, so a host the user never uttered still asks.
  assert.equal(spokenNamesHost('https://evil.test/?q=secrets', spoken), false,
    'a destination they did not name is not authorised by the ones they did');
  assert.equal(spokenNamesHost('https://docs.evil.test/', 'open docs for me'), false,
    'and a bare label never authorises a deeper host — "docs" is not docs.evil.test');
  assert.equal(spokenNamesHost('https://mail.google.com/', 'open google'), false,
    'not even a subdomain of one they named');
  assert.equal(spokenNamesHost('https://google.com/', ''), false, 'nothing spoken authorises nothing');

  // The panel side: one tool, one source of words, and the words are the USER's.
  const fn = /async function spokenAuthorityFor[\s\S]*?\n}/.exec(panel)[0];
  assert.match(fn, /name !== 'open_tab'/, 'open_tab only — navigate replaces the page they are on');
  assert.match(fn, /!spokenTurnText/, 'and only on a turn a spoken command started');
  assert.match(fn, /spokenNamesHost\(input\?\.url, spokenTurnText\)/,
    'checked against the SPOKEN text, not the model’s answer — that is what makes it unsteerable');
  assert.match(fn, /toast\(/, 'and the browser never goes anywhere silently');
  // Consumed before the first await, so a typed turn cannot inherit spoken authority.
  assert.match(panel, /spokenTurnText = pendingSpokenText;\n  pendingSpokenText = '';/,
    'every send clears it — a typed turn must never carry a spoken turn’s authority');
  assert.match(panel, /const spokenOk = await spokenAuthorityFor\(name, input\);/);
  assert.match(panel, /const needs = !spokenOk && \(always \|\| ungranted/,
    'it short-circuits the SITE checks too: open_tab touches nothing on the current page, so '
    + '"is meet.google.com trusted" is the wrong question and in a meeting the answer is always no');
  // eval_js and navigate keep every gate they had.
  assert.doesNotMatch(fn, /eval_js|navigate/, 'the exception must not name any other tool');
}

// ── a person deciding is not a page failing to respond ─────────────────────
//
// The 45s page-action timeout used to wrap the confirmation dialog as well, so the seconds an
// action gets to respond were spent waiting for a human to notice a modal. Someone who looked
// over a minute later found the prompt still up and the action already reported timed out.
{
  assert.match(panel, /const timedExecute = withTimeout\(baseExecute\);/,
    'the clock wraps the execution');
  assert.doesNotMatch(panel, /withTimeout\(guardedExecute\)/, 'and not the question');
  const guard = /const guardedExecute = async[\s\S]*?\n  \};/.exec(panel)[0];
  assert.match(guard, /return timedExecute\(name, input, meta\);/, 'the clock starts after the answer');
  assert.ok(guard.indexOf('confirmPageAction') < guard.indexOf('timedExecute'),
    'in that order — the dialog first, then the timed run');
}

// ── a grant does not survive the page moving ───────────────────────────────
//
// `pageOrigin` is resolved once, when the tools are built. That was already slightly wrong —
// a user can follow a link mid-turn — and navigate makes it trivially exploitable: grant
// "allow for this site" somewhere you trust, navigate away, and every click afterwards would
// be checked against the origin you left.
{
  assert.match(panel, /const liveOrigin = await currentTabOrigin\(state\.activeTab\?\.id, pageOrigin\)/,
    'the origin is read at call time');
  assert.match(panel, /const stillThere = liveOrigin === pageOrigin/);
  assert.match(panel, /!\(siteGranted && stillThere\) && !trustedActionOrigins\.has\(liveOrigin\)/,
    'and a grant only counts while the tab has not moved');
  assert.match(panel, /if \(pagePolicy\.siteKey && stillThere\)/,
    'a durable grant is never written under the name of a site the tab has left');
  assert.doesNotMatch(panel, /trustedActionOrigins\.has\(pageOrigin\)/,
    'no check may still read the stale origin');
}

// ── opening a tab does not hand the model that tab ─────────────────────────
{
  const open = /if \(name === 'open_tab'\)[\s\S]*?\n      \}/.exec(tools)[0];
  assert.doesNotMatch(open, /tabId =/, 'the tools stay pointed at the tab the user is on');
  assert.match(open, /still read and act on the ORIGINAL tab/,
    'and the model is told, so it does not act on a page nobody has looked at');
}

// ── the model is told the tools exist ──────────────────────────────────────
{
  assert.match(tools, /TO GO SOMEWHERE call open_tab .* or navigate/,
    'the absence of this is what sent it to a shell and its own fetch');
  assert.match(tools, /Never use a shell, your own fetch, or eval_js to open a page/);
  const specs = ['open_tab', 'navigate'].map((n) => new RegExp(`name: '${n}'`));
  for (const re of specs) assert.match(tools, re, 'and both are declared as tools');
}

// ── the permission prompt cannot be answered by accident ───────────────────
//
// Reported: "if I accidentally clicked somewhere else while it is asking permissions, I lose
// access to the permission that needs to be fixed." A backdrop click counted as Decline, and
// declining is not a soft outcome — the tool result tells the agent the user refused and must
// NOT retry, so the run stops and the prompt is gone. The card sits at the BOTTOM of the
// panel, so "somewhere else" is most of the panel.
{
  const dialog = /function confirmPageAction[\s\S]*?\n}/.exec(panel)[0];
  assert.doesNotMatch(dialog, /e\.target === ov\) done\('deny'\)/,
    'a stray click must not decide a security prompt');
  assert.match(dialog, /if \(e\.target !== ov\) return;/, 'it draws attention instead');
  assert.match(dialog, /denyBtn\.focus\(\);/, 'and puts the safe default back under the cursor');
  // Enter used to mean ALLOW while the focused button was Decline — the visible safe default
  // and the keystroke people press without reading disagreed, on the one dialog where that
  // matters most.
  assert.doesNotMatch(dialog, /e\.key === 'Enter'/, 'Enter activates the focused button, nothing else');
  assert.match(dialog, /e\.key === 'Escape'.*done\('deny'\)/, 'Escape still declines, deliberately and explicitly');
  assert.match(dialog, /Esc declines/, 'and the dialog says so, since the click-away exit is gone');
  // Every remaining way out is a deliberate press.
  for (const v of ["'deny'", "'site'", "'allow'"]) assert.ok(dialog.includes(v), `${v} is still offered`);
}

console.log('ok — the browser can be sent somewhere, guarded twice, confirmed every time, and with no new permission');
