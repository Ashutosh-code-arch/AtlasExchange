import { useCallback, useEffect, useRef, useState } from "react";
import type { PortfolioPosition } from "@atlas/contracts";

import { ApiHttpError } from "../../../shared/api/http-client";
import { useAuthenticationSession, type AuthenticationHttpClient } from "../../authentication";
import { getPortfolioSnapshot, type PortfolioSnapshot } from "../api/get-portfolio-snapshot";
import { formatExactPortfolioDecimal } from "../presentation/format-exact-portfolio-decimal";

type PortfolioLoader = typeof getPortfolioSnapshot;
type PortfolioLoadStatus = "error" | "loading" | "ready" | "refreshing" | "stale";

export interface PortfolioWorkspaceProps {
  readonly snapshotLoader?: PortfolioLoader;
}

interface AuthenticatedPortfolioWorkspaceProps {
  readonly request: AuthenticationHttpClient["request"];
  readonly snapshotLoader: PortfolioLoader;
}

interface PortfolioViewState {
  readonly status: PortfolioLoadStatus;
  readonly snapshot: PortfolioSnapshot | null;
  readonly rateLimited: boolean;
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function valuationLabel(position: PortfolioPosition): string {
  switch (position.valuation.status) {
    case "cash":
      return "Cash";
    case "valued":
      return position.valuation.freshness === "current" ? "Valued" : "Price delayed";
    case "zero":
      return "Zero balance";
    case "unpriced":
      return position.valuation.reason === "NO_VALUATION_MARKET"
        ? "No USD market"
        : "No committed price";
  }
}

function ReferencePrice({ position }: { readonly position: PortfolioPosition }): React.JSX.Element {
  const valuation = position.valuation;
  if (valuation.status === "valued") {
    return (
      <span className="portfolio-positions__cell">
        <strong>{formatExactPortfolioDecimal(valuation.referencePrice)} USD</strong>
        <small>
          {valuation.marketCode} · {displayTimestamp(valuation.referencePriceAsOf)}
        </small>
      </span>
    );
  }
  if (valuation.status === "cash") {
    return (
      <span className="portfolio-positions__cell">
        <strong>1 USD</strong>
        <small>Valuation currency</small>
      </span>
    );
  }
  return (
    <span className="portfolio-positions__cell">
      <strong>—</strong>
      <small>{valuation.status === "zero" ? "Not required" : valuationLabel(position)}</small>
    </span>
  );
}

function PortfolioPositions({
  snapshot,
}: {
  readonly snapshot: PortfolioSnapshot;
}): React.JSX.Element {
  if (snapshot.positions.length === 0) {
    return (
      <div className="portfolio-workspace__empty">
        <p>No wallets are open yet. Create one in the Financial sandbox to begin your portfolio.</p>
        <a className="text-button" href="/app/funds">
          Open Funds
        </a>
      </div>
    );
  }

  return (
    <div className="portfolio-positions__scroll">
      <table className="portfolio-positions" aria-label="Portfolio positions">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Total</th>
            <th scope="col">Available</th>
            <th scope="col">Reserved</th>
            <th scope="col">Reference</th>
            <th scope="col">USD value</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.positions.map((position) => {
            const value = position.valuation.value;
            return (
              <tr key={position.assetCode} data-valuation-status={position.valuation.status}>
                <td data-label="Asset">
                  <span className="portfolio-positions__cell">
                    <strong>{position.assetCode}</strong>
                    <small>{position.displayName}</small>
                  </span>
                </td>
                <td data-label="Total">
                  <span className="portfolio-positions__cell">
                    <strong>{formatExactPortfolioDecimal(position.total)}</strong>
                    <small>{position.assetCode}</small>
                  </span>
                </td>
                <td data-label="Available">{formatExactPortfolioDecimal(position.available)}</td>
                <td data-label="Reserved">{formatExactPortfolioDecimal(position.reserved)}</td>
                <td data-label="Reference">
                  <ReferencePrice position={position} />
                </td>
                <td data-label="USD value">
                  <span className="portfolio-positions__cell">
                    <strong>{value === null ? "—" : formatExactPortfolioDecimal(value)}</strong>
                    <small>{value === null ? "Excluded from subtotal" : "USD"}</small>
                  </span>
                </td>
                <td data-label="Status">
                  <span
                    className={`portfolio-positions__status portfolio-positions__status--${position.valuation.status}`}
                  >
                    {valuationLabel(position)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuthenticatedPortfolioWorkspace({
  request,
  snapshotLoader,
}: AuthenticatedPortfolioWorkspaceProps): React.JSX.Element {
  const generationRef = useRef(0);
  const snapshotRef = useRef<PortfolioSnapshot | null>(null);
  const [view, setView] = useState<PortfolioViewState>({
    status: "loading",
    snapshot: null,
    rateLimited: false,
  });

  const reload = useCallback((): void => {
    const generation = ++generationRef.current;
    setView((current) => ({
      status: current.snapshot === null ? "loading" : "refreshing",
      snapshot: current.snapshot,
      rateLimited: false,
    }));
    void snapshotLoader({ request })
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        snapshotRef.current = snapshot;
        setView({ status: "ready", snapshot, rateLimited: false });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        const existing = snapshotRef.current;
        setView({
          status: existing === null ? "error" : "stale",
          snapshot: existing,
          rateLimited: error instanceof ApiHttpError && error.code === "RATE_LIMITED",
        });
      });
  }, [request, snapshotLoader]);

  useEffect(() => {
    const generation = ++generationRef.current;
    void snapshotLoader({ request })
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        snapshotRef.current = snapshot;
        setView({ status: "ready", snapshot, rateLimited: false });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setView({
          status: "error",
          snapshot: null,
          rateLimited: error instanceof ApiHttpError && error.code === "RATE_LIMITED",
        });
      });
    return () => {
      generationRef.current += 1;
    };
  }, [request, snapshotLoader]);

  if (view.status === "loading") {
    return <p className="portfolio-workspace__gate">Loading your portfolio snapshot…</p>;
  }
  if (view.status === "error" || view.snapshot === null) {
    return (
      <div className="portfolio-workspace__gate" role="alert">
        <span>
          {view.rateLimited
            ? "Too many portfolio refreshes. Wait briefly and try again."
            : "Your portfolio snapshot is unavailable."}
        </span>
        <button className="text-button" type="button" onClick={reload}>
          Retry portfolio
        </button>
      </div>
    );
  }

  const snapshot = view.snapshot;
  return (
    <div className="portfolio-workspace__body">
      {view.status === "stale" ? (
        <div className="portfolio-workspace__notice" role="alert">
          <span>
            {view.rateLimited
              ? "Refresh limit reached. Displayed portfolio may be stale."
              : "Refresh failed. Displayed portfolio may be stale."}
          </span>
          <button className="text-button" type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="portfolio-summary">
        <div>
          <span>{snapshot.summary.complete ? "Estimated portfolio value" : "Valued subtotal"}</span>
          <strong aria-label="Portfolio USD value">
            {formatExactPortfolioDecimal(snapshot.summary.totalValue)}
            <small> USD</small>
          </strong>
          <p>
            {snapshot.summary.complete
              ? "Every positive position has an accepted Atlas reference price."
              : `${snapshot.summary.unpricedAssetCodes.join(", ")} excluded because no accepted reference price is available.`}
          </p>
        </div>
        <div className="portfolio-summary__meta">
          <span data-complete={String(snapshot.summary.complete)}>
            {snapshot.summary.complete ? "Complete valuation" : "Incomplete valuation"}
          </span>
          <small>Generated {displayTimestamp(snapshot.generatedAt)}</small>
          <button
            className="text-button"
            type="button"
            disabled={view.status === "refreshing"}
            onClick={reload}
          >
            {view.status === "refreshing" ? "Refreshing…" : "Refresh portfolio"}
          </button>
        </div>
      </div>

      <section className="portfolio-positions-panel" aria-labelledby="portfolio-positions-title">
        <header className="portfolio-positions-panel__heading">
          <div>
            <p className="eyebrow">Server-owned balances</p>
            <h3 id="portfolio-positions-title">Positions</h3>
          </div>
          <span>
            {snapshot.positions.length} {snapshot.positions.length === 1 ? "asset" : "assets"}
          </span>
        </header>
        <PortfolioPositions snapshot={snapshot} />
      </section>
      <p className="portfolio-workspace__disclaimer">
        Indicative USD values use the last committed Atlas trade. They are not executable quotes,
        profit/loss, or an accounting statement.
      </p>
    </div>
  );
}

export function PortfolioWorkspace({
  snapshotLoader = getPortfolioSnapshot,
}: PortfolioWorkspaceProps): React.JSX.Element {
  const { state, request } = useAuthenticationSession();
  return (
    <section
      className="portfolio-workspace"
      id="portfolio"
      aria-labelledby="portfolio-workspace-title"
    >
      <div className="portfolio-workspace__heading">
        <div>
          <p className="eyebrow">Holdings and valuation</p>
          <h2 id="portfolio-workspace-title">Portfolio summary</h2>
        </div>
        <p>Exact balances and transparent USD valuation from accepted Atlas reference prices.</p>
      </div>

      {state.status === "authenticated" ? (
        <AuthenticatedPortfolioWorkspace
          key={state.user.id}
          request={request}
          snapshotLoader={snapshotLoader}
        />
      ) : state.status === "checking" ? (
        <p className="portfolio-workspace__gate">Checking your session before loading Portfolio…</p>
      ) : state.status === "unavailable" ? (
        <p className="portfolio-workspace__gate">
          Portfolio is unavailable while Identity services are offline.
        </p>
      ) : (
        <p className="portfolio-workspace__gate">Sign in to view your portfolio.</p>
      )}
    </section>
  );
}
