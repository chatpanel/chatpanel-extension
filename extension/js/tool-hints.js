export function combineSystemPrompt(...parts) {
  return parts
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function sourceCitationSystem({ compact = false } = {}) {
  if (compact) {
    return 'Cite these sources inline with <sup>[1]</sup> and add a bottom "Sources" list with labels and links: reuse any "Open in ChatPanel" link, derive a canonical URL from a returned ID (e.g. Wikipedia page ID → https://en.wikipedia.org/?curid=<id>), else give the ID/label. Never guess a URL you cannot derive.';
  }
  return [
    'Source citation policy:',
    'When your answer uses any attached, retrieved, searched, or tool-provided source, including MCP tools and history/search tools, cite the relevant claim inline with superscript markers like <sup>[1]</sup>.',
    'Finish with a "Sources" section listing each cited source once. Match the numbering used in the answer.',
    'For each source, include the best available title/name and URL/link. A ChatPanel history/note/meeting/chat result already carries an "Open in ChatPanel" chrome-extension:// link — reuse that exact link so the user can jump straight to the item.',
    'If a tool returns a stable identifier for a known public source instead of a URL (e.g. a Wikipedia page ID, DOI, arXiv/PubMed ID, or a slug), build the canonical URL from it — for a Wikipedia page ID use https://en.wikipedia.org/?curid=<id> — and cite that. Deterministically constructing a URL from an ID the tool returned is derivation, not fabrication.',
    'Only when no URL is present AND none can be derived, fall back to the source ID, page ID, tool name, search result label, or file/meeting/chat label so the user can still find it.',
    'Do not invent sources, page IDs, or titles, and never guess a URL you cannot derive from a returned identifier.',
    'If you did not use sources beyond general reasoning, omit the Sources section.',
  ].join('\n');
}

export function toolStatus(result) {
  const o = resultObject(result);
  if (!o) return '';
  if (o.error) {
    const detail = errorDetail(o);
    if (o.blocked) return `blocked: ${detail}`.slice(0, 90);
    return `error: ${detail}`.slice(0, 90);
  }
  if (typeof o.mode === 'string') return o.mode;
  if (o.ok === false) return `fail${o.error ? ': ' + String(o.error).slice(0, 70) : ''}`;
  if (o.note) return String(o.note).slice(0, 80);
  return 'ok';
}

// The GENERIC MCP guidance + citation policy — identical for every server, so emit
// it ONCE per turn (see buildToolset), not once per connected server. Previously
// this rode inside every mcpInventorySystem() block, so N servers repeated it N
// times and bloated the prompt by thousands of tokens.
export function mcpSharedSystem() {
  return [
    'One or more MCP servers are connected in ChatPanel for this conversation (each listed below with its callable tools).',
    'Use their MCP tools directly when the user asks for matching data or actions. Do not ask the user to configure or discover these tools if they are listed.',
    'Do not call MCP tools when the attached page or provided context is enough to answer; summarize or analyze that context directly.',
    'Prefer relevant MCP tools over web search for their domain. If an MCP tool fails, state the exact tool error first, then say whether you are falling back to another source.',
    "Match the user's request domain to the tool's domain: Hacker News requests should use Hacker News tools, Confluence requests should use Confluence tools, and Jira requests should use Jira tools.",
    'Form arguments precisely: pass ONLY the specific entity, identifier, or minimal distinctive keywords the tool needs — not the full sentence, greetings, pleasantries, or unrelated personal details from the conversation. For lookup-by-title/ID tools pass the exact canonical name or ID (e.g. title "Seattle", not "which state is Seattle in"); for search tools pass the fewest keywords that uniquely identify the target. Fill every required argument and follow each argument\'s schema description.',
    "If you don't know the exact title or ID a lookup tool requires, first call the matching search/list tool to resolve it, then call the lookup — never guess identifiers.",
    'Do not retry the exact same failed tool call. Re-check the listed inputs, choose a better matching tool, or answer with the tool error.',
    'When MCP or search results inform the answer, include inline citations and a bottom Sources section; do not wait for the user to ask for links.',
    sourceCitationSystem(),
  ].join('\n');
}

// Per-server block: ONLY the server-specific inventory (name + callable tool names
// + a short guide). The generic rules/citation live once in mcpSharedSystem().
export function mcpInventorySystem(serverName, specs = []) {
  if (!specs.length) return '';
  const title = String(serverName || 'MCP').trim() || 'MCP';
  const names = specs.map((s) => s.name).filter(Boolean);
  const shownNames = names.slice(0, 80).join(', ');
  const moreNames = names.length > 80 ? `, and ${names.length - 80} more` : '';
  const useful = specs.slice(0, 18).map(toolLine).filter(Boolean).join('\n');
  return [
    `MCP server "${title}" — callable tools: ${shownNames}${moreNames}.`,
    useful ? `Tool guide:\n${useful}` : '',
  ].filter(Boolean).join('\n');
}

function resultObject(result) {
  if (typeof result === 'string') return parseJson(result);
  if (!result || typeof result !== 'object') return null;
  if (typeof result.text === 'string') return parseJson(result.text) || result;
  return result;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function errorDetail(o) {
  const detail =
    o.message ||
    o.detail ||
    o.error_description ||
    o.refusal_reason ||
    o.retry_hint ||
    o.error;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function toolLine(spec) {
  const desc = cleanDescription(spec.description || spec.name || '');
  const inputs = inputNames(spec.parameters);
  const inputText = inputs.length ? ` inputs: ${inputs.join(', ')}` : '';
  return `- ${spec.name}${inputText}: ${desc}`.slice(0, 260);
}

function cleanDescription(desc) {
  return String(desc)
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function inputNames(schema = {}) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.keys(props)
    .slice(0, 6)
    .map((name) => required.has(name) ? `${name}*` : name);
}
