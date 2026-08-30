import { createServer, type Server } from "node:http";

import type { Transaction } from "kysely";
import type { Logger } from "pino";

import { createApp } from "./app.js";
import { parseApiConfig } from "./config/config.js";
import {
  createAdministrationModuleRouter,
  type AdministrationDatabaseSchema,
} from "./modules/administration/index.js";
import {
  createAccessAuthentication,
  createIdentityModuleRouter,
  CryptoSessionCsrfTokenService,
  SmtpVerificationEmailDelivery,
  SmtpPasswordResetEmailDelivery,
  type IdentityDatabaseSchema,
} from "./modules/identity/index.js";
import {
  createFinancialModuleRouter,
  type FinancialDatabaseSchema,
} from "./modules/financial/index.js";
import {
  createMarketDataModuleRouter,
  createMarketDataProjectionWorker,
  createMarketDataStreamGateway,
  type MarketDataDatabaseSchema,
} from "./modules/market-data/index.js";
import { createPortfolioModuleRouter } from "./modules/portfolio/index.js";
import {
  createFinancialNotificationPublisher,
  createNotificationModuleRouter,
  type NotificationsDatabaseSchema,
} from "./modules/notifications/index.js";
import { createTradingModuleRouter, type TradingDatabaseSchema } from "./modules/trading/index.js";
import {
  createDatabaseResources,
  type DatabaseResources,
  type DatabaseSchema,
} from "./platform/database/database.js";
import { LifecycleState } from "./platform/lifecycle/lifecycle-state.js";
import {
  createSingleFlightShutdown,
  type ManagedRuntime,
  runWithDeadline,
  shutdownRuntime,
  startRuntime,
} from "./platform/lifecycle/process-lifecycle.js";
import { createLogger } from "./platform/logging/logger.js";
import { ApplicationMetrics } from "./platform/observability/application-metrics.js";
import { RuntimePerformanceMonitor } from "./platform/observability/runtime-performance-monitor.js";
import { applyHttpServerLimits } from "./platform/security/http-server-limits.js";
import { InMemoryHttpRequestRateLimiter } from "./platform/security/http-request-rate-limiter.js";

type AtlasDatabaseSchema = DatabaseSchema &
  AdministrationDatabaseSchema &
  IdentityDatabaseSchema &
  FinancialDatabaseSchema &
  TradingDatabaseSchema &
  MarketDataDatabaseSchema &
  NotificationsDatabaseSchema;

interface RunningServer extends ManagedRuntime {
  readonly server: Server;
  readonly database: DatabaseResources<AtlasDatabaseSchema>;
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
  const metricsConfiguration = config.observability.metrics.enabled
    ? {
        collector: new ApplicationMetrics({
          applicationVersion: config.logging.applicationVersion,
        }),
        bearerToken: config.observability.metrics.bearerToken,
      }
    : undefined;
  const metrics = metricsConfiguration?.collector;
  const runtimePerformanceMonitor =
    metrics === undefined ? undefined : new RuntimePerformanceMonitor();
  if (runtimePerformanceMonitor !== undefined) {
    metrics?.setRuntimePerformanceSnapshotProvider(() => runtimePerformanceMonitor.snapshot());
  }
  logger.info({ event: "api.starting" }, "Atlas API starting");

  const database = createDatabaseResources<AtlasDatabaseSchema>(
    config.database.url,
    config.database.expectedSchemaVersion,
    {
      pool: config.database.pool,
      onPoolConnect: () => metrics?.recordDatabasePoolEvent("connect"),
      onPoolRemove: () => metrics?.recordDatabasePoolEvent("remove"),
      onPoolError: (error) => {
        metrics?.recordDatabasePoolEvent("error");
        logger.error(
          {
            event: "database.connection.failed",
            databaseError: {
              name: error.name,
              message: error.message,
              code:
                "code" in error && typeof error.code === "string" ? error.code : "DATABASE_ERROR",
            },
          },
          "Idle PostgreSQL connection failed",
        );
      },
    },
  );
  metrics?.setDatabasePoolSnapshotProvider(() => database.poolSnapshot());
  const lifecycle = new LifecycleState(database);
  let runtime: RunningServer | undefined;

