import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import type { ApplicationRoute } from "./app/initial-route";
import { getReadiness, type ReadinessView } from "./features/system-status";
import { AuthenticationPanel } from "./features/authentication";
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

interface AppProps {
  readonly apiBaseUrl: string;
  readonly readinessClient?: (apiBaseUrl: string) => ReturnType<typeof getReadiness>;
  readonly initialRoute?: ApplicationRoute;
}

function OverviewRoute({
  apiBaseUrl,
  readinessClient,
}: Required<Pick<AppProps, "apiBaseUrl" | "readinessClient">>): React.JSX.Element {
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
      <AuthenticationPanel />
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
      <OverviewPage readiness={readiness} onRefresh={() => void refresh()} />
    </>
  );
}

export function App({
  apiBaseUrl,
  readinessClient = getReadiness,
  initialRoute = { name: "overview" },
}: AppProps): React.JSX.Element {
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Atlas Exchange home">
          <span className="brand__symbol" aria-hidden="true">
            A
          </span>
          <span>ATLAS / EXCHANGE</span>
        </a>
        <div className="site-header__actions">
          <nav aria-label="Primary navigation">
            {initialRoute.name === "overview" ? (
              <a href="#portfolio">Portfolio</a>
            ) : (
              <a href="/">Home</a>
            )}
            {initialRoute.name === "overview" ? <a href="#trading">Trade</a> : null}
            {initialRoute.name === "overview" ? <a href="#financial">Funds</a> : null}
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
        <OverviewRoute apiBaseUrl={apiBaseUrl} readinessClient={readinessClient} />
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
