import type { ProductRoute } from "../app/initial-route";
import type { ReadinessView } from "../features/system-status";

interface DashboardPageProps {
  readonly children: React.ReactNode;
  readonly onNavigate: (route: ProductRoute) => void;
  readonly onRefreshReadiness: () => void;
  readonly readiness: ReadinessView;
  readonly userEmail: string;
}

const shortcuts: ReadonlyArray<{
  readonly label: string;
  readonly description: string;
  readonly route: ProductRoute;
}> = [
  {
    label: "Open trading desk",
    description: "View the live reference chart and place a simulated limit order.",
    route: { name: "trade", marketCode: "BTC-USD" },
  },
  {
    label: "Review orders",
    description: "Inspect private order status, executions, and cancellation controls.",
    route: { name: "orders" },
  },
  {
    label: "Manage funds",
    description: "Open wallets and move simulated value into or out of Atlas.",
    route: { name: "funds" },
  },
];

function readinessCopy(readiness: ReadinessView): string {
  switch (readiness) {
    case "ready":
      return "Atlas services are connected.";
    case "checking":
      return "Confirming the Atlas connection…";
    case "not_ready":
      return "Atlas is starting. Some actions may be temporarily unavailable.";
    case "unreachable":
      return "Atlas cannot be reached right now.";
  }
}

export function DashboardPage({
  children,
  onNavigate,
  onRefreshReadiness,
  readiness,
  userEmail,
}: DashboardPageProps): React.JSX.Element {
  return (
    <div className="dashboard-page">
      <section className="dashboard-welcome" aria-labelledby="dashboard-welcome-title">
        <div>
          <p>Welcome back</p>
          <h2 id="dashboard-welcome-title">{userEmail}</h2>
          <span>Here is your simulated account overview.</span>
        </div>
        <div className="dashboard-welcome__connection" data-state={readiness}>
          <span>{readinessCopy(readiness)}</span>
          {readiness === "not_ready" || readiness === "unreachable" ? (
            <button className="text-button" type="button" onClick={onRefreshReadiness}>
              Retry connection
            </button>
          ) : null}
        </div>
      </section>

      <section className="dashboard-shortcuts" aria-label="Quick actions">
        {shortcuts.map((shortcut) => (
          <a
            key={shortcut.route.name}
            href={
              shortcut.route.name === "trade"
                ? `/app/trade/${shortcut.route.marketCode ?? "BTC-USD"}`
                : `/app/${shortcut.route.name}`
            }
            onClick={(event) => {
              event.preventDefault();
              onNavigate(shortcut.route);
            }}
          >
            <strong>{shortcut.label}</strong>
            <span>{shortcut.description}</span>
            <small>
              Open <span aria-hidden="true">→</span>
            </small>
          </a>
        ))}
      </section>

      {children}
    </div>
  );
}
