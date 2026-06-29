import assert from 'node:assert/strict';
import { rankToolSpecs, narrowToolset, isLocalToolSpec } from '../extension/js/tool-select.js';

const spec = (name, description = '') => ({ name, description });

// --- isLocalToolSpec: local (page/history) vs remote MCP ---
assert.equal(isLocalToolSpec(spec('history_search')), true);
assert.equal(isLocalToolSpec(spec('inspect_page')), true);
assert.equal(isLocalToolSpec(spec('mcp_deepwiki__ask')), false);

// --- rankToolSpecs: most relevant first ---
{
  const specs = [
    spec('mcp_calc__add', 'add two numbers'),
    spec('mcp_wiki__search_wikipedia', 'search wikipedia articles'),
    spec('mcp_weather__forecast', 'weather forecast'),
  ];
  const ranked = rankToolSpecs(specs, 'use the wiki search tool to look up a president');
  assert.equal(ranked[0].name, 'mcp_wiki__search_wikipedia', 'wiki tool ranks first');
}

// --- narrowToolset: no cap / small set → unchanged (same object) ---
{
  const ts = { specs: [spec('a'), spec('b'), spec('c')], execute: () => {}, system: 'x' };
  assert.equal(narrowToolset(ts, 'q', { cap: 0 }), ts);
  assert.equal(narrowToolset(ts, 'q', { cap: 5 }), ts);
}

// --- narrowToolset: caps the MCP tools to top-K by relevance (locals are free and
//     always kept), keeps order. `cap` bounds the NARROWABLE (MCP) set, not the total. ---
{
  const specs = [
    spec('history_search', 'search your chats'),    // local — always kept, doesn't count toward cap
    spec('inspect_page', 'read the page'),          // local — always kept, doesn't count toward cap
    spec('mcp_wiki__search', 'search wikipedia'),   // relevant
    spec('mcp_calc__add', 'add numbers'),           // irrelevant
    spec('mcp_weather__forecast', 'weather'),       // irrelevant
  ];
  const ts = { specs, execute: () => {}, system: '' };
  const out = narrowToolset(ts, 'search wikipedia for a president', { cap: 1, keep: isLocalToolSpec });
  const names = out.specs.map((s) => s.name);
  assert.equal(out.specs.length, 3, 'cap 1 MCP tool + 2 local tools (locals are free) = 3');
  assert.ok(names.includes('history_search') && names.includes('inspect_page'), 'local tools kept');
  assert.ok(names.includes('mcp_wiki__search'), 'most-relevant MCP tool kept');
  assert.ok(!names.includes('mcp_calc__add'), 'irrelevant MCP tool dropped');
  assert.deepEqual(names, ['history_search', 'inspect_page', 'mcp_wiki__search'], 'original order preserved');
}

console.log('tool-select tests passed');
