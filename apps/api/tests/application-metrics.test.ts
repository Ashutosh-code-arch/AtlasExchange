import { describe, expect, it } from "vitest";

import { ApplicationMetrics } from "../src/platform/observability/application-metrics.js";

const memoryUsage: NodeJS.MemoryUsage = {
  rss: 1_024,
  heapTotal: 768,
  heapUsed: 512,
  external: 128,
  arrayBuffers: 64,
};

describe("ApplicationMetrics", () => {
  it("exports deterministic process, request, duration, and admission metrics", () => {
    const metrics = new ApplicationMetrics({
      applicationVersion: "0.1.0",
      uptimeSeconds: () => 42,
      memoryUsage: () => memoryUsage,
    });

    metrics.observeHttpRequest({
      method: "GET",
      originalUrl: "/api/v1/wallets/00000000-0000-4000-8000-000000000001?include=balance",
      statusCode: 200,
      durationSeconds: 0.02,
    });
    metrics.observeHttpRequest({
      method: "GET",
      originalUrl: "/api/v1/wallets/private-owner-value",
      statusCode: 200,
      durationSeconds: 0.3,
    });
    metrics.recordAdmissionRejection({
      requestClass: "mutation",
      reason: "request_limit",
    });
    metrics.setDatabasePoolSnapshotProvider(() => ({
      maximumConnections: 10,
      totalConnections: 7,
      idleConnections: 2,
      activeConnections: 5,
      waitingRequests: 3,
    }));
    metrics.recordDatabasePoolEvent("connect");
    metrics.recordDatabasePoolEvent("connect");
    metrics.recordDatabasePoolEvent("error");
    metrics.setRuntimePerformanceSnapshotProvider(() => ({
      eventLoopUtilization: 0.75,
      eventLoopDelayMeanSeconds: 0.005,
      eventLoopDelayP99Seconds: 0.025,
      eventLoopDelayMaximumSeconds: 0.05,
    }));
    metrics.setMarketDataProjectionSnapshotProvider(() => ({
      running: true,
      markets: [
        {
          state: "caught_up",
          lag: 0n,
          consecutiveFailures: 0,
          lastSuccessAt: new Date("2026-08-30T10:00:00.000Z"),
          lastFailureAt: null,
        },
        {
          state: "failed",
          lag: 12n,
          consecutiveFailures: 3,
          lastSuccessAt: new Date("2026-08-30T09:55:00.000Z"),
          lastFailureAt: new Date("2026-08-30T10:01:00.000Z"),
        },
      ],
    }));

    const output = metrics.render();
    expect(output).toContain('atlas_build_info{version="0.1.0"} 1');
    expect(output).toContain("atlas_process_uptime_seconds 42");
    expect(output).toContain("atlas_process_resident_memory_bytes 1024");
    expect(output).toContain("atlas_nodejs_heap_used_bytes 512");
    expect(output).toContain(
      'atlas_http_requests_total{method="GET",route_group="financial",status_class="2xx"} 2',
    );
    expect(output).toContain(
      'atlas_http_request_duration_seconds_bucket{le="0.025",method="GET",route_group="financial",status_class="2xx"} 1',
    );
    expect(output).toContain(
      'atlas_http_request_duration_seconds_bucket{le="+Inf",method="GET",route_group="financial",status_class="2xx"} 2',
    );
    expect(output).toContain(
      'atlas_http_admission_rejections_total{reason="request_limit",request_class="mutation"} 1',
    );
    expect(output).toContain('atlas_database_pool_connections{state="active"} 5');
    expect(output).toContain('atlas_database_pool_connections{state="idle"} 2');
    expect(output).toContain('atlas_database_pool_connections{state="total"} 7');
    expect(output).toContain("atlas_database_pool_max_connections 10");
    expect(output).toContain("atlas_database_pool_waiting_requests 3");
    expect(output).toContain('atlas_database_pool_events_total{event="connect"} 2');
    expect(output).toContain('atlas_database_pool_events_total{event="error"} 1');
    expect(output).toContain('atlas_database_pool_events_total{event="remove"} 0');
    expect(output).toContain("atlas_nodejs_event_loop_utilization 0.75");
    expect(output).toContain("atlas_nodejs_event_loop_delay_mean_seconds 0.005");
    expect(output).toContain("atlas_nodejs_event_loop_delay_p99_seconds 0.025");
    expect(output).toContain("atlas_nodejs_event_loop_delay_max_seconds 0.05");
    expect(output).toContain("atlas_market_data_projection_running 1");
    expect(output).toContain('atlas_market_data_projection_markets{state="caught_up"} 1');
    expect(output).toContain('atlas_market_data_projection_markets{state="failed"} 1');
    expect(output).toContain('atlas_market_data_projection_markets{state="behind"} 0');
    expect(output).toContain("atlas_market_data_projection_max_lag 12");
    expect(output).toContain("atlas_market_data_projection_max_consecutive_failures 3");
    expect(output).toContain(
      `atlas_market_data_projection_oldest_success_timestamp_seconds ${Date.parse("2026-08-30T09:55:00.000Z") / 1_000}`,
    );
    expect(output).toContain(
      `atlas_market_data_projection_last_failure_timestamp_seconds ${Date.parse("2026-08-30T10:01:00.000Z") / 1_000}`,
    );
    expect(output).not.toContain("private-owner-value");
    expect(output).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("normalizes arbitrary methods, routes, and status values into bounded labels", () => {
    const metrics = new ApplicationMetrics({
      applicationVersion: 'release"candidate\\one',
      uptimeSeconds: () => 0,
      memoryUsage: () => memoryUsage,
    });

    metrics.observeHttpRequest({
      method: "CUSTOM-UNBOUNDED-METHOD",
      originalUrl: "/api/v1/private-value-not-a-route",
      statusCode: 799,
      durationSeconds: 6,
    });

    const output = metrics.render();
    expect(output).toContain('version="release\\"candidate\\\\one"');
    expect(output).toContain(
      'atlas_http_requests_total{method="OTHER",route_group="other",status_class="unknown"} 1',
    );
    expect(output).not.toContain("CUSTOM-UNBOUNDED-METHOD");
    expect(output).not.toContain("private-value-not-a-route");
    expect(output).not.toContain("atlas_nodejs_event_loop_utilization");
    expect(output).not.toContain("atlas_market_data_projection_running");
  });
});
