import { ApiHttpError, HttpClient, type HttpRequestOptions } from "../../../shared/api/http-client";
import {
  RefreshCoordinator,
  type RefreshChannel,
  type RefreshLockManager,
} from "../refresh-coordinator";

export interface AuthenticationRequestOptions extends HttpRequestOptions {
  readonly csrf?: boolean;
  readonly recoverAuthentication?: boolean;
}

export interface CreateAuthenticationHttpClientOptions {
  readonly apiBaseUrl: string;
  readonly onAuthenticationLost: () => void;
  readonly fetchImplementation?: typeof fetch;
  readonly readCsrfToken?: () => string | undefined;
  readonly lockManager?: RefreshLockManager | null;
  readonly channel?: RefreshChannel | null;
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const cookie = document.cookie
    .split(";")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  if (cookie === undefined) {
    return undefined;
  }
  return decodeURIComponent(cookie.slice(prefix.length));
}

export function readSessionCsrfToken(): string | undefined {
  return readCookie("__Host-atlas_csrf") ?? readCookie("atlas_csrf");
}

export class AuthenticationHttpClient {
  public constructor(
    private readonly httpClient: HttpClient,
    private readonly refreshCoordinator: RefreshCoordinator,
    private readonly readCsrfToken: () => string | undefined,
  ) {}

  public async request(
    path: string,
    options: AuthenticationRequestOptions = {},
  ): Promise<Response> {
    const { csrf = false, recoverAuthentication = true, ...httpOptions } = options;
    const refreshSequence = this.refreshCoordinator.captureCompletionSequence();
    const execute = (): Promise<Response> => {
      const headers = new Headers(httpOptions.headers);
      if (csrf) {
        const csrfToken = this.readCsrfToken();
        if (csrfToken !== undefined) {
          headers.set("x-csrf-token", csrfToken);
        }
      }
      return this.httpClient.request(path, { ...httpOptions, headers });
    };

    try {
      return await execute();
    } catch (error) {
      if (!(error instanceof ApiHttpError) || error.status !== 401 || !recoverAuthentication) {
        throw error;
      }
      if (this.readCsrfToken() === undefined) {
        this.refreshCoordinator.announceAuthenticationLost();
        throw error;
      }
      if (!(await this.refreshCoordinator.recover(refreshSequence))) {
        throw error;
      }
      return execute();
    }
  }

  public dispose(): void {
    this.refreshCoordinator.dispose();
  }

  public announceAuthenticationLost(): void {
    this.refreshCoordinator.announceAuthenticationLost();
  }
}

export function createAuthenticationHttpClient(
  options: CreateAuthenticationHttpClientOptions,
): AuthenticationHttpClient {
  const httpClient = new HttpClient(options.apiBaseUrl, options.fetchImplementation);
  const readCsrfToken = options.readCsrfToken ?? readSessionCsrfToken;
  const refreshCoordinator = new RefreshCoordinator({
    performRefresh: async () => {
      const headers = new Headers();
      const csrfToken = readCsrfToken();
      if (csrfToken !== undefined) {
        headers.set("x-csrf-token", csrfToken);
      }
      try {
        await httpClient.request("/api/v1/auth/refresh", {
          method: "POST",
          body: {},
          headers,
        });
        return true;
      } catch (error) {
        if (
          error instanceof ApiHttpError &&
          (error.status === 401 || error.code === "CSRF_FAILED")
        ) {
          return false;
        }
        throw error;
      }
    },
    onAuthenticationLost: options.onAuthenticationLost,
    ...(options.lockManager === undefined ? {} : { lockManager: options.lockManager }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
  });
  return new AuthenticationHttpClient(httpClient, refreshCoordinator, readCsrfToken);
}
