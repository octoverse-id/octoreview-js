import { ErrorCode } from "../errorCodes";
import { ApiError, OctoreviewError } from "../errors";
import {
  MEDIA_UPLOAD_SPEC,
  type Media,
  type MediaUpload,
  type Page,
  SPECS,
  type WithMeta,
} from "../models";
import type { CallOptions } from "../options";
import type { Transport } from "../transport";
import {
  PutFailedError,
  requestIds,
  UploadError,
  type UploadErrorInit,
  type Uploader,
  type UploadOptions,
  type UploadSource,
  type UploadStage,
} from "../upload";
import type { ModerationParams, VersionGuard } from "./reviews";
import { Service } from "./service";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** media.list: as reviews.get, the author's own or a moderator's view. */
/**
 * media.list: a review's media on the author path or as a moderator. `limit`/`offset` page the
 * list (server default 20, at most 100 per page).
 */
export interface ListMediaParams {
  authorId?: string;
  includeUnpublished?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * media.createUpload: reserves a media slot. `clientUploadId` makes the call retry-safe; one is
 * generated when absent, so a retried intent returns the same media.
 */
export interface CreateUploadParams {
  kind: "image" | "video";
  contentType: string;
  sizeBytes: number;
  clientUploadId?: string;
  position?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * Review images and videos. uploadFile, uploadBytes and uploadStream run the three upload steps:
 * createUpload (the intent), a PUT of the bytes to `upload.url` with exactly `upload.headers`,
 * then complete. They run on Node only.
 */
export class MediaService extends Service {
  constructor(
    transport: Transport,
    private readonly uploader: Uploader,
  ) {
    super(transport);
  }

  /**
   * Uploads a file: intent, PUT and complete. The content type comes from the extension (.jpg,
   * .jpeg, .png, .webp, .mp4, .webm, .mov) and the size from the file.
   */
  async uploadFile(reviewId: string, path: string, options: UploadOptions = {}): Promise<Media> {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const contentType = path.includes(".") ? CONTENT_TYPES[extension] : undefined;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!contentType) {
      throw new UploadError({
        stage: "intent",
        reviewId,
        reason: `cannot tell the content type of ${name}; use uploadStream with one of ${[...new Set(Object.values(CONTENT_TYPES))].join(", ")}`,
      });
    }
    const { createReadStream, promises } = await import("node:fs");
    let size: number;
    try {
      const stat = await promises.stat(path);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      throw new UploadError({ stage: "intent", reviewId, reason: `cannot read ${name}` });
    }
    return this.uploadStream(reviewId, () => createReadStream(path), contentType, size, options);
  }

  /** Uploads an in-memory file: intent, PUT and complete. */
  async uploadBytes(
    reviewId: string,
    data: Uint8Array | ArrayBuffer,
    contentType: string,
    options: UploadOptions = {},
  ): Promise<Media> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const { Readable } = await import("node:stream");
    return this.uploadStream(
      reviewId,
      () => Readable.from([Buffer.from(bytes)]),
      contentType,
      bytes.byteLength,
      options,
    );
  }

