import type { Readable } from "node:stream";
import axios, { type AxiosAdapter, type AxiosInstance, type AxiosResponse } from "axios";
import { ErrorCode } from "./errorCodes";
import { ApiError, OctoreviewError, type TransportError } from "./errors";
import type { UploadTarget } from "./models";
import type { CallOptions } from "./options";
import { redactText } from "./redact";
import { header, pause, retryDelayMs, transportFailure } from "./transport";

/** The step an upload failed at. */
export type UploadStage = "intent" | "put" | "complete";

/** Options of one upload helper call. */
export interface UploadOptions {
  /** Reports the bytes sent so far during the PUT, and the total. */
  onProgress?: (sent: number, total: number) => void;
  /** Makes the intent replayable across processes (one is generated otherwise). */
  clientUploadId?: string;
  /** Orders the media item within its review. */
  position?: number;
  /** An image's or video's pixel size. */
  width?: number;
  height?: number;
  /** A video's length. */
  durationSeconds?: number;
  /** Call options (application, namespace, actor, signal) for the intent, complete and cleanup calls, and the PUT's signal. */
  callOptions?: CallOptions;
}

/** A body source: a factory (reopened for each PUT attempt) or a stream (one attempt only). */
export type UploadSource =
  | (() => Readable | ReadableStream<Uint8Array>)
  | Readable
  | ReadableStream<Uint8Array>;

/** What an UploadError reports. */
export interface UploadErrorInit {
  stage: UploadStage;
  reviewId: string;
  mediaId?: string | null;
  uploadExpiresAt?: Date | null;
  requestIds?: string[];
  providerCode?: string | null;
  fix?: string | null;
  /** An SDK error (ApiError or TransportError), never the HTTP client's own. */
  cause?: OctoreviewError;
  reason?: string;
}

/**
 * A failed uploadFile, uploadBytes or uploadStream. It names the stage that failed and the ids to
 * look the upload up by; it never contains the signed upload URL.
 */
export class UploadError extends OctoreviewError {
  readonly stage: UploadStage;
  readonly reviewId: string;
  readonly mediaId: string | null;
  readonly uploadExpiresAt: Date | null;
  /** The server request ids of the calls this upload made, oldest first. */
  readonly requestIds: string[];
  /** The storage provider's error code for a failed PUT (S3's XML <Code>, or the local backend's). */
  readonly providerCode: string | null;
  /** What to change, for a known provider code. */
  readonly fix: string | null;

  constructor(init: UploadErrorInit) {
    let message = `octoreview: upload failed at ${init.stage} (review ${init.reviewId}`;
    if (init.mediaId) message += `, media ${init.mediaId}`;
    message += ")";
    if (init.providerCode) message += `: ${init.providerCode}`;
    if (init.fix) message += `; ${init.fix}`;
    const cause = init.reason ?? init.cause?.message;
    if (cause) message += `: ${redactText(cause)}`;
    super(message);
    if (init.cause) {
      Object.defineProperty(this, "cause", { value: init.cause, enumerable: false });
    }
    this.stage = init.stage;
    this.reviewId = init.reviewId;
    this.mediaId = init.mediaId ?? null;
    this.uploadExpiresAt = init.uploadExpiresAt ?? null;
    this.requestIds = init.requestIds ?? [];
    this.providerCode = init.providerCode ?? null;
    this.fix = init.fix ?? null;
  }
}

/** The storage PUT answered an error. @internal */
export class PutFailedError extends OctoreviewError {
  constructor(
    readonly status: number,
    readonly providerCode: string | null,
    readonly fix: string | null,
  ) {
    super(
      providerCode
        ? `the storage PUT answered HTTP ${status} (${providerCode})`
        : `the storage PUT answered HTTP ${status}`,
    );
  }
}

/** What to change, by the storage provider's (or the local backend's) error code. */
const FIXES: Readonly<Record<string, string>> = {
  SignatureDoesNotMatch:
    "send exactly upload.headers and the declared Content-Length; the URL signs both, and the clock must be right",
  AccessDenied: "the URL expired or its signer cannot write to the bucket; create a new upload",
  ExpiredToken: "the URL's signing credential expired; create a new upload",
  RequestTimeTooSkewed: "this machine's clock is off; sync it",
  EntityTooLarge: "the body is larger than the declared size",
  NoSuchBucket: "the server's bucket setting is wrong; tell its operator",
  [ErrorCode.UPLOAD_TOO_LARGE]: "the body is larger than the declared size",
  [ErrorCode.UPLOAD_TOKEN_EXPIRED]: "the upload URL expired; create a new upload",
  [ErrorCode.UPLOAD_TOKEN_INVALID]: "the upload URL is not valid; create a new upload",
  [ErrorCode.UPLOAD_ALREADY_COMPLETED]:
    "this upload already completed; create a new one to upload another file",
};

