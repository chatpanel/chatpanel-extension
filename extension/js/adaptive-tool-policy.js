const INVALID_PARAMS_RE = /\b(?:invalid request parameters|-32602)\b/i;

export function resultText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.text === 'string') return result.text;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function isInvalidToolParametersResult(result) {
  return INVALID_PARAMS_RE.test(resultText(result));
}

export function adaptiveToolRetryHint(name) {
  const tool = String(name || 'this tool');
  return [
    `Do not retry ${tool} with the same arguments.`,
    'Match the user request to the tool domain first: Hacker News requests should use Hacker News tools, Confluence requests should use Confluence tools, and Jira requests should use Jira tools.',
    'If the right tool is unavailable, answer with the exact tool error instead of trying unrelated tools.',
  ].join(' ');
}

export function createAdaptiveToolPolicy() {
  const suppressed = new Set();

  return {
    isSuppressed(name) {
      return suppressed.has(String(name || ''));
    },
    recordResult(name, result) {
      const toolName = String(name || '');
      if (toolName && isInvalidToolParametersResult(result)) suppressed.add(toolName);
    },
    filterOpenAITools(specs = []) {
      return (specs || []).filter((spec) => !suppressed.has(spec?.function?.name));
    },
    filterAnthropicTools(specs = []) {
      return (specs || []).filter((spec) => !suppressed.has(spec?.name));
    },
  };
}
