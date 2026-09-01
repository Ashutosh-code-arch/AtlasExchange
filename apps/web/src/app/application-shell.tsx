import type { CurrentUser } from "../features/authentication";
import type { ReadinessView } from "../features/system-status";
import type { ProductRoute } from "./initial-route";
import { applicationRoutePath } from "./initial-route";

type Navigate = (route: ProductRoute) => void;

interface ApplicationShellProps {
  readonly children: React.ReactNode;
  readonly environment: "local" | "demo" | "staging" | "production";
  readonly onNavigate: Navigate;
  readonly readiness: ReadinessView;
  readonly route: ProductRoute;
  readonly user: CurrentUser;
  readonly notifications: React.ReactNode;
}

interface NavigationItem {
  readonly label: string;
  readonly route: ProductRoute;
  readonly icon: "dashboard" | "trade" | "orders" | "portfolio" | "funds" | "profile" | "admin";
}

const primaryNavigation: readonly NavigationItem[] = [
  { label: "Dashboard", route: { name: "dashboard" }, icon: "dashboard" },
  { label: "Trade", route: { name: "trade", marketCode: "BTC-USD" }, icon: "trade" },
  { label: "Orders", route: { name: "orders" }, icon: "orders" },
  { label: "Portfolio", route: { name: "portfolio" }, icon: "portfolio" },
  { label: "Funds", route: { name: "funds" }, icon: "funds" },
];

const routeTitles: Record<
  ProductRoute["name"],
  { readonly title: string; readonly context: string }
> = {
  dashboard: { title: "Dashboard", context: "Account overview" },
  trade: { title: "Trade", context: "Markets and execution" },
  orders: { title: "Orders", context: "Orders and executions" },
  portfolio: { title: "Portfolio", context: "Holdings and valuation" },
  funds: { title: "Funds", context: "Simulated balances" },
  profile: { title: "Profile", context: "Identity and sessions" },
  admin: { title: "Administration", context: "Restricted operations" },
};

function ShellIcon({ name }: { readonly name: NavigationItem["icon"] }): React.JSX.Element {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  const path = (() => {
    switch (name) {
      case "dashboard":
        return <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" {...common} />;
      case "trade":
        return <path d="M4 17l5-5 3 3 7-8M15 7h4v4" {...common} />;
      case "orders":
        return <path d="M7 4h10M7 9h10M7 14h6M5 4h.01M5 9h.01M5 14h.01M6 20l2 2 4-5" {...common} />;
      case "portfolio":
        return <path d="M4 8h16v11H4zM8 8V5h8v3M4 12h16M10 12v2h4v-2" {...common} />;
      case "funds":
        return <path d="M4 7h16v12H4zM4 10h16M8 15h3" {...common} />;
      case "profile":
        return <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21a7 7 0 0 1 14 0" {...common} />;
      case "admin":
        return (
          <path d="M12 3l7 3v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6zM9 12l2 2 4-5" {...common} />
        );
    }
  })();
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
      {path}
    </svg>
  );
}

function ProductLink({
  item,
  active,
  onNavigate,
  compact = false,
}: {
  readonly item: NavigationItem;
  readonly active: boolean;
  readonly onNavigate: Navigate;
  readonly compact?: boolean;
}): React.JSX.Element {
  return (
    <a
      className={compact ? "mobile-navigation__link" : "product-navigation__link"}
      data-active={active}
      href={applicationRoutePath(item.route)}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onNavigate(item.route);
      }}
    >
      <ShellIcon name={item.icon} />
      <span>{item.label}</span>
    </a>
  );
}

