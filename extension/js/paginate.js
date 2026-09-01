// Paging a list, and nothing else.
//
// Its own file because two very different views need it — the side panel's history drawer and
// the settings page's agent-access log — and the only other home it had was
// conversation-search.js, which pulls a BM25 index in behind it. Importing a search engine to
// slice an array is the kind of thing that quietly costs a page its load time.
//
// Pure input → output, no DOM, no storage: a mobile client renders different controls around
// exactly this arithmetic.

export function paginateEntries(entries = [], { page = 1, pageSize = 25 } = {}) {
  const size = Math.max(1, Number(pageSize) || 25);
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const startIndex = (currentPage - 1) * size;
  const items = entries.slice(startIndex, startIndex + size);
  return {
    items,
    page: currentPage,
    pageSize: size,
    total,
    totalPages,
    start: total ? startIndex + 1 : 0,
    end: startIndex + items.length,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}
