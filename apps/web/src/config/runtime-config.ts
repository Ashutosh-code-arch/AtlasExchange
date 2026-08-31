import { parseWebConfig } from "./config";

interface AtlasRuntimeGlobal {
  readonly __ATLAS_RUNTIME_CONFIG__?: unknown;
}

const runtimeConfig = (globalThis as typeof globalThis & AtlasRuntimeGlobal)
  .__ATLAS_RUNTIME_CONFIG__;

// Vite supplies this fallback only to development and test builds. A production bundle requires
// the runtime document so an unavailable or invalid deployment configuration fails closed.
const developmentConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  environment: "local",
  publicAccountFeatures: {
    registrationEnabled: true,
    passwordRecoveryEnabled: true,
  },
};

export const webConfig = parseWebConfig(
  import.meta.env.PROD ? runtimeConfig : (runtimeConfig ?? developmentConfig),
);
