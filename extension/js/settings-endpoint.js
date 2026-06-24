export function clearEndpointModelState(endpoint = {}) {
  return {
    ...endpoint,
    model: '',
    models: [],
    modelOptions: [],
    autocompleteModel: '',
  };
}

export function isAuthErrorMessage(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return [
    /http\s*(401|403)\b/,
    /missing captcha token/,
    /missing or invalid authorization header/,
    /invalid authorization header/,
    /authorization header/,
    /\bunauthori[sz]ed\b/,
    /\bforbidden\b/,
    /invalid api key/,
    /api key.*(missing|invalid|required)/,
    /authentication.*(missing|invalid|required|failed)/,
    /fill oauth.*connect/,
    /oauth.*connect first/,
  ].some((pattern) => pattern.test(text));
}

export function endpointErrorAuthStatus(error, options = {}) {
  const message = error?.message || String(error || '');
  return options.includeNonAuth || isAuthErrorMessage(message) ? '✕ ' + message : '';
}

export function modelListAuthStatus(endpoint = {}) {
  if (String(endpoint.authMode || 'apiKey') === 'apiKey' && !String(endpoint.apiKey || '').trim()) {
    return {
      text: 'Models loaded. Add an API key, then click Test to verify chat authentication.',
      cls: '',
    };
  }
  return {
    text: 'Models loaded. Click Test to verify chat authentication.',
    cls: '',
  };
}
