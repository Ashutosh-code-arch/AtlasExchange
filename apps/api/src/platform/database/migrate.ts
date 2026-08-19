import { parseApiConfig } from "../../config/config.js";
import { applyMigrations } from "./migration-runner.js";
import { createLogger } from "../logging/logger.js";

const config = parseApiConfig(process.env);
const logger = createLogger(config.logging);

applyMigrations(config.database.url)
  .then((migrations) => {
    logger.info(
      { event: "database.migrations.completed", migrations },
      "Database migrations complete",
    );
  })
  .catch((error: unknown) => {
    logger.fatal({ event: "database.migrations.failed", err: error }, "Database migration failed");
    process.exitCode = 1;
  });
