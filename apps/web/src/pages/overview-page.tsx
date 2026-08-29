import { type ReadinessView, SystemStatusCard } from "../features/system-status";

interface OverviewPageProps {
  readonly readiness: ReadinessView;
  readonly onRefresh: () => void;
}

const phases = [
  { number: "01", label: "Foundation", state: "Complete" },
  { number: "02", label: "Identity", state: "Complete" },
  { number: "03", label: "Financial core", state: "Complete" },
  { number: "04", label: "Trading", state: "Complete" },
  { number: "05", label: "Market data", state: "Complete" },
  { number: "06", label: "Product surfaces", state: "Complete" },
  { number: "07", label: "Production readiness", state: "Current" },
  { number: "08", label: "Deployment", state: "Planned" },
];

export function OverviewPage({ readiness, onRefresh }: OverviewPageProps): React.JSX.Element {
  return (
    <main>
      <section className="hero">
        <div className="hero__content">
          <p className="eyebrow">Engineering the market layer</p>
          <h1>
            Build trust.
            <br />
            <span>Trade with clarity.</span>
          </h1>
          <p className="hero__summary">
            Atlas is a production-inspired exchange built one dependable boundary at a time. The
            current release combines exact wallet balances and committed-trade portfolio valuation
            with a server-authoritative limit-order desk, deterministic matching, and atomic
            simulated settlement.
          </p>
          <div className="hero__actions">
            <a className="primary-button" href="#roadmap">
              Explore the build
            </a>
            <span className="release-tag">v0.7 · Production hardening</span>
          </div>
        </div>
        <div className="hero__visual" aria-label="Atlas product workspace">
          <div className="platform-preview">
            <div className="platform-preview__heading">
              <div>
                <span>Atlas workspace</span>
                <strong>Designed for disciplined execution</strong>
              </div>
              <span className="platform-preview__status">
                <i aria-hidden="true" /> Platform ready
              </span>
            </div>
            <div className="platform-preview__grid">
              <article>
                <span>Portfolio</span>
                <strong>Exact balances</strong>
                <small>Server-owned valuation</small>
              </article>
              <article>
                <span>Execution</span>
                <strong>Limit orders</strong>
                <small>Atomic settlement</small>
              </article>
              <article>
                <span>Market data</span>
                <strong>Live depth</strong>
                <small>Recoverable streams</small>
              </article>
              <article>
                <span>Operations</span>
                <strong>Controlled access</strong>
                <small>Audited changes</small>
              </article>
            </div>
            <div className="platform-preview__footer">
              <span>Precision before velocity</span>
              <span>Web · API · PostgreSQL</span>
            </div>
          </div>
        </div>
      </section>

      <section className="dashboard-grid" id="roadmap">
        <SystemStatusCard readiness={readiness} onRefresh={onRefresh} />
        <section className="roadmap-card" aria-labelledby="roadmap-title">
          <div className="roadmap-card__heading">
            <div>
              <p className="eyebrow">Delivery roadmap</p>
              <h2 id="roadmap-title">Phase by phase</h2>
            </div>
            <span>8 phases</span>
          </div>
          <ol className="phase-list">
            {phases.map((phase) => (
              <li key={phase.number}>
                <span className="phase-list__number">{phase.number}</span>
                <strong>{phase.label}</strong>
                <span
                  className={`phase-list__state phase-list__state--${phase.state.toLowerCase()}`}
                >
                  {phase.state}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
