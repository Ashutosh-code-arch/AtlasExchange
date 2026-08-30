import { validateRestoredDatabase } from "./recovery-validation.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error(
    JSON.stringify({
      event: "database.recovery_validation.failed",
      message: "DATABASE_URL is required",
    }),
  );
  process.exitCode = 1;
} else {
  validateRestoredDatabase(databaseUrl)
    .then((report) => {
      const event = report.passed
        ? "database.recovery_validation.completed"
        : "database.recovery_validation.rejected";
      const output = JSON.stringify({ event, report });

      if (report.passed) {
        console.log(output);
      } else {
        console.error(output);
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "database.recovery_validation.failed",
          message: error instanceof Error ? error.message : "Unknown recovery validation failure",
        }),
      );
      process.exitCode = 1;
    });
}
