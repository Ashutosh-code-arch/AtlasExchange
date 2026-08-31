import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

interface DevelopmentRuntimeConfig {
  readonly apiBaseUrl: string | undefined;
  readonly environment: string;
  readonly registrationEnabled: boolean;
  readonly passwordRecoveryEnabled: boolean;
}

function developmentBoolean(value: string | undefined, variableName: string): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${variableName} must be true or false.`);
}

function developmentRuntimeConfig(config: DevelopmentRuntimeConfig): Plugin {
  const serialized = JSON.stringify({
    apiBaseUrl: config.apiBaseUrl,
    environment: config.environment,
    publicAccountFeatures: {
      registrationEnabled: config.registrationEnabled,
      passwordRecoveryEnabled: config.passwordRecoveryEnabled,
    },
  }).replaceAll("<", "\\u003c");
  const body = `globalThis.__ATLAS_RUNTIME_CONFIG__ = Object.freeze(${serialized});\n`;

  return {
    name: "atlas-development-runtime-config",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/runtime-config.js", (_request, response) => {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(body);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    plugins: [
      react(),
      developmentRuntimeConfig({
        apiBaseUrl: environment.VITE_API_BASE_URL,
        environment: environment.VITE_ATLAS_ENV ?? "local",
        registrationEnabled: developmentBoolean(
          environment.VITE_PUBLIC_REGISTRATION_ENABLED,
          "VITE_PUBLIC_REGISTRATION_ENABLED",
        ),
        passwordRecoveryEnabled: developmentBoolean(
          environment.VITE_PUBLIC_PASSWORD_RECOVERY_ENABLED,
          "VITE_PUBLIC_PASSWORD_RECOVERY_ENABLED",
        ),
      }),
    ],
    server: {
      port: 5173,
    },
  };
});
