import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { ApplicationShell, PublicApplicationShell } from "./app/application-shell";
import {
  applicationRoutePath,
  isProductRoute,
  readApplicationRoute,
  type ApplicationRoute,
  type ProductRoute,
} from "./app/initial-route";
import { AuthenticationPanel, useAuthenticationSession } from "./features/authentication";
import { getReadiness, type ReadinessView } from "./features/system-status";
import { DashboardPage } from "./pages/dashboard-page";
import { ResetPasswordPage } from "./pages/reset-password-page";
import { VerifyEmailPage } from "./pages/verify-email-page";

const FinancialWorkspace = lazy(async () => {
  const financial = await import("./features/financial");
  return { default: financial.FinancialWorkspace };
});

const PortfolioWorkspace = lazy(async () => {
  const portfolio = await import("./features/portfolio");
  return { default: portfolio.PortfolioWorkspace };
});

const TradingWorkspace = lazy(async () => {
  const trading = await import("./features/trading");
  return { default: trading.TradingWorkspace };
});

const NotificationCenter = lazy(async () => {
  const notifications = await import("./features/notifications");
  return { default: notifications.NotificationCenter };
});

const AdministrationWorkspace = lazy(async () => {
  const administration = await import("./features/administration");
  return { default: administration.AdministrationWorkspace };
});

interface AppProps {
  readonly apiBaseUrl: string;
  readonly environment?: "local" | "demo" | "staging" | "production";
  readonly publicAccountFeatures?: Readonly<{
    registrationEnabled: boolean;
    passwordRecoveryEnabled: boolean;
  }>;
  readonly readinessClient?: (apiBaseUrl: string) => ReturnType<typeof getReadiness>;
  readonly initialRoute?: ApplicationRoute;
}

function LoadingSurface({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <section className="product-loading" aria-label={label}>
      <span aria-hidden="true" />
      <p>Loading {label.toLowerCase()}…</p>
    </section>
  );
}

function useReadiness(
  apiBaseUrl: string,
  readinessClient: NonNullable<AppProps["readinessClient"]>,
): { readonly readiness: ReadinessView; readonly refresh: () => void } {
  const [readiness, setReadiness] = useState<ReadinessView>("checking");

  const refresh = useCallback((): void => {
    setReadiness("checking");
    void readinessClient(apiBaseUrl)
      .then((result) => setReadiness(result.status))
      .catch(() => setReadiness("unreachable"));
  }, [apiBaseUrl, readinessClient]);

  useEffect(() => {
    let current = true;
    void readinessClient(apiBaseUrl)
      .then((result) => {
        if (current) setReadiness(result.status);
      })
      .catch(() => {
        if (current) setReadiness("unreachable");
      });
    return () => {
      current = false;
    };
  }, [apiBaseUrl, readinessClient]);

  return { readiness, refresh };
}

function RouteContent({
  apiBaseUrl,
  onNavigate,
  onRefreshReadiness,
  readiness,
  route,
  userEmail,
}: {
  readonly apiBaseUrl: string;
  readonly onNavigate: (route: ProductRoute) => void;
  readonly onRefreshReadiness: () => void;
  readonly readiness: ReadinessView;
  readonly route: ProductRoute;
  readonly userEmail: string;
}): React.JSX.Element {
  switch (route.name) {
    case "dashboard":
      return (
        <DashboardPage
          onNavigate={onNavigate}
          onRefreshReadiness={onRefreshReadiness}
          readiness={readiness}
          userEmail={userEmail}
        >
          <Suspense fallback={<LoadingSurface label="Portfolio" />}>
            <PortfolioWorkspace />
          </Suspense>
        </DashboardPage>
      );
    case "trade":
      return (
        <Suspense fallback={<LoadingSurface label="Trading desk" />}>
          <TradingWorkspace
            key={route.marketCode ?? "default-market"}
            apiBaseUrl={apiBaseUrl}
            {...(route.marketCode === undefined ? {} : { initialMarketCode: route.marketCode })}
            onMarketSelect={(marketCode) => onNavigate({ name: "trade", marketCode })}
          />
        </Suspense>
      );
    case "orders":
      return (
        <Suspense fallback={<LoadingSurface label="Orders" />}>
          <TradingWorkspace apiBaseUrl={apiBaseUrl} mode="activity" />
        </Suspense>
      );
    case "portfolio":
      return (
        <Suspense fallback={<LoadingSurface label="Portfolio" />}>
          <PortfolioWorkspace />
        </Suspense>
      );
    case "funds":
      return (
        <Suspense fallback={<LoadingSurface label="Funds" />}>
          <FinancialWorkspace />
        </Suspense>
      );
    case "profile":
      return <AuthenticationPanel />;
    case "admin":
      return (
        <Suspense fallback={<LoadingSurface label="Administration" />}>
          <AdministrationWorkspace />
        </Suspense>
      );
  }
}