  try {
    const verificationEmailDelivery = new SmtpVerificationEmailDelivery({
      ...config.identity.emailDelivery,
      webOrigin: config.http.webOrigin,
      logger,
    });
    const passwordResetEmailDelivery = new SmtpPasswordResetEmailDelivery({
      ...config.identity.emailDelivery,
      webOrigin: config.http.webOrigin,
      logger,
    });
    const authenticateAccess = createAccessAuthentication(database.database);
    const sessionCsrfTokenService = new CryptoSessionCsrfTokenService(
      config.identity.sessionSecurity.csrfHmacKey,
    );
    const identityRouter = await createIdentityModuleRouter({
      database: database.database,
      passwordBlocklistPath: config.identity.passwordBlocklistPath,
      verificationEmailDelivery,
      passwordResetEmailDelivery,
      webOrigin: config.http.webOrigin,
      sessionSecurity: config.identity.sessionSecurity,
      authenticateAccess,
      sessionCsrfTokenService,
    });
    const financialRouter = createFinancialModuleRouter({
      database: database.database,
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: config.identity.sessionSecurity.secureCookies,
      webOrigin: config.http.webOrigin,
      simulatedFundingEnabled: config.financial.simulatedFundingEnabled,
      simulatedWithdrawalsEnabled: config.financial.simulatedWithdrawalsEnabled,
      notificationPublisherFactory: (transaction) =>
        createFinancialNotificationPublisher(
          transaction as unknown as Transaction<NotificationsDatabaseSchema>,
        ),
    });
    const tradingRouter = createTradingModuleRouter({
      database: database.database,
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: config.identity.sessionSecurity.secureCookies,
      webOrigin: config.http.webOrigin,
    });
    const marketDataWorker = config.marketData.projection.enabled
      ? createMarketDataProjectionWorker({
          database: database.database,
          logger,
          worker: config.marketData.projection,
        })
      : undefined;
    metrics?.setMarketDataProjectionSnapshotProvider(
      marketDataWorker === undefined
        ? () => ({ running: false, markets: [] })
        : () => marketDataWorker.getStatus(),
    );
    const marketDataRouter = createMarketDataModuleRouter({ database: database.database });
    const portfolioRouter = createPortfolioModuleRouter({
      database: database.database,
      authenticateAccess,
      secureCookies: config.identity.sessionSecurity.secureCookies,
    });
    const notificationRouter = createNotificationModuleRouter({
      database: database.database,
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: config.identity.sessionSecurity.secureCookies,
      webOrigin: config.http.webOrigin,
    });
    const administrationRouter = createAdministrationModuleRouter({
      database: database.database,
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: config.identity.sessionSecurity.secureCookies,
      webOrigin: config.http.webOrigin,
    });
    if (marketDataWorker === undefined) {
      logger.info(
        { event: "market_data.projection_worker.disabled" },
        "Market Data projection worker disabled",
      );
    }
    const app = createApp({
      lifecycle,
      logger,
      webOrigin: config.http.webOrigin,
      secureTransport: config.http.secureTransport,
      trustedProxyHops: config.http.trustedProxyHops,
      requestRateLimiters: {
        read: new InMemoryHttpRequestRateLimiter({
          maximumRequests: config.http.requestRateLimits.readMaximumRequests,
          windowMilliseconds: config.http.requestRateLimits.windowMilliseconds,
          maximumTrackedClients: config.http.requestRateLimits.maximumTrackedClients,
        }),
        mutation: new InMemoryHttpRequestRateLimiter({
          maximumRequests: config.http.requestRateLimits.mutationMaximumRequests,
          windowMilliseconds: config.http.requestRateLimits.windowMilliseconds,
          maximumTrackedClients: config.http.requestRateLimits.maximumTrackedClients,
        }),
      },
      ...(metricsConfiguration === undefined ? {} : { metrics: metricsConfiguration }),
      identityRouter,
      financialRouter,
      tradingRouter,
      marketDataRouter,
      portfolioRouter,
      notificationRouter,
      administrationRouter,
      applicationVersion: config.logging.applicationVersion,
    });
    const server = createServer(app);
    applyHttpServerLimits(server, config.http.serverLimits);
    const marketDataStream = config.marketData.stream.enabled
      ? createMarketDataStreamGateway({
          database: database.database,
          server,
          logger,
          webOrigin: config.http.webOrigin,
          stream: config.marketData.stream,
        })
      : undefined;
    if (marketDataStream === undefined) {
      logger.info({ event: "market_data.stream.disabled" }, "Market Data stream disabled");
    }
    runtime = {
      server,
      lifecycle,
      database,
      workers: [
        ...(runtimePerformanceMonitor === undefined ? [] : [runtimePerformanceMonitor]),
        ...(marketDataWorker === undefined ? [] : [marketDataWorker]),
      ],
      logger,
      shutdownTimeoutMs: config.http.shutdownTimeoutMs,
      startListening: async () => {
        marketDataStream?.start();
        await listen(server, config.http.port);
      },
      stopListening: async () => {
        await marketDataStream?.stop();
        await closeServer(server);
      },
      forceCloseConnections: () => {
        marketDataStream?.forceCloseConnections();
        server.closeAllConnections();
      },
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
