export type ProductRoute =
  | { readonly name: "dashboard" }
  | { readonly name: "trade"; readonly marketCode?: string }
  | { readonly name: "orders" }
  | { readonly name: "portfolio" }
  | { readonly name: "funds" }
  | { readonly name: "profile" }
  | { readonly name: "admin" };

export type ApplicationRoute =
  | ProductRoute
  | { readonly name: "login" }
  | { readonly name: "verify-email"; readonly token: string | undefined }
  | { readonly name: "reset-password"; readonly token: string | undefined };

export interface InitialRouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export interface InitialRouteHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

const productRouteNames = new Set<ProductRoute["name"]>([
  "dashboard",
  "orders",
  "portfolio",
  "funds",
  "profile",
  "admin",
]);

export function isProductRoute(route: ApplicationRoute): route is ProductRoute {
  return productRouteNames.has(route.name as ProductRoute["name"]) || route.name === "trade";
}

export function applicationRoutePath(route: ProductRoute | { readonly name: "login" }): string {
  if (route.name === "login") return "/login";
  if (route.name === "trade") {
    return route.marketCode === undefined
      ? "/app/trade"
      : `/app/trade/${encodeURIComponent(route.marketCode)}`;
  }
  return `/app/${route.name}`;
}

export function readApplicationRoute(
  location: Pick<InitialRouteLocation, "pathname">,
): ApplicationRoute {
  const normalizedPath =
    location.pathname.length > 1 ? location.pathname.replace(/\/+$/, "") : location.pathname;

  if (normalizedPath === "/login") return { name: "login" };
  if (normalizedPath === "/verify-email") return { name: "verify-email", token: undefined };
  if (normalizedPath === "/reset-password") return { name: "reset-password", token: undefined };
  if (normalizedPath === "/" || normalizedPath === "/app") return { name: "dashboard" };

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] !== "app") return { name: "dashboard" };

  if (segments[1] === "trade") {
    if (segments.length !== 3) return { name: "trade" };
    try {
      const marketCode = decodeURIComponent(segments[2] ?? "").toUpperCase();
      return /^[A-Z0-9]+-[A-Z0-9]+$/.test(marketCode)
        ? { name: "trade", marketCode }
        : { name: "trade" };
    } catch {
      return { name: "trade" };
    }
  }

  const candidate = segments.length === 2 ? segments[1] : undefined;
  return candidate !== undefined && productRouteNames.has(candidate as ProductRoute["name"])
    ? { name: candidate as Exclude<ProductRoute["name"], "trade"> }
    : { name: "dashboard" };
}

export function readInitialApplicationRoute(
  location: InitialRouteLocation,
  history: InitialRouteHistory,
): ApplicationRoute {
  const route = readApplicationRoute(location);
  if (route.name !== "verify-email" && route.name !== "reset-password") return route;

  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const parsedToken = new URLSearchParams(fragment).get("token");
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return {
    name: route.name,
    token: parsedToken === null || parsedToken.length === 0 ? undefined : parsedToken,
  };
}
