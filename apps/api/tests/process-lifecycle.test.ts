import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import {
  createSingleFlightShutdown,
  type ManagedWorker,
  type ManagedRuntime,
  shutdownRuntime,
  startRuntime,
} from "../src/platform/lifecycle/process-lifecycle.js";

interface RuntimeHarness {
  readonly runtime: ManagedRuntime;
  readonly checkReadiness: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  readonly closeDatabase: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly startListening: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly stopListening: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly forceCloseConnections: ReturnType<typeof vi.fn<() => void>>;
}

function createRuntimeHarness(workers: readonly ManagedWorker[] = []): RuntimeHarness {
  const checkReadiness = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const closeDatabase = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const startListening = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const stopListening = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const forceCloseConnections = vi.fn<() => void>();
  const database = { checkReadiness, close: closeDatabase };

  return {
    runtime: {
      lifecycle: new LifecycleState(database),
      database,
      workers,
      startListening,
      stopListening,
      forceCloseConnections,
    },
    checkReadiness,
    closeDatabase,
    startListening,
    stopListening,
    forceCloseConnections,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("process lifecycle", () => {
  it("closes HTTP and database resources when listen fails", async () => {
    const harness = createRuntimeHarness();
    const addressError = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    harness.startListening.mockRejectedValue(addressError);

    await expect(startRuntime(harness.runtime, 100)).rejects.toBe(addressError);

    expect(harness.stopListening).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
    await expect(harness.runtime.lifecycle.isReady()).resolves.toBe(false);
  });

  it("cleans up the database when the initial readiness check fails", async () => {
    const harness = createRuntimeHarness();
    harness.checkReadiness.mockResolvedValue(false);

    await expect(startRuntime(harness.runtime, 100)).rejects.toThrow(/schema is incompatible/);

    expect(harness.startListening).not.toHaveBeenCalled();
    expect(harness.stopListening).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
  });

  it("starts workers before HTTP and stops them before closing the database", async () => {
    const startWorker = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stopWorker = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const harness = createRuntimeHarness([{ start: startWorker, stop: stopWorker }]);

    await startRuntime(harness.runtime, 100);
    expect(startWorker.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startListening.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    await shutdownRuntime(harness.runtime, 100);
    expect(harness.stopListening.mock.invocationCallOrder[0]).toBeLessThan(
      stopWorker.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(stopWorker.mock.invocationCallOrder[0]).toBeLessThan(
      harness.closeDatabase.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("stops a worker whose startup fails before cleaning up the database", async () => {
    const startupError = new Error("worker startup failed");
    const startWorker = vi.fn<() => Promise<void>>().mockRejectedValue(startupError);
    const stopWorker = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const harness = createRuntimeHarness([{ start: startWorker, stop: stopWorker }]);

    await expect(startRuntime(harness.runtime, 100)).rejects.toBe(startupError);

    expect(harness.startListening).not.toHaveBeenCalled();
    expect(stopWorker).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
  });

  it("stops an active worker when HTTP startup fails", async () => {
    const startWorker = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stopWorker = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const harness = createRuntimeHarness([{ start: startWorker, stop: stopWorker }]);
    harness.startListening.mockRejectedValue(new Error("listen failed"));

    await expect(startRuntime(harness.runtime, 100)).rejects.toThrow("listen failed");

    expect(stopWorker).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
  });

  it("forces HTTP connections closed at the deadline and still closes the database", async () => {
    vi.useFakeTimers();
    const harness = createRuntimeHarness();
    harness.stopListening.mockReturnValue(new Promise(() => undefined));

    const shutdown = shutdownRuntime(harness.runtime, 50);
    await vi.advanceTimersByTimeAsync(50);
    const result = await shutdown;

    expect(result.wasForced).toBe(true);
    expect(result.errors[0]?.name).toBe("LifecycleTimeoutError");
    expect(harness.forceCloseConnections).toHaveBeenCalledOnce();
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
  });

  it("bounds a database close that never settles", async () => {
    vi.useFakeTimers();
    const harness = createRuntimeHarness();
    harness.closeDatabase.mockReturnValue(new Promise(() => undefined));

    const shutdown = shutdownRuntime(harness.runtime, 50);
    await vi.advanceTimersByTimeAsync(50);
    const result = await shutdown;

    expect(result.wasForced).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(harness.closeDatabase).toHaveBeenCalledOnce();
  });

  it("executes cleanup only once for repeated shutdown requests", async () => {
    const shutdownTask = vi
      .fn<() => Promise<{ wasForced: boolean; errors: readonly Error[] }>>()
      .mockResolvedValue({ wasForced: false, errors: [] });
    const shutdown = createSingleFlightShutdown(shutdownTask);

    const first = shutdown();
    const second = shutdown();

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ wasForced: false, errors: [] });
    expect(shutdownTask).toHaveBeenCalledOnce();
  });
});
