import type { LifecycleState, ReadinessDependency } from "./lifecycle-state.js";

export interface RuntimeDatabase extends ReadinessDependency {
  close(): Promise<void>;
}

export interface ManagedRuntime {
  readonly lifecycle: LifecycleState;
  readonly database: RuntimeDatabase;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  forceCloseConnections(): void;
}

export interface CleanupResult {
  readonly wasForced: boolean;
  readonly errors: readonly Error[];
}

export class LifecycleTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(`${operation} exceeded its ${timeoutMs}ms deadline`);
    this.name = "LifecycleTimeoutError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown lifecycle failure");
}

export async function runWithDeadline<T>(
  operation: string,
  timeoutMs: number,
  action: () => Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new LifecycleTimeoutError(operation, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([action(), deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function bestEffort(
  operation: string,
  timeoutMs: number,
  action: () => Promise<void>,
): Promise<Error | undefined> {
  try {
    await runWithDeadline(operation, timeoutMs, action);
    return undefined;
  } catch (error) {
    return toError(error);
  }
}

export async function startRuntime(
  runtime: ManagedRuntime,
  cleanupTimeoutMs: number,
): Promise<void> {
  try {
    if (!(await runtime.database.checkReadiness())) {
      throw new Error(
        "PostgreSQL is unavailable or its schema is incompatible. Run migrations first.",
      );
    }

    await runtime.startListening();
    runtime.lifecycle.markStartupComplete();
  } catch (startupError) {
    runtime.lifecycle.beginShutdown();
    await bestEffort("startup HTTP cleanup", cleanupTimeoutMs, () => runtime.stopListening());
    await bestEffort("startup database cleanup", cleanupTimeoutMs, () => runtime.database.close());
    throw startupError;
  }
}

export async function shutdownRuntime(
  runtime: ManagedRuntime,
  shutdownTimeoutMs: number,
): Promise<CleanupResult> {
  runtime.lifecycle.beginShutdown();
  const errors: Error[] = [];
  let wasForced = false;

  const httpError = await bestEffort("HTTP shutdown", shutdownTimeoutMs, () =>
    runtime.stopListening(),
  );
  if (httpError !== undefined) {
    errors.push(httpError);
    wasForced = true;
    runtime.forceCloseConnections();
  }

  const databaseError = await bestEffort("database shutdown", shutdownTimeoutMs, () =>
    runtime.database.close(),
  );
  if (databaseError !== undefined) {
    errors.push(databaseError);
    wasForced = true;
  }

  return { wasForced, errors };
}

export function createSingleFlightShutdown(
  shutdown: () => Promise<CleanupResult>,
): () => Promise<CleanupResult> {
  let activeShutdown: Promise<CleanupResult> | undefined;
  return () => {
    activeShutdown ??= shutdown();
    return activeShutdown;
  };
}
