import axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
  isAxiosError,
} from "axios";
import { ErrorCode } from "./errorCodes";
import {
  ApiError,
  ConfigurationError,
  MalformedResponseError,
  NotModifiedError,
  TransportError,
} from "./errors";
import { type Operation, pathParams, takes } from "./operation";
import type { CallOptions, Namespace, ResponseMeta } from "./options";
import { redactText, redactUrl } from "./redact";
import { VERSION } from "./version";

/** Operations the contract declares without credentials. */
const UNAUTHENTICATED = new Set(["getHealthLive", "getHealthReady"]);

/** Operations the contract declares without namespace headers. */
const NO_NAMESPACE = new Set([
  "getHealthLive",
  "getHealthReady",
  "getApplicationSettings",
  "putApplicationSettings",
  "eraseAuthor",
]);

/** 409s an operation retries like a 503 (the contract's completeMediaUpload says so). */
const RETRIED_CONFLICTS: Readonly<Record<string, readonly string[]>> = {
  completeMediaUpload: [ErrorCode.COMPLETE_IN_PROGRESS, ErrorCode.UPLOAD_CHANGED],
};

/** Connection-level failures, retried for retry-safe calls. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_NETWORK",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** @internal */
export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  applicationId: string | undefined;
  namespace: Namespace | undefined;
  actorId: string | undefined;
  timeoutMs: number;
  maxAttempts: number;
  maxRetryAfterSeconds: number;
  adapter: AxiosAdapter | undefined;
  /** Whether to send User-Agent (browsers forbid setting it). */
  sendUserAgent: boolean;
}

/** The decoded envelope of one response. @internal */
export interface Envelope {
  data: unknown;
  pagination: unknown;
  meta: ResponseMeta;
}

/** camelCase to snake_case: externalIds becomes external_ids. @internal */
export function toWire(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Waits, unless the signal fires first. @internal */
export function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function aborted(): TransportError {
  return new TransportError("octoreview: the call was aborted", {
    aborted: true,
    errorCode: "ERR_CANCELED",
  });
}

/** The default backoff before retry number `attempt`: 250 ms doubling to 5 s, with jitter. @internal */
export function retryDelayMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 5000);
  return base * (0.8 + Math.random() * 0.4);
}

/** A response header, case-insensitively, from axios headers or a plain object. @internal */
export function header(response: Pick<AxiosResponse, "headers">, name: string): string | null {
  const headers = response.headers as Record<string, unknown> & { get?: (n: string) => unknown };
  const value =
    typeof headers.get === "function"
      ? headers.get(name)
      : Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : null;
  }
  return value === undefined || value === null || value === "" ? null : String(value);
}

/**
 * Builds, sends and decodes API calls: parameter checks and the query/body split, headers, path
 * escaping, application and namespace defaults, retries by retry class, the data envelope, typed
 * errors and redaction.
 *
 * @internal
 */
export class Transport {
  private readonly http: AxiosInstance;

  constructor(readonly config: TransportConfig) {
    this.http = axios.create({
      timeout: config.timeoutMs,
      adapter: config.adapter,
      // The SDK owns status handling, redirects and decoding.
      validateStatus: () => true,
      maxRedirects: 0,
      maxContentLength: MAX_RESPONSE_BYTES,
      responseType: "text",
      transformRequest: [(data: unknown) => data],
      transformResponse: [(data: unknown) => data],
    });
  }

  /** The call's application: its own, else the client default. */
  application(call: CallOptions | undefined): string | undefined {
    return call?.applicationId ?? this.config.applicationId;
  }

