// READING THE OPEN TAB IS A FIRST-CLASS USE OF IT, and the prompts have to say so.
//
// From a real activity log: 298 page actions, of which 40 screenshots and only 10 read_page —
// plus minute-long chat turns with `page`, `find` and `mcp` all armed and ZERO ChatPanel tool
// calls. The models were fetching the article URL with their own web tools instead, which
// returns a different page: not logged in, not rendered, often a login wall or raw HTML. That
// is slower, less reliable, and more tokens than one read_page of the tab already on screen.
//
// The cause was in the wording. Every tool named in the guidance was an ACTION tool — type,
// click, fill, draw — so a model asked to summarise an article found nothing there for
// reading and reached for what it knew.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_AUTOMATION_SYSTEM, PAGE_TOOL_SPECS } from '../extension/js/page-tools.js';

// The tool itself was never the problem: it reads up to 40k chars and reports truncation.
const readPage = PAGE_TOOL_SPECS.find((s) => s.name === 'read_page');
assert.ok(readPage, 'read_page is not offered at all');
assert.match(readPage.description, /READ the page as text/);
assert.match(readPage.parameters.properties.maxChars.description, /default 40000/);

// AND IT CAN BE ASKED A QUESTION. Without a query it returns the head of the document, which
// on a long wiki page is breadcrumbs and navigation — one real turn made NINE whole-page
// reads, ~99,000 characters, hunting for a single paragraph.
assert.ok(readPage.parameters.properties.query, 'read_page cannot be asked for a specific thing');
assert.match(readPage.description, /PASS A QUERY/);
assert.ok(readPage.parameters.properties.maxTokens, 'a query read has no budget');

// The deferred manual names it among the tools to use, rather than listing only actions.
assert.match(PAGE_AUTOMATION_SYSTEM, /USE ONLY the ChatPanel browser tools provided here \(read_page/,
  'the manual lists only action tools, so reading has no entry point');
assert.match(PAGE_AUTOMATION_SYSTEM, /TO READ WHAT THE PAGE SAYS/);
assert.match(PAGE_AUTOMATION_SYSTEM, /PASS A QUERY to read_page/,
  'nothing tells the model it can ask a long page a question');

// And it forbids the thing the models were actually doing. The old prohibition covered a
// separate BROWSER — a URL fetch is not a browser, so it never read as prohibited.
assert.match(PAGE_AUTOMATION_SYSTEM, /DO NOT FETCH THE URL/);
assert.match(PAGE_AUTOMATION_SYSTEM, /not logged in, not rendered/);
assert.match(PAGE_AUTOMATION_SYSTEM, /Screenshots are for when the LAYOUT matters, never for reading text/);

// THE RESIDENT LINE IS THE ONE THAT DECIDES. The manual travels with the first `page` result,
// and the whole failure is that there is no first `page` call — guidance that only arrives
// after the mistake cannot prevent it. So the always-present line must carry it too.
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const resident = panel.slice(panel.indexOf("You are connected to the user's LIVE browser tab"));
const line = resident.slice(0, resident.indexOf('residentSystem]'));
assert.match(line, /To READ what it says/, 'the resident line still leads with acting, not reading');
assert.match(line, /read_page/, 'the resident line never names the tool that reads the page');
assert.match(line, /Do NOT fetch the URL/, 'the resident line does not rule out a web fetch of the open tab');
assert.match(line, /On a LONG page pass a query/, 'the resident line does not mention querying a long page');
// Still says it can act — fixing the reading gap must not lose the refusal fix that line
// exists for ("Since I cannot directly type into your Google Sheet").
assert.match(line, /Never tell the user you cannot interact with the page/);

console.log('✓ page prompts: reading is named, fetching the open tab is ruled out');
