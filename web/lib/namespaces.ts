// Which namespace a create wizard opens on, for both consoles.
//
// The rule lives here rather than in either options route because the two
// wizards must not answer it differently: the dev-environment wizard used to
// prefer the platform's configured namespace and fall back to `default`, while
// the inference wizard preferred `project-a` by name and otherwise took whatever
// sorted first — which on a real install is a platform namespace such as
// `ai-gateway-system`, offered as the home for a user's InferenceService.

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
  if (names.includes("default")) return "default";
  return names[0] ?? null;
}
