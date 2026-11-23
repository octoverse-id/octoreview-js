import type { ErrorCode } from "./errorCodes";
import { redactText } from "./redact";

/**
 * Every error this SDK throws. Messages never contain the API key, a query string (signatures)
 * or a media token, and no error carries the HTTP client's own error or request config (which
 * hold the `Authorization` header).
 */
export class OctoreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The fields of the server's error envelope (docs/errors.md). */
export interface ApiErrorInit {
  status: number;
  code: ErrorCode | "unexpected_response" | (string & {});
  message: string;
  details?: Record<string, unknown>;
  requestId?: string | null;
  docUrl?: string | null;
  retryable?: boolean;
  retryAfter?: number | null;
}

/**
 * An error response: the octoreview error envelope plus the HTTP status. `code` is one of the
 * ErrorCode values; `details` carries the code-specific fields docs/errors.md lists.
 */
export class ApiError extends OctoreviewError {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly docUrl: string | null;
  readonly retryable: boolean;
  /** The server's Retry-After in seconds, when it sent one. */
  readonly retryAfter: number | null;

  constructor(init: ApiErrorInit) {
    const detail = redactText(init.message);
    super(
      `octoreview: ${init.code} (HTTP ${init.status}, request id ${init.requestId ?? "none"}): ${detail}`,
    );
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.docUrl = init.docUrl ?? null;
    this.retryable = init.retryable ?? false;
    this.retryAfter = init.retryAfter ?? null;
  }

  /** The version guard refused a moderation call: reload the review and show the new content. */
  isReviewChanged(): boolean {
    return this.code === "review_changed";
  }
}

/** The server could not be reached, or its answer could not be read. */
export class TransportError extends OctoreviewError {
  /** A connection-level failure (refused, reset, timed out): retried for retry-safe calls. */
  readonly networkFailure: boolean;
  /** The call was cancelled through its AbortSignal. */
  readonly aborted: boolean;
  /** The HTTP client's error code, such as ECONNREFUSED or ETIMEDOUT. */
  readonly errorCode: string | null;
  /** The server's X-Request-ID, when it answered. */
  readonly requestId: string | null;

  constructor(
    message: string,
    init: {
      networkFailure?: boolean;
      aborted?: boolean;
      errorCode?: string | null;
      requestId?: string | null;
    } = {},
  ) {
    super(init.requestId ? `${message} (request id ${init.requestId})` : message);
    this.networkFailure = init.networkFailure ?? false;
    this.aborted = init.aborted ?? false;
    this.errorCode = init.errorCode ?? null;
    this.requestId = init.requestId ?? null;
  }
}

/** A conditional read (`ifNoneMatch`) found the resource unchanged (HTTP 304). */
export class NotModifiedError extends OctoreviewError {}

/** A success response without the data envelope, or lacking a field this SDK needs. */
export class MalformedResponseError extends OctoreviewError {
  /** The server's X-Request-ID, to find the response in its logs. */
  readonly requestId: string | null;

  constructor(message: string, requestId: string | null = null) {
    super(requestId ? `${message} (request id ${requestId})` : message);
    this.requestId = requestId;
  }
}

/** The client was built with a missing or invalid base URL, key or tenant, or in a browser. */
export class ConfigurationError extends OctoreviewError {}
