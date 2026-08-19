import { createServer, type Server } from "node:http";

import type { Logger } from "pino";

import { createApp } from "./app.js";
import { parseApiConfig } from "./config/config.js";
import { createDatabaseResources, type DatabaseResources } from "./platform/database/database.js";
import { LifecycleState } from "./platform/lifecycle/lifecycle-state.js";
import {
  createSingleFlightShutdown,
  type ManagedRuntime,
  runWithDeadline,
  shutdownRuntime,
  startRuntime,
} from "./platform/lifecycle/process-lifecycle.js";
import { createLogger } from "./platform/logging/logger.js";

interface RunningServer extends ManagedRuntime {
  readonly server: Server;
  readonly database: DatabaseResources;
  readonly logger: Logger;
  readonly shutdownTimeoutMs: number;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function start(): Promise<RunningServer> {
  const config = parseApiConfig(process.env);
  const logger = createLogger(config.logging);
  logger.info({ event: "api.starting" }, "Atlas API starting");

  const database = createDatabaseResources(
    config.database.url,
    config.database.expectedSchemaVersion,
    (error) => {
      logger.error(
        {
          event: "database.connection.failed",
          databaseError: {
            name: error.name,
            message: error.message,
            code: "code" in error && typeof error.code === "string" ? error.code : "DATABASE_ERROR",
          },
        },
        "Idle PostgreSQL connection failed",
      );
    },
  );
  const lifecycle = new LifecycleState(database);
  let runtime: RunningServer | undefined;

  try {
    const app = createApp({
      lifecycle,
      logger,
      webOrigin: config.http.webOrigin,
      applicationVersion: config.logging.applicationVersion,
    });
    const server = createServer(app);
    runtime = {
      server,
      lifecycle,
      database,
      logger,
      shutdownTimeoutMs: config.http.shutdownTimeoutMs,
      startListening: () => listen(server, config.http.port),
      stopListening: () => closeServer(server),
      forceCloseConnections: () => server.closeAllConnections(),
    };
  } catch (error) {
    await runWithDeadline("startup database cleanup", config.http.shutdownTimeoutMs, () =>
      database.close(),
    ).catch(() => undefined);
    throw error;
  }

  await startRuntime(runtime, config.http.shutdownTimeoutMs);
  logger.info({ event: "api.listening", port: config.http.port }, "Atlas API ready");

  return runtime;
}

function createProcessShutdown(
  running: RunningServer,
): (reason: string, exitCode: number) => Promise<void> {
  const executeShutdown = createSingleFlightShutdown(() =>
    shutdownRuntime(running, running.shutdownTimeoutMs),
  );

  return async (reason: string, exitCode: number): Promise<void> => {
    running.lifecycle.beginShutdown();
    running.logger.info({ event: "api.shutdown.started", reason }, "Atlas API shutting down");
    const result = await executeShutdown();

    if (result.wasForced) {
      running.logger.fatal(
        { event: "api.shutdown.forced", errors: result.errors },
        "Forced API shutdown",
      );
      process.exitCode = 1;
    } else {
      running.logger.info({ event: "api.shutdown.completed" }, "Atlas API stopped");
      process.exitCode ??= exitCode;
    }
  };
}

start()
  .then((running) => {
    const shutdown = createProcessShutdown(running);
    process.once("SIGINT", () => void shutdown("SIGINT", 0));
    process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
    process.once("uncaughtException", (error) => {
      running.logger.fatal(
        { event: "process.uncaught_exception", err: error },
        "Uncaught exception",
      );
      void shutdown("uncaughtException", 1);
    });
    process.once("unhandledRejection", (error) => {
      running.logger.fatal(
        { event: "process.unhandled_rejection", err: error },
        "Unhandled rejection",
      );
      void shutdown("unhandledRejection", 1);
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Atlas API failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
