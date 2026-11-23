import type { AxiosAdapter } from "axios";

/** A namespace: a merchant, store or other sub-scope of an application. */
export interface Namespace {
  type: string;
  id: string;
}

/** Client construction and defaults. */
export interface OctoreviewOptions {
  /** The server's base URL, for example https://reviews.example.com. */
  baseUrl: string;
  /** A service key (ocr_...). Keep it on your server. */
  apiKey: string;
  tenantId: string;
  /** The default application, sent wherever an operation takes application_id. */
  applicationId?: string;
  /** The default namespace (X-Namespace-Type and X-Namespace-ID). */
  namespace?: Namespace;
  /** The default X-Actor-ID recorded in audit logs for writes. */
  actorId?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Attempts for a retry-safe call (default 3). */
  maxAttempts?: number;
  /** The longest Retry-After waited for, in seconds (default 30). */
  maxRetryAfterSeconds?: number;
  /** An axios adapter for API calls (tests, custom transports). */
  adapter?: AxiosAdapter;
  /** An axios adapter for the media PUT; it must not follow redirects. */
  uploadAdapter?: AxiosAdapter;
  /**
   * The client refuses to run in a browser, where its service key would be public. Set this only
   * for a trusted context (an internal tool, a test under jsdom); browsers should upload through
   * your server's `media.createUpload` hand-off instead.
   */
  dangerouslyAllowBrowser?: boolean;
}

/** Per-call overrides of the client defaults. */
export interface CallOptions {
  /** Overrides the client's default application. */
  applicationId?: string;
  /** Overrides the client's default namespace; "global" sends none. */
  namespace?: Namespace | "global";
  /** Also returns global rows on a namespaced read. */
  includeGlobal?: boolean;
  /** Makes a read conditional: an unchanged resource throws NotModifiedError. */
  ifNoneMatch?: string;
  /** X-Actor-ID for this write. */
  actorId?: string;
  /** X-Request-ID, to find the call in the server's logs. */
  requestId?: string;
  /** Cancels the call, including its retries. */
  signal?: AbortSignal;
}

/** What a result knows about the response that produced it. */
export interface ResponseMeta {
  /** Pass back as `ifNoneMatch` for a conditional read. */
  etag: string | null;
  /** The server's X-Request-ID, for its logs. */
  requestId: string | null;
}
