import { apiErrorResponseSchema } from "@atlas/contracts";

export interface HttpRequestOptions extends Omit<RequestInit, "body" | "credentials"> {
  readonly body?: unknown;
}

export class ApiHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code?: string,
    public readonly requestId?: string,
    message = `Atlas API request failed with status ${status}.`,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export class ApiTransportError extends Error {
  public constructor(cause: unknown) {
    super("Atlas API could not be reached.", { cause });
    this.name = "ApiTransportError";
  }
}

export class HttpClient {
  private readonly baseUrl: string;

  public constructor(
    baseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  public async request(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    if (!path.startsWith("/")) {
      throw new TypeError("Atlas API paths must begin with a slash.");
    }

    const { body: payload, ...requestOptions } = options;
    const headers = new Headers(requestOptions.headers);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    let body: BodyInit | undefined;
    if (payload !== undefined) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      body = JSON.stringify(payload);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...requestOptions,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: "include",
      });
    } catch (error) {
      throw new ApiTransportError(error);
    }

    if (response.ok) {
      return response;
    }

    let errorPayload: unknown;
    try {
      errorPayload = (await response.clone().json()) as unknown;
    } catch {
      errorPayload = undefined;
    }
    const apiError = apiErrorResponseSchema.safeParse(errorPayload);
    if (apiError.success) {
      throw new ApiHttpError(
        response.status,
        apiError.data.error.code,
        apiError.data.error.requestId,
        apiError.data.error.message,
      );
    }
    throw new ApiHttpError(response.status);
  }
}
