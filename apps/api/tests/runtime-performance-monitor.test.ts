import type { EventLoopUtilization } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  RuntimePerformanceMonitor,
  type RuntimePerformanceMonitorDependencies,
} from "../src/platform/observability/runtime-performance-monitor.js";

function utilization(idle: number, active: number, value: number): EventLoopUtilization {
  return { idle, active, utilization: value };
}

describe("RuntimePerformanceMonitor", () => {
  it("supports the pinned Node runtime performance source", async () => {
    const monitor = new RuntimePerformanceMonitor();

    await monitor.start();
    expect(Object.values(monitor.snapshot()).every(Number.isFinite)).toBe(true);
    await monitor.stop();
  });

  it("measures one bounded interval and resets delay observations after each snapshot", async () => {
    const delayRecorder = {
      mean: 10_000_000,
      max: 50_000_000,
      enable: vi.fn(() => true),
      disable: vi.fn(() => true),
      percentile: vi.fn(() => 25_000_000),
      reset: vi.fn(),
    };
    const baseline = utilization(10, 10, 0.5);
    const current = utilization(20, 30, 0.6);
    const interval = utilization(10, 20, 2 / 3);
    const eventLoopUtilization = vi
      .fn<RuntimePerformanceMonitorDependencies["eventLoopUtilization"]>()
      .mockReturnValueOnce(baseline)
      .mockReturnValueOnce(current)
      .mockReturnValueOnce(interval);
    const monitor = new RuntimePerformanceMonitor({ delayRecorder, eventLoopUtilization });

    expect(monitor.snapshot()).toEqual({
      eventLoopUtilization: 0,
      eventLoopDelayMeanSeconds: 0,
      eventLoopDelayP99Seconds: 0,
      eventLoopDelayMaximumSeconds: 0,
    });
    await monitor.start();
    await monitor.start();

    expect(monitor.snapshot()).toEqual({
      eventLoopUtilization: 2 / 3,
      eventLoopDelayMeanSeconds: 0.01,
      eventLoopDelayP99Seconds: 0.025,
      eventLoopDelayMaximumSeconds: 0.05,
    });
    expect(eventLoopUtilization).toHaveBeenNthCalledWith(3, current, baseline);
    expect(delayRecorder.enable).toHaveBeenCalledOnce();
    expect(delayRecorder.percentile).toHaveBeenCalledWith(99);
    expect(delayRecorder.reset).toHaveBeenCalledTimes(2);

    await monitor.stop();
    await monitor.stop();
    expect(delayRecorder.disable).toHaveBeenCalledOnce();
  });

  it("normalizes unavailable delay and utilization values for Prometheus", async () => {
    const delayRecorder = {
      mean: Number.NaN,
      max: Number.POSITIVE_INFINITY,
      enable: () => true,
      disable: () => true,
      percentile: () => Number.NaN,
      reset: vi.fn(),
    };
    const eventLoopUtilization = vi
      .fn<RuntimePerformanceMonitorDependencies["eventLoopUtilization"]>()
      .mockReturnValueOnce(utilization(0, 0, 0))
      .mockReturnValueOnce(utilization(1, 1, 0.5))
      .mockReturnValueOnce(utilization(1, 1, Number.NaN));
    const monitor = new RuntimePerformanceMonitor({ delayRecorder, eventLoopUtilization });

    await monitor.start();
    expect(monitor.snapshot()).toEqual({
      eventLoopUtilization: 0,
      eventLoopDelayMeanSeconds: 0,
      eventLoopDelayP99Seconds: 0,
      eventLoopDelayMaximumSeconds: 0,
    });
    await monitor.stop();
  });
});