function AuthenticatedApplication({
  apiBaseUrl,
  environment,
  onNavigate,
  readinessClient,
  route,
}: {
  readonly apiBaseUrl: string;
  readonly environment: NonNullable<AppProps["environment"]>;
  readonly onNavigate: (route: ProductRoute) => void;
  readonly readinessClient: NonNullable<AppProps["readinessClient"]>;
  readonly route: ProductRoute;
}): React.JSX.Element {
  const { state } = useAuthenticationSession();
  const { readiness, refresh } = useReadiness(apiBaseUrl, readinessClient);

  if (state.status !== "authenticated") {
    return <LoadingSurface label="Secure workspace" />;
  }

  const permittedRoute =
    route.name === "admin" && !state.user.roles.includes("admin")
      ? ({ name: "dashboard" } as const)
      : route;

  return (
    <ApplicationShell
      environment={environment}
      onNavigate={onNavigate}
      readiness={readiness}
      route={permittedRoute}
      user={state.user}
      notifications={
        <Suspense fallback={null}>
          <NotificationCenter />
        </Suspense>
      }
    >
      <RouteContent
        apiBaseUrl={apiBaseUrl}
        onNavigate={onNavigate}
        onRefreshReadiness={refresh}
        readiness={readiness}
        route={permittedRoute}
        userEmail={state.user.email}
      />
    </ApplicationShell>
  );
}

export function App({
  apiBaseUrl,
  environment = "local",
  publicAccountFeatures = {
    registrationEnabled: true,
    passwordRecoveryEnabled: true,
  },
  readinessClient = getReadiness,
  initialRoute = { name: "dashboard" },
}: AppProps): React.JSX.Element {
  const { state } = useAuthenticationSession();
  const [route, setRoute] = useState<ApplicationRoute>(initialRoute);

  const navigate = useCallback((nextRoute: ProductRoute): void => {
    window.history.pushState(window.history.state, "", applicationRoutePath(nextRoute));
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const onPopState = (): void => setRoute(readApplicationRoute(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (state.status !== "authenticated" || route.name !== "login") return;
    window.history.replaceState(
      window.history.state,
      "",
      applicationRoutePath({ name: "dashboard" }),
    );
  }, [route.name, state.status]);

  useEffect(() => {
    const title = isProductRoute(route)
      ? `${route.name.slice(0, 1).toUpperCase()}${route.name.slice(1)} · Atlas Exchange`
      : "Atlas Exchange";
    document.title = title;
  }, [route]);

  if (route.name === "verify-email") return <VerifyEmailPage token={route.token} />;
  if (route.name === "reset-password") return <ResetPasswordPage token={route.token} />;

  if (state.status !== "authenticated") {
    return (
      <PublicApplicationShell environment={environment}>
        <AuthenticationPanel publicAccountFeatures={publicAccountFeatures} />
      </PublicApplicationShell>
    );
  }

  const productRoute = isProductRoute(route) ? route : ({ name: "dashboard" } as const);
  return (
    <AuthenticatedApplication
      apiBaseUrl={apiBaseUrl}
      environment={environment}
      onNavigate={navigate}
      readinessClient={readinessClient}
      route={productRoute}
    />
  );
}
