import type { Server } from "node:http";

export interface HttpServerLimits {
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maximumHeadersCount: number;
  readonly maximumRequestsPerSocket: number;
}

export function applyHttpServerLimits(server: Server, limits: HttpServerLimits): void {
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxHeadersCount = limits.maximumHeadersCount;
  server.maxRequestsPerSocket = limits.maximumRequestsPerSocket;
}