  /**
   * Sends one operation and returns the decoded envelope.
   *
   * @param pathValues  in the order of the path's placeholders
   * @param params      the caller's parameters, camelCase; applicationId and includeGlobal come
   *                    from CallOptions and the client defaults instead
   * @param acceptStatus a non-2xx status whose body is still a data envelope
   */
  async call(
    op: Operation,
    pathValues: readonly string[],
    params: Record<string, unknown>,
    call: CallOptions | undefined,
    acceptStatus?: number,
  ): Promise<Envelope> {
    const [query, body] = this.split(op, params, call);
    const url = this.url(op, pathValues, query);
    const payload = body === null ? undefined : JSON.stringify(body);
    const attempts = op.retry === "unsafe" ? 1 : this.config.maxAttempts;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(op, url, payload, call, acceptStatus);
      } catch (error) {
        const wait = this.retryWait(op, error);
        if (wait === null || attempt >= attempts) {
          throw error;
        }
        await pause(wait === 0 ? retryDelayMs(attempt) : wait, call?.signal);
      }
    }
  }

  /** How long to wait before retrying after `error` (0 means the default backoff), or null for never. */
  private retryWait(op: Operation, error: unknown): number | null {
    if (error instanceof TransportError) {
      return error.networkFailure ? 0 : null;
    }
    if (!(error instanceof ApiError)) {
      return null;
    }
    const retriable =
      error.status === 429 ||
      error.status === 503 ||
      (RETRIED_CONFLICTS[op.id] ?? []).includes(error.code);
    if (!retriable) {
      return null;
    }
    if (error.retryAfter === null) {
      return 0;
    }
    // A Retry-After longer than this client is willing to wait is not waited for.
    return error.retryAfter > this.config.maxRetryAfterSeconds ? null : error.retryAfter * 1000;
  }

  /** Validates the caller's parameters and splits them into query and body. */
  private split(
    op: Operation,
    params: Record<string, unknown>,
    call: CallOptions | undefined,
  ): [Record<string, unknown>, Record<string, unknown> | null] {
    const path = pathParams(op);
    const wire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "applicationId") {
        throw new ConfigurationError(
          `octoreview: ${op.jsMethod} takes the application from CallOptions.applicationId or the client default, not a parameter`,
        );
      }
      if (key === "includeGlobal") {
        throw new ConfigurationError(
          `octoreview: ${op.jsMethod} takes includeGlobal from CallOptions`,
        );
      }
      const name = toWire(key);
      if (!takes(op, name) || path.includes(name) || name === "application_id") {
        throw new ConfigurationError(`octoreview: ${op.jsMethod} does not take ${key}`);
      }
      if (value !== undefined) {
        wire[name] = value;
      }
    }
    if (takes(op, "application_id") && !path.includes("application_id")) {
      const application = this.application(call);
      if (application) {
        wire.application_id = application;
      }
    }
    if (call?.includeGlobal) {
      if (!takes(op, "include_global")) {
        throw new ConfigurationError(`octoreview: ${op.jsMethod} does not take includeGlobal`);
      }
      wire.include_global = true;
    }
    for (const name of op.required) {
      if (!path.includes(name) && !(name in wire)) {
        throw new ConfigurationError(
          name === "application_id"
            ? `octoreview: ${op.jsMethod} needs an application: set the client's applicationId or CallOptions.applicationId`
            : `octoreview: ${op.jsMethod} needs ${name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`,
        );
      }
    }
    const query: Record<string, unknown> = {};
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(wire)) {
      if (op.body.includes(name)) {
        // Only top-level keys were converted: metadata keys are the caller's own.
        body[name] = value;
      } else if (value !== null) {
        query[name] = value;
      }
    }
    // An operation without body fields (complete, for one) sends no body, as the contract says.
    return [query, op.body.length === 0 ? null : body];
  }

  private url(
    op: Operation,
    pathValues: readonly string[],
    query: Record<string, unknown>,
  ): string {
    let path = op.path;
    pathParams(op).forEach((name, i) => {
      const value = pathValues[i];
      if (!value) {
        throw new ConfigurationError(
          `octoreview: ${op.jsMethod} needs ${name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`,
        );
      }
      path = path.replace(`{${name}}`, encodeURIComponent(value));
    });
    const search = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.config.baseUrl.replace(/\/+$/, "")}/api/v1${path}${search ? `?${search}` : ""}`;
  }

  private headers(
    op: Operation,
    call: CallOptions | undefined,
    hasBody: boolean,
  ): Record<string, string | false> {
    // false suppresses a header axios would add on its own (a form Content-Type on a bodiless POST).
    const headers: Record<string, string | false> = {
      Accept: "application/json",
      "Content-Type": false,
    };
    if (this.config.sendUserAgent) {
      headers["User-Agent"] = `octoreview-js/${VERSION}`;
    }
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    if (call?.requestId) {
      headers["X-Request-ID"] = call.requestId;
    }
    if (!UNAUTHENTICATED.has(op.id)) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
      headers["X-Tenant-ID"] = this.config.tenantId;
      if (!NO_NAMESPACE.has(op.id)) {
        const namespace = call?.namespace ?? this.config.namespace;
        if (namespace && namespace !== "global") {
          headers["X-Namespace-Type"] = namespace.type;
          headers["X-Namespace-ID"] = namespace.id;
        }
      }
      // X-Actor-ID goes on writes only; queryRatings is a POST but a read (retry class safe).
      const actor = call?.actorId ?? this.config.actorId;
      if (op.retry !== "safe" && actor) {
        headers["X-Actor-ID"] = actor;
      }
    }
    if (op.method === "GET" && call?.ifNoneMatch) {
      headers["If-None-Match"] = call.ifNoneMatch;
    }
    return headers;
  }

  private async attempt(
    op: Operation,
    url: string,
    payload: string | undefined,
    call: CallOptions | undefined,
    acceptStatus: number | undefined,
  ): Promise<Envelope> {
    let response: AxiosResponse<unknown>;
    try {
      response = await this.http.request({
        method: op.method,
        url,
        data: payload,
        headers: this.headers(op, call, payload !== undefined),
        signal: call?.signal,
      });
    } catch (error) {
      // Never the axios error itself: its config carries the Authorization header.
      throw transportFailure(op.method, url, error);
    }
    const meta: ResponseMeta = {
      etag: header(response, "ETag"),
      requestId: header(response, "X-Request-ID"),
    };
    const raw =
      typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new TransportError(`octoreview: ${op.id} answered more than 16 MiB`, {
        requestId: meta.requestId,
      });
    }
    const status = response.status;
    if (status === 304) {
      throw new NotModifiedError(
        `octoreview: ${op.id} is unchanged (ETag ${call?.ifNoneMatch ?? ""})`,
      );
    }
    if ((status >= 200 && status < 300) || status === acceptStatus) {
      const decoded = parseJson(raw);
      if (!isObject(decoded) || !("data" in decoded)) {
        throw new MalformedResponseError(
          `octoreview: ${op.id} answered without a data envelope`,
          meta.requestId,
        );
      }
      return { data: decoded.data, pagination: decoded.pagination ?? null, meta };
    }
    throw apiError(response, raw);
  }
}

/** A typed, redacted failure from the HTTP client's error, which is never attached. @internal */
export function transportFailure(method: string, url: string, error: unknown): TransportError {
  const code = isAxiosError(error) ? (error.code ?? null) : null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_CANCELED" || (error instanceof Error && error.name === "AbortError")) {
    return aborted();
  }
  return new TransportError(`octoreview: ${method} ${redactUrl(url)}: ${redactText(message)}`, {
    networkFailure: code !== null && NETWORK_CODES.has(code),
    errorCode: code,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function apiError(response: AxiosResponse<unknown>, raw: string): ApiError {
  const status = response.status;
  const retryAfterHeader = header(response, "Retry-After");
  const retryAfter =
    retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
  const decoded = parseJson(raw);
  const error = isObject(decoded) && isObject(decoded.error) ? decoded.error : null;
  if (error === null || typeof error.code !== "string" || error.code === "") {
    return new ApiError({
      status,
      code: "unexpected_response",
      message: `the server answered HTTP ${status} without an error envelope`,
      requestId: header(response, "X-Request-ID"),
      retryable: status === 429 || status === 503,
      retryAfter,
    });
  }
  return new ApiError({
    status,
    code: error.code,
    message: typeof error.message === "string" ? error.message : "",
    details: isObject(error.details) ? error.details : {},
    requestId:
      typeof error.request_id === "string" && error.request_id !== ""
        ? error.request_id
        : header(response, "X-Request-ID"),
    docUrl: typeof error.doc_url === "string" ? error.doc_url : null,
    retryable: error.retryable === true,
    retryAfter,
  });
}