function ConnectionState({ readiness }: { readonly readiness: ReadinessView }): React.JSX.Element {
  const label =
    readiness === "ready"
      ? "Connected"
      : readiness === "checking"
        ? "Connecting"
        : readiness === "not_ready"
          ? "Starting"
          : "Offline";
  return (
    <span className="product-connection" data-state={readiness}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function Brand(): React.JSX.Element {
  return (
    <span className="product-brand">
      <span className="product-brand__mark" aria-hidden="true">
        A
      </span>
      <span className="product-brand__wordmark">Atlas</span>
      <small>Exchange</small>
    </span>
  );
}

export function ApplicationShell({
  children,
  environment,
  onNavigate,
  readiness,
  route,
  user,
  notifications,
}: ApplicationShellProps): React.JSX.Element {
  const title = routeTitles[route.name];
  const isAdmin = user.roles.includes("admin");
  const navigation = isAdmin
    ? [
        ...primaryNavigation,
        { label: "Admin", route: { name: "admin" } as const, icon: "admin" as const },
      ]
    : primaryNavigation;
  const avatar = user.email.slice(0, 1).toUpperCase();

  return (
    <div className="product-shell">
      <aside className="product-sidebar" aria-label="Atlas navigation">
        <a
          className="product-sidebar__brand-link"
          href={applicationRoutePath({ name: "dashboard" })}
          onClick={(event) => {
            event.preventDefault();
            onNavigate({ name: "dashboard" });
          }}
        >
          <Brand />
        </a>
        <nav className="product-navigation" aria-label="Primary navigation">
          {navigation.map((item) => (
            <ProductLink
              key={item.route.name}
              item={item}
              active={item.route.name === route.name}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
        <div className="product-sidebar__footer">
          <span className="simulation-label">Simulation only</span>
          <p>No real assets or orders leave Atlas.</p>
        </div>
      </aside>

      <div className="product-shell__main">
        <header className="product-topbar">
          <div className="product-topbar__context">
            <span className="product-topbar__mobile-brand">
              <Brand />
            </span>
            <div>
              <span>{title.context}</span>
              <h1>{title.title}</h1>
            </div>
          </div>
          <div className="product-topbar__actions">
            {environment === "demo" ? <span className="simulation-label">Demo</span> : null}
            <ConnectionState readiness={readiness} />
            {notifications}
            <a
              className="product-profile-link"
              data-active={route.name === "profile"}
              href={applicationRoutePath({ name: "profile" })}
              aria-label={`Open profile for ${user.email}`}
              onClick={(event) => {
                event.preventDefault();
                onNavigate({ name: "profile" });
              }}
            >
              <span className="product-profile-link__avatar" aria-hidden="true">
                {avatar}
              </span>
              <span className="product-profile-link__identity">
                <strong>{user.email}</strong>
                <small>{isAdmin ? "Administrator" : "Investor"}</small>
              </span>
            </a>
          </div>
        </header>

        <main className="product-content" id="main-content">
          {children}
        </main>
      </div>

      <nav className="mobile-navigation" aria-label="Mobile navigation">
        {primaryNavigation.slice(0, 5).map((item) => (
          <ProductLink
            key={item.route.name}
            item={item}
            active={item.route.name === route.name}
            onNavigate={onNavigate}
            compact
          />
        ))}
      </nav>
    </div>
  );
}

export function PublicApplicationShell({
  children,
  environment,
}: {
  readonly children: React.ReactNode;
  readonly environment: ApplicationShellProps["environment"];
}): React.JSX.Element {
  return (
    <main className="public-application">
      <section className="public-application__introduction">
        <Brand />
        {environment === "demo" ? (
          <span className="simulation-label">Private demo · Simulation</span>
        ) : null}
        <div>
          <p className="public-application__eyebrow">Secure trading workspace</p>
          <h1>Trade with clarity.</h1>
          <p>
            Server-confirmed sessions, exact balances, and transparent simulated execution in one
            focused workspace.
          </p>
        </div>
        <ul>
          <li>Live external reference market data</li>
          <li>Simulated orders and financial activity</li>
          <li>No browser token storage</li>
        </ul>
      </section>
      <div className="public-application__content">{children}</div>
    </main>
  );
}
