// Which of your models the gateway is allowed to route to — and what that starts as.
//
// THE BUG THIS FIXES. A destination list that starts EMPTY. The gateway's config is the
// source of truth for destinations, a freshly installed gateway has none, and nothing ever
// put any there — so "Test a prompt through the gateway" offered an empty model picker, and
// Routing showed a page of unticked boxes. From the outside that reads as "the gateway can't
// see my models", which is exactly how it was reported. The models were configured; the
// gateway had simply never been told it could use them.
//
// The destinations ARE the user's already-configured APIs and agents. There is no second list
// to curate, so the honest default is "all of them", and the control is there to take some
// away — not to grant access one checkbox at a time before anything works at all.
//
// ONE EXCEPTION, and it is a licence one: Free routes to a single destination. Selecting more
// than the cap would show a row of ticks the gateway will not honour, which is worse than
// selecting one. So Free seeds exactly one, and the picker's own upsell explains the rest.
//
// Pure — the caller supplies the available list, the plan and the cap — so the policy is
// testable without a gateway, a licence or a DOM.

/**
 * The destinations to enable when the user has never chosen any.
 *
 * @param available every destination the gateway COULD route to (configured APIs + agents)
 * @param pro       does this plan route to more than one?
 * @param cap       the Free ceiling (FREE_LIMITS.gatewayDestinations)
 * @param preferId  the id to keep when only one fits — the user's active model, so a Free
 *                  user's one routable destination is the one they actually chat with
 */
export function seedDestinations(available, { pro = false, cap = 1, preferId = '' } = {}) {
  const list = Array.isArray(available) ? available.filter(Boolean) : [];
  if (!list.length) return [];
  if (pro) return list;
  const first = (preferId && list.find((d) => d.id === preferId)) || list[0];
  return list.slice(0, Math.max(0, cap - 1)).includes(first)
    ? list.slice(0, Math.max(1, cap))
    : [first, ...list.filter((d) => d !== first)].slice(0, Math.max(1, cap));
}

/**
 * Should we seed at all?
 *
 * Only when the list is empty AND we have never seeded before. Both halves matter: without
 * the first we would overwrite a real choice, and without the second, a user who deliberately
 * turned every destination OFF would find them all back on next time they opened Settings —
 * a control that undoes itself is worse than no control.
 */
export function shouldSeedDestinations({ current = [], seeded = false, available = [] } = {}) {
  return !seeded && !(current || []).length && (available || []).length > 0;
}