  /**
   * Uploads `sizeBytes` from a source: intent, PUT and complete, returning the ready media. A
   * factory is reopened for each PUT attempt; a plain stream cannot rewind, so its PUT is tried
   * once. The PUT goes to the signed URL with only the headers the server returned and an
   * explicit Content-Length: never the service key, tenant or namespace headers.
   */
  async uploadStream(
    reviewId: string,
    source: UploadSource,
    contentType: string,
    sizeBytes: number,
    options: UploadOptions = {},
  ): Promise<Media> {
    const kind = contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("video/")
        ? "video"
        : null;
    if (kind === null) {
      throw new UploadError({
        stage: "intent",
        reviewId,
        reason: `content type "${contentType}" is neither an image nor a video`,
      });
    }
    const call = options.callOptions;
    let intent: WithMeta<MediaUpload>;
    try {
      intent = await this.createUpload(
        reviewId,
        {
          kind,
          contentType,
          sizeBytes,
          ...(options.clientUploadId === undefined
            ? {}
            : { clientUploadId: options.clientUploadId }),
          ...(options.position === undefined ? {} : { position: options.position }),
          ...(options.width === undefined ? {} : { width: options.width }),
          ...(options.height === undefined ? {} : { height: options.height }),
          ...(options.durationSeconds === undefined
            ? {}
            : { durationSeconds: options.durationSeconds }),
        },
        call,
      );
    } catch (error) {
      throw error instanceof OctoreviewError
        ? new UploadError({
            stage: "intent",
            reviewId,
            requestIds: requestIds(null, error),
            cause: error,
          })
        : error;
    }
    const media = intent.media;
    const failure = (
      stage: UploadStage,
      error?: OctoreviewError,
      extra: Pick<UploadErrorInit, "providerCode" | "fix"> = {},
      reason?: string,
    ) =>
      new UploadError({
        stage,
        reviewId,
        mediaId: media.id,
        uploadExpiresAt: media.uploadExpiresAt,
        requestIds: requestIds(intent.meta.requestId, error),
        providerCode: extra.providerCode ?? null,
        fix: extra.fix ?? null,
        ...(error === undefined ? {} : { cause: error }),
        ...(reason === undefined ? {} : { reason }),
      });
    if (intent.upload === null) {
      // A replayed intent whose upload already completed (or expired).
      if (media.status === "ready") {
        return media;
      }
      throw failure(
        "intent",
        undefined,
        {},
        "this upload is no longer uploadable; create a new one",
      );
    }
    const rewindable = typeof source === "function";
    let opened = false;
    const open = () => {
      if (typeof source === "function") return source();
      if (opened) throw new Error("octoreview: a plain stream cannot be sent twice");
      opened = true;
      return source;
    };
    try {
      await this.uploader.put(
        intent.upload,
        open,
        rewindable,
        sizeBytes,
        options.onProgress,
        call?.signal,
      );
    } catch (error) {
      if (!(error instanceof OctoreviewError)) throw error;
      const done = await this.#cleanUp(reviewId, media.id, call);
      if (done !== null) {
        return done;
      }
      throw error instanceof PutFailedError
        ? failure("put", error, { providerCode: error.providerCode, fix: error.fix })
        : failure("put", error);
    }
    try {
      return await this.complete(reviewId, media.id, call);
    } catch (error) {
      throw error instanceof OctoreviewError ? failure("complete", error) : error;
    }
  }

  /**
   * After a terminal PUT failure: another call with the same client upload id may have PUT and
   * completed this media item, and deleting it would invalidate that caller's result. Complete
   * is idempotent: it answers the ready media then (returned), or upload_not_found when no bytes
   * ever landed, the one case that frees the slot. Any other answer leaves the row to the
   * server's cleanup.
   */
  async #cleanUp(
    reviewId: string,
    mediaId: string,
    call: CallOptions | undefined,
  ): Promise<Media | null> {
    const quiet = call?.signal ? { ...call, signal: undefined } : call; // cleanup runs even after an abort
    try {
      const media = await this.complete(reviewId, mediaId, quiet);
      return media.status === "ready" ? media : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === ErrorCode.UPLOAD_NOT_FOUND) {
        await this.delete(reviewId, mediaId, quiet).catch(() => undefined);
      }
      return null;
    }
  }

  /**
   * One page of a review's media in position order. Unlike the review's embedded list it is not
   * capped: `pagination.count` is the total, and `offset` walks the rest.
   */
  list(
    reviewId: string,
    params: ListMediaParams = {},
    options?: CallOptions,
  ): Promise<Page<Media>> {
    return this.page("listReviewMedia", [reviewId], params, options, SPECS.Media);
  }

  /** Reserves a media slot and returns where to PUT the bytes. */
  createUpload(
    reviewId: string,
    params: CreateUploadParams,
    options?: CallOptions,
  ): Promise<WithMeta<MediaUpload>> {
    return this.one(
      "createMediaUpload",
      [reviewId],
      // After the spread: an explicit `clientUploadId: undefined` must not remove the retry key.
      { ...params, clientUploadId: params.clientUploadId ?? globalThis.crypto.randomUUID() },
      options,
      MEDIA_UPLOAD_SPEC,
    );
  }

  /**
   * Confirms the PUT and returns the ready media (retry-safe; `complete_in_progress` and
   * `upload_changed` are retried).
   */
  complete(reviewId: string, mediaId: string, options?: CallOptions): Promise<WithMeta<Media>> {
    return this.one("completeMediaUpload", [reviewId, mediaId], {}, options, SPECS.Media);
  }

  delete(reviewId: string, mediaId: string, options?: CallOptions): Promise<WithMeta<Media>> {
    return this.one("deleteMedia", [reviewId, mediaId], {}, options, SPECS.Media);
  }

  /** Approves the media item, guarded by the review version the moderator saw. */
  approve(
    reviewId: string,
    mediaId: string,
    params: VersionGuard & ModerationParams,
    options?: CallOptions,
  ): Promise<WithMeta<Media>> {
    return this.one("approveMedia", [reviewId, mediaId], params, options, SPECS.Media);
  }

  reject(
    reviewId: string,
    mediaId: string,
    params: ModerationParams = {},
    options?: CallOptions,
  ): Promise<WithMeta<Media>> {
    return this.one("rejectMedia", [reviewId, mediaId], params, options, SPECS.Media);
  }
}
