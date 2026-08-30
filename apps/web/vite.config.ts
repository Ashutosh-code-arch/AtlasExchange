import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

function developmentRuntimeConfig(apiBaseUrl: string | undefined): Plugin {
  const serialized = JSON.stringify({ apiBaseUrl }).replaceAll("<", "\\u003c");
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
  const environment = loadEnv(mode, process.cwd(), "VITE_API_BASE_URL");

  return {
    plugins: [react(), developmentRuntimeConfig(environment.VITE_API_BASE_URL)],
    server: {
      port: 5173,
    },
  };
});
