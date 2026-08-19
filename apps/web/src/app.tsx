import { useCallback, useEffect, useState } from "react";

import { getReadiness, type ReadinessView } from "./features/system-status";
import { OverviewPage } from "./pages/overview-page";

interface AppProps {
  readonly apiBaseUrl: string;
  readonly readinessClient?: (apiBaseUrl: string) => ReturnType<typeof getReadiness>;
}

export function App({ apiBaseUrl, readinessClient = getReadiness }: AppProps): React.JSX.Element {
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
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Atlas Exchange home">
          <span className="brand__symbol" aria-hidden="true">
            A
          </span>
          <span>ATLAS / EXCHANGE</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#roadmap">Roadmap</a>
          <a
            href="https://github.com/Ashutosh-code-arch/AtlasExchange"
            target="_blank"
            rel="noreferrer"
          >
            Repository <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <OverviewPage readiness={readiness} onRefresh={() => void refresh()} />
      <footer>
        <span>Atlas Labs · Engineering Academy</span>
        <span>Precision before velocity.</span>
      </footer>
    </div>
  );
}
