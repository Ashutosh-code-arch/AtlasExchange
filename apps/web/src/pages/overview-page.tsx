import { type ReadinessView, SystemStatusCard } from "../features/system-status";

interface OverviewPageProps {
  readonly readiness: ReadinessView;
  readonly onRefresh: () => void;
}

const phases = [
  { number: "01", label: "Foundation", state: "Complete" },
  { number: "02", label: "Identity", state: "Complete" },
  { number: "03", label: "Financial core", state: "Complete" },
  { number: "04", label: "Trading", state: "Current" },
  { number: "05", label: "Market data", state: "Next" },
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
            <span>Then build trades.</span>
          </h1>
          <p className="hero__summary">
            Atlas is a production-inspired exchange built one dependable boundary at a time. The
            current release combines exact wallet balances with a server-authoritative limit-order
            desk, deterministic matching, and atomic simulated settlement.
          </p>
          <div className="hero__actions">
            <a className="primary-button" href="#roadmap">
              Explore the build
            </a>
            <span className="release-tag">v0.4 · Trading desk</span>
          </div>
        </div>
        <div className="hero__visual" aria-label="Atlas foundation architecture">
          <div className="orbit orbit--outer" />
          <div className="orbit orbit--inner" />
          <div className="atlas-mark">
            <span>ATLAS</span>
            <strong>01</strong>
          </div>
          <div className="node node--web">WEB</div>
          <div className="node node--api">API</div>
          <div className="node node--db">DB</div>
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
