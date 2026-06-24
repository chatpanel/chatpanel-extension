export function initialHistoryView(hash, itemView = 'chat') {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { view: 'graph', id: '' };

  try {
    return { view: itemView, id: decodeURIComponent(raw) };
  } catch {
    return { view: itemView, id: raw };
  }
}
