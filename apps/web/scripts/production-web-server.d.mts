import type { Server } from "node:http";

export interface ProductionWebConfig {
  readonly apiBaseUrl: string;
  readonly port: number;
  readonly stagingAccess:
    | Readonly<{ enabled: false }>
    | Readonly<{
        enabled: true;
        teamDomain: string;
        audience: string;
      }>;
}

export interface ProductionWebServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly distributionDirectory?: string;
  readonly host?: string;
  readonly port?: number;
  readonly stagingAccessTokenVerifier?: (token: string) => Promise<boolean>;
}

export function createCloudflareAccessTokenVerifier(options: {
  readonly teamDomain: string;
  readonly audience: string;
}): (token: string) => Promise<boolean>;

export function parseProductionWebConfig(environment: NodeJS.ProcessEnv): ProductionWebConfig;
export function createRuntimeConfigScript(apiBaseUrl: string): string;
export function createProductionWebServer(options?: ProductionWebServerOptions): {
  readonly config: ProductionWebConfig;
  readonly server: Server;
};
export function startProductionWebServer(options?: ProductionWebServerOptions): Promise<{
  readonly config: ProductionWebConfig;
  readonly server: Server;
}>;
