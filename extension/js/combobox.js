export function normalizeComboboxOptions(options = []) {
  const seen = new Set();
  const normalized = [];
  for (const option of options || []) {
    const value = typeof option === 'string' ? option : option?.id || option?.value || '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = typeof option === 'string' ? value : option.label || option.name || value;
    normalized.push({
      value,
      label,
      meta: label === value ? '' : label,
      free: Boolean(typeof option === 'object' && option?.free),
      icon: (typeof option === 'object' && option?.icon) || null,
    });
  }
  return normalized;
}

function queryTerms(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function filterComboboxOptions(options = [], query = '', limit = 80) {
  const terms = queryTerms(query);
  const list = normalizeComboboxOptions(options);
  if (!terms.length) return list.slice(0, limit);
  return list
    .filter((option) => {
      const haystack = `${option.value} ${option.label} ${option.meta}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0, limit);
}
