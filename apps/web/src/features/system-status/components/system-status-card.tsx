export type ReadinessView = "checking" | "ready" | "not_ready" | "unreachable";

interface SystemStatusCardProps {
  readonly readiness: ReadinessView;
  readonly onRefresh: () => void;
}

const statusCopy: Record<ReadinessView, { label: string; detail: string }> = {
  checking: { label: "Checking", detail: "Verifying API and database readiness." },
  ready: { label: "Operational", detail: "API and PostgreSQL are ready for traffic." },
  not_ready: { label: "Starting", detail: "The API is alive but not ready for traffic." },
  unreachable: { label: "Offline", detail: "The API cannot be reached from this browser." },
};

export function SystemStatusCard({
  readiness,
  onRefresh,
}: SystemStatusCardProps): React.JSX.Element {
  const copy = statusCopy[readiness];

  return (
    <section className="status-card" aria-labelledby="system-status-title">
      <div className="status-card__heading">
        <div>
          <p className="eyebrow">Live infrastructure</p>
          <h2 id="system-status-title">System status</h2>
        </div>
        <span className={`status-pill status-pill--${readiness}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {copy.label}
        </span>
      </div>
      <p className="status-card__detail" aria-live="polite">
        {copy.detail}
      </p>
      <div className="status-card__checks">
        <div>
          <span>API process</span>
          <strong>{readiness === "unreachable" ? "Unavailable" : "Connected"}</strong>
        </div>
        <div>
          <span>PostgreSQL</span>
          <strong>{readiness === "ready" ? "Compatible" : "Pending"}</strong>
        </div>
      </div>
      <button className="text-button" type="button" onClick={onRefresh}>
        Refresh status <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
