import { MEDIA_UPLOAD_SPEC, type Media, type MediaUpload, SPECS, type WithMeta } from "../models";
import type { CallOptions } from "../options";
import type { ModerationParams, VersionGuard } from "./reviews";
import { Service } from "./service";

/** media.list: as reviews.get, the author's own or a moderator's view. */
export interface ListMediaParams {
  authorId?: string;
  includeUnpublished?: boolean;
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
 * Review images and videos. The upload is three steps: createUpload (the intent), a PUT of the
 * bytes to `upload.url` with exactly `upload.headers`, then complete.
 */
export class MediaService extends Service {
  list(reviewId: string, params: ListMediaParams = {}, options?: CallOptions): Promise<Media[]> {
    return this.many("listReviewMedia", [reviewId], params, options, SPECS.Media);
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
