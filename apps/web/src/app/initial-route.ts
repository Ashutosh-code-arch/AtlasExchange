export type ApplicationRoute =
  | { readonly name: "overview" }
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

export function readInitialApplicationRoute(
  location: InitialRouteLocation,
  history: InitialRouteHistory,
): ApplicationRoute {
  if (location.pathname !== "/verify-email" && location.pathname !== "/reset-password") {
    return { name: "overview" };
  }

  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const parsedToken = new URLSearchParams(fragment).get("token");
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return {
    name: location.pathname === "/verify-email" ? "verify-email" : "reset-password",
    token: parsedToken === null || parsedToken.length === 0 ? undefined : parsedToken,
  };
}
