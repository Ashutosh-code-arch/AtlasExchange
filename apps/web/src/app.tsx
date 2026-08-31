import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import type { ApplicationRoute } from "./app/initial-route";
import { getReadiness, type ReadinessView } from "./features/system-status";
import { AuthenticationPanel, useAuthenticationSession } from "./features/authentication";
import { OverviewPage } from "./pages/overview-page";
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

function AdministrationNavigationLink(): React.JSX.Element | null {
  const { state } = useAuthenticationSession();
  return state.status === "authenticated" && state.user.roles.includes("admin") ? (
    <a href="#administration">Admin</a>
  ) : null;
}

function AdministrationRoute(): React.JSX.Element | null {
  const { state } = useAuthenticationSession();
  if (state.status !== "authenticated" || !state.user.roles.includes("admin")) return null;
  return (
    <Suspense
      fallback={
        <section className="administration-workspace" aria-label="Administration console">
          <p className="administration-workspace__gate">Loading the Administration console…</p>
        </section>
      }
    >
      <AdministrationWorkspace />
    </Suspense>
  );
}

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

function OverviewRoute({
  apiBaseUrl,
  readinessClient,
  publicAccountFeatures,
}: Required<
  Pick<AppProps, "apiBaseUrl" | "readinessClient" | "publicAccountFeatures">
>): React.JSX.Element {
  const [readiness, setReadiness] = useState<ReadinessView>("checking");

  const refresh = useCallback(async () => {
    setReadiness("checking");
    try {
      const result = await readinessClient(apiBaseUrl);
      setReadiness(result.status);
    } catch {
      setReadiness("unreachable");
    }
  }, [apiBaseUrl, readinessClient]);

  useEffect(() => {
    let isCurrent = true;
    readinessClient(apiBaseUrl)
      .then((result) => {
        if (isCurrent) {
          setReadiness(result.status);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setReadiness("unreachable");
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [apiBaseUrl, readinessClient]);

  return (
    <>
      <AuthenticationPanel publicAccountFeatures={publicAccountFeatures} />
      <OverviewPage readiness={readiness} onRefresh={() => void refresh()} />
      <Suspense
        fallback={
          <section className="portfolio-workspace" aria-label="Portfolio">
            <p className="portfolio-workspace__gate">Loading the Portfolio workspace…</p>
          </section>
        }
      >
        <PortfolioWorkspace />
      </Suspense>
      <Suspense
        fallback={
          <section className="trading-workspace" aria-label="Trading desk">
            <p className="trading-workspace__catalog-state">Loading the Trading desk…</p>
          </section>
        }
      >
        <TradingWorkspace apiBaseUrl={apiBaseUrl} />
      </Suspense>
      <Suspense
        fallback={
          <section className="financial-workspace" aria-label="Financial sandbox">
            <p className="financial-workspace__gate">Loading the Financial sandbox…</p>
          </section>
        }
      >
        <FinancialWorkspace />
      </Suspense>
      <AdministrationRoute />
    </>
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
  initialRoute = { name: "overview" },
}: AppProps): React.JSX.Element {
  return (
    <div className="app-shell">
      <header className="site-header" data-environment={environment}>
        <a className="brand" href="/" aria-label="Atlas Exchange home">
          <span className="brand__symbol" aria-hidden="true">
            A
          </span>
          <span>ATLAS / EXCHANGE</span>
        </a>
        {environment === "demo" ? (
          <span className="site-header__environment">Demo · Simulation</span>
        ) : null}
        <div className="site-header__actions">
          <nav aria-label="Primary navigation">
            {initialRoute.name === "overview" ? (
              <a href="#portfolio">Portfolio</a>
            ) : (
              <a href="/">Home</a>
            )}
            {initialRoute.name === "overview" ? <a href="#trading">Trade</a> : null}
            {initialRoute.name === "overview" ? <a href="#financial">Funds</a> : null}
            {initialRoute.name === "overview" ? <AdministrationNavigationLink /> : null}
            {initialRoute.name === "overview" ? <a href="#roadmap">Roadmap</a> : null}
            <a
              href="https://github.com/Ashutosh-code-arch/AtlasExchange"
              target="_blank"
              rel="noreferrer"
            >
              Repository <span aria-hidden="true">↗</span>
            </a>
          </nav>
          {initialRoute.name === "overview" ? (
            <Suspense fallback={null}>
              <NotificationCenter />
            </Suspense>
          ) : null}
        </div>
      </header>
      {initialRoute.name === "overview" ? (
        <OverviewRoute
          apiBaseUrl={apiBaseUrl}
          readinessClient={readinessClient}
          publicAccountFeatures={publicAccountFeatures}
        />
      ) : initialRoute.name === "verify-email" ? (
        <VerifyEmailPage token={initialRoute.token} />
      ) : (
        <ResetPasswordPage token={initialRoute.token} />
      )}
      <footer>
        <span>Atlas Labs · Engineering Academy</span>
        <span>Precision before velocity.</span>
      </footer>
    </div>
  );
}
