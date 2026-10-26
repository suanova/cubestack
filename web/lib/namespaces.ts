// Which namespaces a create wizard offers, and which one it opens on, for both
// consoles.
//
// The rules live here rather than in either options route because the two
// wizards must not answer them differently: the dev-environment wizard used to
// prefer the platform's configured namespace and fall back to `default`, while
// the inference wizard preferred `project-a` by name and otherwise took whatever
// sorted first — which on a real install is a platform namespace such as
// `ai-gateway-system`, offered as the home for a user's InferenceService.

/** The namespace both wizards offer without the platform having to configure one. */
export const DEFAULT_NAMESPACE = "default";

/**
 * The namespaces a wizard offers, given the namespaces the cluster has.
 *
 * Only `default`, plus the namespace the platform configured explicitly. A
 * create wizard used to offer every namespace the cluster had that a denylist
 * did not name, which meant each namespace the platform installed had to be
 * added to the denylist by name — measured on cs5, the operator's own
 * `monitoring` and `cuberouter` were offered as a home for a user's
 * StatefulSet, PVC and Routes. Rather than chase those names, the wizard offers
 * the one namespace that is always safe and lets the user create (or, by typing
 * its name, reuse) a tenant namespace of their own from the same select.
 *
 * `CUBESTACK_DEFAULT_NAMESPACE` is kept: it is the platform stating where its
 * users belong, so that namespace stays selectable even though it is not
 * `default`. A stale value naming a namespace the cluster does not have is not
 * offered — there is nothing to create in.
 */
export function offeredNamespaces(names: string[]): string[] {
  const configured = (process.env.CUBESTACK_DEFAULT_NAMESPACE ?? "").trim();
  const offered = new Set([DEFAULT_NAMESPACE, ...(configured ? [configured] : [])]);
  return names.filter((name) => offered.has(name)).sort();
}

/**
 * The namespace a wizard should open on, given the namespaces it may offer:
 *
 * 1. CUBESTACK_DEFAULT_NAMESPACE, when the platform sets it (the chart's `env`
 *    value) and the cluster actually has that namespace — an explicit decision,
 *    so it wins;
 * 2. `default`;
 * 3. otherwise the first name offered.
 *
 * Null only when there is nothing to offer at all.
 */
export function defaultNamespaceOf(names: string[]): string | null {
  const configured = (process.env.CUBESTACK_DEFAULT_NAMESPACE ?? "").trim();
  if (configured && names.includes(configured)) return configured;
  if (names.includes(DEFAULT_NAMESPACE)) return DEFAULT_NAMESPACE;
  return names[0] ?? null;
}
