// Pure nav active-state logic, extracted from the sidebar so it can be
// unit-tested (issue #51).

/** Is the given nav href the current route? Only real Next routes can be active. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/dashboards")
    return pathname === "/dashboards" || pathname.startsWith("/dashboards/");
  if (href === "/inference-services")
    return pathname === "/inference-services" || pathname.startsWith("/inference-services/");
  if (href === "/dev-environments")
    return pathname === "/dev-environments" || pathname.startsWith("/dev-environments/");
  return false; // anything else is not a real route
}
