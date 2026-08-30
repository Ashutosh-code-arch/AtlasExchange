import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

export interface RuntimePerformanceSnapshot {
  readonly eventLoopUtilization: number;
  readonly eventLoopDelayMeanSeconds: number;
  readonly eventLoopDelayP99Seconds: number;
  readonly eventLoopDelayMaximumSeconds: number;
}

interface EventLoopDelayRecorder {
  readonly mean: number;
  readonly max: number;
  enable(): boolean;
  disable(): boolean;
  percentile(percentile: number): number;
  reset(): void;
}

type EventLoopUtilizationReader = (
  utilization1?: EventLoopUtilization,
  utilization2?: EventLoopUtilization,
) => EventLoopUtilization;

export interface RuntimePerformanceMonitorDependencies {
  readonly delayRecorder: EventLoopDelayRecorder;
  readonly eventLoopUtilization: EventLoopUtilizationReader;
}

const nanosecondsPerSecond = 1_000_000_000;

function secondsFromNanoseconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value / nanosecondsPerSecond : 0;
}

function normalizedUtilization(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function systemDependencies(): RuntimePerformanceMonitorDependencies {
  return {
    delayRecorder: monitorEventLoopDelay({ resolution: 20 }),
    eventLoopUtilization: (utilization1, utilization2) =>
      performance.eventLoopUtilization(utilization1, utilization2),
  };
}

export class RuntimePerformanceMonitor {
  private readonly dependencies: RuntimePerformanceMonitorDependencies;
  private running = false;
  private previousUtilization: EventLoopUtilization | undefined;

  public constructor(dependencies: RuntimePerformanceMonitorDependencies = systemDependencies()) {
    this.dependencies = dependencies;
  }

  public start(): Promise<void> {
    if (!this.running) {
      this.previousUtilization = this.dependencies.eventLoopUtilization();
      this.dependencies.delayRecorder.reset();
      this.dependencies.delayRecorder.enable();
      this.running = true;
    }
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    if (this.running) {
      this.dependencies.delayRecorder.disable();
      this.running = false;
      this.previousUtilization = undefined;
    }
    return Promise.resolve();
  }

  public snapshot(): RuntimePerformanceSnapshot {
    if (!this.running || this.previousUtilization === undefined) {
      return {
        eventLoopUtilization: 0,
        eventLoopDelayMeanSeconds: 0,
        eventLoopDelayP99Seconds: 0,
        eventLoopDelayMaximumSeconds: 0,
      };
    }

    const currentUtilization = this.dependencies.eventLoopUtilization();
    const intervalUtilization = this.dependencies.eventLoopUtilization(
      currentUtilization,
      this.previousUtilization,
    );
    this.previousUtilization = currentUtilization;

    const snapshot = {
      eventLoopUtilization: normalizedUtilization(intervalUtilization.utilization),
      eventLoopDelayMeanSeconds: secondsFromNanoseconds(this.dependencies.delayRecorder.mean),
      eventLoopDelayP99Seconds: secondsFromNanoseconds(
        this.dependencies.delayRecorder.percentile(99),
      ),
      eventLoopDelayMaximumSeconds: secondsFromNanoseconds(this.dependencies.delayRecorder.max),
    };
    this.dependencies.delayRecorder.reset();
    return snapshot;
  }
}