const ATTEMPTS = 3;

/** S3's XML <Code>, or the local backend's JSON error code. */
function providerCode(raw: string): string | null {
  const xml = /<Code>([^<]{1,128})<\/Code>/.exec(raw);
  if (xml?.[1]) {
    return xml[1];
  }
  try {
    const decoded = JSON.parse(raw) as { error?: { code?: unknown } };
    return typeof decoded.error?.code === "string" && decoded.error.code !== ""
      ? decoded.error.code
      : null;
  } catch {
    return null;
  }
}

/** A Node stream of at most `size` bytes from `source`, reporting progress. */
async function meter(
  source: Readable | ReadableStream<Uint8Array>,
  size: number,
  progress: ((sent: number, total: number) => void) | undefined,
): Promise<Readable> {
  const { Readable: NodeReadable, Transform } = await import("node:stream");
  const input =
    source instanceof NodeReadable
      ? source
      : NodeReadable.fromWeb(source as Parameters<typeof NodeReadable.fromWeb>[0]);
  let sent = 0;
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const room = size - sent;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      sent += piece.length;
      if (piece.length > 0) {
        progress?.(sent, size);
        done(null, piece);
      } else {
        done();
      }
    },
  });
  input.on("error", (error) => limited.destroy(error));
  return input.pipe(limited);
}

/**
 * Sends a media file to its signed upload URL: only the signed headers plus an explicit
 * Content-Length (never the service key, tenant or namespace headers), retried on the same URL
 * until it expires.
 *
 * @internal
 */
export class Uploader {
  private readonly http: AxiosInstance;

  constructor(
    adapter: AxiosAdapter | undefined,
    private readonly maxRetryAfterSeconds: number,
  ) {
    this.http = axios.create({
      adapter,
      // No redirects (an upload never follows one), and no total timeout: a large video takes
      // its time, and the caller's AbortSignal cancels.
      maxRedirects: 0,
      timeout: 0,
      maxBodyLength: Number.POSITIVE_INFINITY,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true,
      responseType: "text",
      transformRequest: [(data: unknown) => data],
      transformResponse: [(data: unknown) => data],
    });
  }

  /**
   * @param open      a fresh body for each attempt; `rewindable` false allows one attempt only
   */
  async put(
    target: UploadTarget,
    open: () => Readable | ReadableStream<Uint8Array>,
    rewindable: boolean,
    size: number,
    progress: ((sent: number, total: number) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const attempts = rewindable ? ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      const [wait, failure] = await this.attempt(
        target,
        await meter(open(), size, progress),
        size,
        signal,
      );
      if (failure === null) {
        return;
      }
      if (wait === null || attempt >= attempts) {
        throw failure;
      }
      const ms = wait === 0 ? retryDelayMs(attempt) : wait;
      if (Date.now() + ms > target.expiresAt.getTime()) {
        throw failure; // the URL would expire before the retry
      }
      await pause(ms, signal);
    }
  }

  /** One PUT: the failure (null on success) and when to retry it (0: default backoff; null: never). */
  private async attempt(
    target: UploadTarget,
    body: Readable,
    size: number,
    signal: AbortSignal | undefined,
  ): Promise<[number | null, PutFailedError | TransportError | null]> {
    let response: AxiosResponse<unknown>;
    try {
      response = await this.http.request({
        method: target.method || "PUT",
        url: target.url,
        data: body,
        // Only the signed headers, and an explicit length (never chunked); false keeps axios from
        // adding a Content-Type of its own.
        headers: { "Content-Type": false, ...target.headers, "Content-Length": String(size) },
        signal,
      });
    } catch (error) {
      body.destroy();
      const failure = transportFailure(target.method || "PUT", target.url, error);
      return [failure.networkFailure ? 0 : null, failure];
    }
    const status = response.status;
    if (status >= 200 && status < 300) {
      return [null, null];
    }
    const raw = typeof response.data === "string" ? response.data : "";
    const code = providerCode(raw.slice(0, 65536));
    if (status >= 300 && status < 400) {
      return [
        null,
        new PutFailedError(
          status,
          code,
          "the upload URL redirected, which uploads never follow; check the storage endpoint",
        ),
      ];
    }
    const failure = new PutFailedError(status, code, code === null ? null : (FIXES[code] ?? null));
    if (status !== 429 && status < 500) {
      return [null, failure];
    }
    const retryAfter = header(response, "Retry-After");
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      const seconds = Number(retryAfter);
      return [seconds > this.maxRetryAfterSeconds ? null : seconds * 1000, failure];
    }
    return [0, failure];
  }
}

/** The request ids an upload's calls produced, oldest first. @internal */
export function requestIds(intentRequestId: string | null, error: unknown): string[] {
  const ids = [intentRequestId, error instanceof ApiError ? error.requestId : null];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}
