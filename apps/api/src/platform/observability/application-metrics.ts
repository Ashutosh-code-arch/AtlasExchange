const durationBucketsSeconds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";
type HttpRouteGroup =
  | "identity"
  | "financial"
  | "trading"
  | "market_data"
  | "portfolio"
  | "notifications"
  | "administration"
  | "status"
  | "other";
type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";
type AdmissionClass = "read" | "mutation";
type AdmissionRejectionReason = "request_limit" | "tracking_capacity";
type DatabasePoolEvent = "connect" | "error" | "remove";
type MarketDataProjectionState = "behind" | "caught_up" | "failed" | "starting" | "stopped";

interface HttpSeries {
  count: number;
  durationSumSeconds: number;
  readonly bucketCounts: number[];
  readonly method: HttpMethod;
  readonly routeGroup: HttpRouteGroup;
  readonly statusClass: HttpStatusClass;
}

export interface ApplicationMetricsOptions {
  readonly applicationVersion: string;
  readonly uptimeSeconds?: () => number;
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
}

export interface HttpRequestMetric {
  readonly method: string;
  readonly originalUrl: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

export interface AdmissionRejectionMetric {
  readonly requestClass: AdmissionClass;
  readonly reason: AdmissionRejectionReason;
}

export interface DatabasePoolMetricSnapshot {
  readonly maximumConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingRequests: number;
}

export interface RuntimePerformanceMetricSnapshot {
  readonly eventLoopUtilization: number;
  readonly eventLoopDelayMeanSeconds: number;
  readonly eventLoopDelayP99Seconds: number;
  readonly eventLoopDelayMaximumSeconds: number;
}

export interface MarketDataProjectionMetricSnapshot {
  readonly running: boolean;
  readonly markets: readonly Readonly<{
    state: MarketDataProjectionState;
    lag: bigint;
    consecutiveFailures: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
  }>[];
}

export const prometheusTextContentType = "text/plain; version=0.0.4; charset=utf-8";

function normalizeMethod(method: string): HttpMethod {
  switch (method) {
    case "GET":
    case "HEAD":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS":
      return method;
    default:
      return "OTHER";
  }
}

function routeGroup(originalUrl: string): HttpRouteGroup {
  const path = originalUrl.split("?", 1)[0] ?? "";
  if (/^\/api\/v1\/auth(?:\/|$)/.test(path)) return "identity";
  if (
    /^\/api\/v1\/(?:assets|wallets|simulated-deposits|simulated-withdrawals)(?:\/|$)/.test(path)
  ) {
    return "financial";
  }
  if (/^\/api\/v1\/portfolio(?:\/|$)/.test(path)) return "portfolio";
  if (/^\/api\/v1\/notifications(?:\/|$)/.test(path)) return "notifications";
  if (/^\/api\/v1\/administration(?:\/|$)/.test(path)) return "administration";
  if (/^\/api\/v1\/markets\/[^/]+\/(?:order-book|ticker|candles)(?:\/|$)/.test(path)) {
    return "market_data";
  }
  if (/^\/api\/v1\/(?:markets|orders|trades)(?:\/|$)/.test(path)) return "trading";
  if (path === "/api/v1/status") return "status";
  return "other";
}

function statusClass(statusCode: number): HttpStatusClass {
  if (statusCode >= 100 && statusCode < 200) return "1xx";
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "unknown";
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(",")}}`;
}

function seriesKey(method: HttpMethod, group: HttpRouteGroup, result: HttpStatusClass): string {
  return `${method}|${group}|${result}`;
}

function timestampSeconds(value: Date): number {
  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1_000 : 0;
}

export class ApplicationMetrics {
  private readonly httpSeries = new Map<string, HttpSeries>();
  private readonly admissionRejections = new Map<string, number>();
  private readonly databasePoolEvents = new Map<DatabasePoolEvent, number>();
  private readonly uptimeSeconds: () => number;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private databasePoolSnapshotProvider: (() => DatabasePoolMetricSnapshot) | undefined;
  private runtimePerformanceSnapshotProvider: (() => RuntimePerformanceMetricSnapshot) | undefined;
  private marketDataProjectionSnapshotProvider:
    (() => MarketDataProjectionMetricSnapshot) | undefined;

  public constructor(private readonly options: ApplicationMetricsOptions) {
    this.uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  }

  public observeHttpRequest(metric: HttpRequestMetric): void {
    const method = normalizeMethod(metric.method);
    const group = routeGroup(metric.originalUrl);
    const result = statusClass(metric.statusCode);
    const key = seriesKey(method, group, result);
    const series = this.httpSeries.get(key) ?? {
      count: 0,
      durationSumSeconds: 0,
      bucketCounts: durationBucketsSeconds.map(() => 0),
      method,
      routeGroup: group,
      statusClass: result,
    };

    series.count += 1;
    series.durationSumSeconds += metric.durationSeconds;
    durationBucketsSeconds.forEach((upperBound, index) => {
      if (metric.durationSeconds <= upperBound) {
        series.bucketCounts[index] = (series.bucketCounts[index] ?? 0) + 1;
      }
    });
    this.httpSeries.set(key, series);
  }

  public recordAdmissionRejection(metric: AdmissionRejectionMetric): void {
    const key = `${metric.requestClass}|${metric.reason}`;
    this.admissionRejections.set(key, (this.admissionRejections.get(key) ?? 0) + 1);
  }

  public setDatabasePoolSnapshotProvider(provider: () => DatabasePoolMetricSnapshot): void {
    this.databasePoolSnapshotProvider = provider;
  }

  public recordDatabasePoolEvent(event: DatabasePoolEvent): void {
    this.databasePoolEvents.set(event, (this.databasePoolEvents.get(event) ?? 0) + 1);
  }

  public setRuntimePerformanceSnapshotProvider(
    provider: () => RuntimePerformanceMetricSnapshot,
  ): void {
    this.runtimePerformanceSnapshotProvider = provider;
  }

  public setMarketDataProjectionSnapshotProvider(
    provider: () => MarketDataProjectionMetricSnapshot,
  ): void {
    this.marketDataProjectionSnapshotProvider = provider;
  }

  public render(): string {
    const lines: string[] = [];
    lines.push(
      "# HELP atlas_build_info Atlas API build information.",
      "# TYPE atlas_build_info gauge",
      `atlas_build_info${labels({ version: this.options.applicationVersion })} 1`,
      "# HELP atlas_process_uptime_seconds Atlas API process uptime in seconds.",
      "# TYPE atlas_process_uptime_seconds gauge",
      `atlas_process_uptime_seconds ${this.uptimeSeconds()}`,
    );

    const memory = this.memoryUsage();
    lines.push(
      "# HELP atlas_process_resident_memory_bytes Atlas API resident memory in bytes.",
      "# TYPE atlas_process_resident_memory_bytes gauge",
      `atlas_process_resident_memory_bytes ${memory.rss}`,
      "# HELP atlas_nodejs_heap_used_bytes Atlas API Node.js heap used in bytes.",
      "# TYPE atlas_nodejs_heap_used_bytes gauge",
      `atlas_nodejs_heap_used_bytes ${memory.heapUsed}`,
      "# HELP atlas_http_requests_total Completed Atlas API HTTP requests.",
      "# TYPE atlas_http_requests_total counter",
    );

    const series = [...this.httpSeries.values()].sort((left, right) =>
      seriesKey(left.method, left.routeGroup, left.statusClass).localeCompare(
        seriesKey(right.method, right.routeGroup, right.statusClass),
      ),
    );
    for (const item of series) {
      const baseLabels = {
        method: item.method,
        route_group: item.routeGroup,
        status_class: item.statusClass,
      };
      lines.push(`atlas_http_requests_total${labels(baseLabels)} ${item.count}`);
    }

    lines.push(
      "# HELP atlas_http_request_duration_seconds Atlas API HTTP request duration in seconds.",
      "# TYPE atlas_http_request_duration_seconds histogram",
    );
    for (const item of series) {
      const baseLabels = {
        method: item.method,
        route_group: item.routeGroup,
        status_class: item.statusClass,
      };
      durationBucketsSeconds.forEach((upperBound, index) => {
        lines.push(
          `atlas_http_request_duration_seconds_bucket${labels({ ...baseLabels, le: String(upperBound) })} ${item.bucketCounts[index] ?? 0}`,
        );
      });
      lines.push(
        `atlas_http_request_duration_seconds_bucket${labels({ ...baseLabels, le: "+Inf" })} ${item.count}`,
        `atlas_http_request_duration_seconds_sum${labels(baseLabels)} ${item.durationSumSeconds}`,
        `atlas_http_request_duration_seconds_count${labels(baseLabels)} ${item.count}`,
      );
    }

    lines.push(
      "# HELP atlas_http_admission_rejections_total Rejected Atlas API admission attempts.",
      "# TYPE atlas_http_admission_rejections_total counter",
    );
    for (const [key, count] of [...this.admissionRejections.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const [requestClass = "mutation", reason = "request_limit"] = key.split("|");
      lines.push(
        `atlas_http_admission_rejections_total${labels({ reason, request_class: requestClass })} ${count}`,
      );
    }

    const databasePool = this.databasePoolSnapshotProvider?.();
    if (databasePool !== undefined) {
      lines.push(
        "# HELP atlas_database_pool_connections PostgreSQL pool connections by state.",
        "# TYPE atlas_database_pool_connections gauge",
        `atlas_database_pool_connections${labels({ state: "active" })} ${databasePool.activeConnections}`,
        `atlas_database_pool_connections${labels({ state: "idle" })} ${databasePool.idleConnections}`,
        `atlas_database_pool_connections${labels({ state: "total" })} ${databasePool.totalConnections}`,
        "# HELP atlas_database_pool_max_connections Configured PostgreSQL pool connection limit.",
        "# TYPE atlas_database_pool_max_connections gauge",
        `atlas_database_pool_max_connections ${databasePool.maximumConnections}`,
        "# HELP atlas_database_pool_waiting_requests PostgreSQL requests waiting for a pooled connection.",
        "# TYPE atlas_database_pool_waiting_requests gauge",
        `atlas_database_pool_waiting_requests ${databasePool.waitingRequests}`,
        "# HELP atlas_database_pool_events_total PostgreSQL pool lifecycle events.",
        "# TYPE atlas_database_pool_events_total counter",
      );
      for (const event of ["connect", "error", "remove"] as const) {
        lines.push(
          `atlas_database_pool_events_total${labels({ event })} ${this.databasePoolEvents.get(event) ?? 0}`,
        );
      }
    }

    const runtimePerformance = this.runtimePerformanceSnapshotProvider?.();
    if (runtimePerformance !== undefined) {
      lines.push(
        "# HELP atlas_nodejs_event_loop_utilization Event-loop utilization since the previous scrape.",
        "# TYPE atlas_nodejs_event_loop_utilization gauge",
        `atlas_nodejs_event_loop_utilization ${runtimePerformance.eventLoopUtilization}`,
        "# HELP atlas_nodejs_event_loop_delay_mean_seconds Mean event-loop delay since the previous scrape.",
        "# TYPE atlas_nodejs_event_loop_delay_mean_seconds gauge",
        `atlas_nodejs_event_loop_delay_mean_seconds ${runtimePerformance.eventLoopDelayMeanSeconds}`,
        "# HELP atlas_nodejs_event_loop_delay_p99_seconds Event-loop delay p99 since the previous scrape.",
        "# TYPE atlas_nodejs_event_loop_delay_p99_seconds gauge",
        `atlas_nodejs_event_loop_delay_p99_seconds ${runtimePerformance.eventLoopDelayP99Seconds}`,
        "# HELP atlas_nodejs_event_loop_delay_max_seconds Maximum event-loop delay since the previous scrape.",
        "# TYPE atlas_nodejs_event_loop_delay_max_seconds gauge",
        `atlas_nodejs_event_loop_delay_max_seconds ${runtimePerformance.eventLoopDelayMaximumSeconds}`,
      );
    }

    const projection = this.marketDataProjectionSnapshotProvider?.();
    if (projection !== undefined) {
      const states = ["behind", "caught_up", "failed", "starting", "stopped"] as const;
      const stateCounts = new Map<MarketDataProjectionState, number>(
        states.map((state) => [state, 0]),
      );
      let maximumLag = 0n;
      let maximumConsecutiveFailures = 0;
      let oldestSuccessTimestampSeconds = 0;
      let lastFailureTimestampSeconds = 0;
      for (const market of projection.markets) {
        stateCounts.set(market.state, (stateCounts.get(market.state) ?? 0) + 1);
        if (market.lag > maximumLag) maximumLag = market.lag;
        maximumConsecutiveFailures = Math.max(
          maximumConsecutiveFailures,
          market.consecutiveFailures,
        );
        if (market.lastSuccessAt !== null) {
          const observed = timestampSeconds(market.lastSuccessAt);
          if (
            observed > 0 &&
            (oldestSuccessTimestampSeconds === 0 || observed < oldestSuccessTimestampSeconds)
          ) {
            oldestSuccessTimestampSeconds = observed;
          }
        }
        if (market.lastFailureAt !== null) {
          lastFailureTimestampSeconds = Math.max(
            lastFailureTimestampSeconds,
            timestampSeconds(market.lastFailureAt),
          );
        }
      }
      lines.push(
        "# HELP atlas_market_data_projection_running Whether the in-process projection worker is running.",
        "# TYPE atlas_market_data_projection_running gauge",
        `atlas_market_data_projection_running ${projection.running ? 1 : 0}`,
        "# HELP atlas_market_data_projection_markets Market Data projection markets by worker state.",
        "# TYPE atlas_market_data_projection_markets gauge",
      );
      for (const state of states) {
        lines.push(
          `atlas_market_data_projection_markets${labels({ state })} ${stateCounts.get(state) ?? 0}`,
        );
      }
      lines.push(
        "# HELP atlas_market_data_projection_max_lag Maximum publication sequence lag across discovered markets.",
        "# TYPE atlas_market_data_projection_max_lag gauge",
        `atlas_market_data_projection_max_lag ${maximumLag.toString()}`,
        "# HELP atlas_market_data_projection_max_consecutive_failures Maximum consecutive failures across discovered markets.",
        "# TYPE atlas_market_data_projection_max_consecutive_failures gauge",
        `atlas_market_data_projection_max_consecutive_failures ${maximumConsecutiveFailures}`,
        "# HELP atlas_market_data_projection_oldest_success_timestamp_seconds Oldest latest-success timestamp across discovered markets.",
        "# TYPE atlas_market_data_projection_oldest_success_timestamp_seconds gauge",
        `atlas_market_data_projection_oldest_success_timestamp_seconds ${oldestSuccessTimestampSeconds}`,
        "# HELP atlas_market_data_projection_last_failure_timestamp_seconds Latest failure timestamp across discovered markets.",
        "# TYPE atlas_market_data_projection_last_failure_timestamp_seconds gauge",
        `atlas_market_data_projection_last_failure_timestamp_seconds ${lastFailureTimestampSeconds}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}
