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
  });
});
