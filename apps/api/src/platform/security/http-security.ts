import cors from "cors";
import type { Express } from "express";
import helmet from "helmet";

export interface HttpSecurityOptions {
  readonly webOrigin: string;
  readonly secureTransport: boolean;
  readonly trustedProxyHops: number;
}

const browserPermissionsPolicy = [
  "camera=()",
  "geolocation=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

export function configureHttpSecurity(app: Express, options: HttpSecurityOptions): void {
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustedProxyHops === 0 ? false : options.trustedProxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      strictTransportSecurity: options.secureTransport
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
      xFrameOptions: { action: "deny" },
    }),
  );
  app.use((_request, response, next) => {
    response.setHeader("permissions-policy", browserPermissionsPolicy);
    next();
  });
  app.use(
    cors({
      origin(requestOrigin, callback) {
        callback(null, requestOrigin === options.webOrigin);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Request-ID"],
      exposedHeaders: ["X-Request-ID", "Retry-After"],
      maxAge: 600,
    }),
  );
}
