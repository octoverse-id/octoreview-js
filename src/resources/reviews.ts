import {
  type Page,
  REVIEW_SPEC,
  type Review,
  type Revision,
  SPECS,
  type WithMeta,
} from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/**
 * Filters of reviews.list. Without `authorId` or `includeUnpublished` only published reviews are
 * listed; `includeUnpublished` needs the reviews:moderate scope.
 */
export interface ListReviewsParams {
  entityId?: string;
  entityType?: string;
  externalId?: string;
  authorId?: string;
  includeUnpublished?: boolean;
  status?: "pending" | "published" | "rejected" | "hidden" | "removed";
  rating?: number;
  hasMedia?: boolean;
  isVerifiedPurchase?: boolean;
  hasPendingRevision?: boolean;
  mediaModerationStatus?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

/**
 * reviews.create: a review of the entity named by `entityId`, or by `entityType` and
 * `externalId` (upserted). Derive `authorId` from your own authenticated user, never from
 * request input.
 */
export interface CreateReviewParams {
  authorId: string;
  rating: number;
  entityId?: string;
  entityType?: string;
  externalId?: string;
  title?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown>;
  authorMetadata?: Record<string, unknown>;
  sourceRef?: string;
  isVerifiedPurchase?: boolean;
}

/** reviews.get: published only, unless `authorId` (the author's own) or `includeUnpublished` (a moderator). */
export interface GetReviewParams {
  authorId?: string;
  includeUnpublished?: boolean;
}

/** reviews.update: only the given fields change; null clears title or body. */
export interface UpdateReviewParams {
  rating?: number;
  title?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown>;
  authorMetadata?: Record<string, unknown>;
  isVerifiedPurchase?: boolean;
}

/** The version guard: the review's `version` and `mediaVersion` as the moderator saw them. */
export interface VersionGuard {
  expectedVersion: number;
  expectedMediaVersion: number;
}

/** An optional moderation reason. */
export interface ModerationParams {
  reason?: string;
}

/**
 * Reviews: create, read, edit and moderate. The calls that make content public (publish,
 * approveRevision) take the version the moderator saw; a review that changed since throws
 * ApiError `review_changed` (`isReviewChanged()`).
 */
export class ReviewsService extends Service {
  list(params: ListReviewsParams = {}, options?: CallOptions): Promise<Page<Review>> {
    return this.page("listReviews", [], params, options, REVIEW_SPEC);
  }

  /**
   * Not retried: after a lost response, list the author's reviews to learn whether it exists (a
   * repeat answers 409 `review_exists`).
   */
  create(params: CreateReviewParams, options?: CallOptions): Promise<WithMeta<Review>> {
    return this.one("createReview", [], params, options, REVIEW_SPEC);
  }

  get(
    reviewId: string,
    params: GetReviewParams = {},
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("getReview", [reviewId], params, options, REVIEW_SPEC);
  }

  /** Under pre-moderation an edit of a published review becomes a pending revision. */
  update(
    reviewId: string,
    params: UpdateReviewParams,
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("updateReview", [reviewId], params, options, REVIEW_SPEC);
  }

  /** The author withdraws the review. */
  remove(reviewId: string, options?: CallOptions): Promise<WithMeta<Review>> {
    return this.one("removeReview", [reviewId], {}, options, REVIEW_SPEC);
  }

  /** Publishes the review exactly as the moderator saw it. */
  publish(
    reviewId: string,
    params: VersionGuard & ModerationParams,
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("publishReview", [reviewId], params, options, REVIEW_SPEC);
  }

  reject(
    reviewId: string,
    params: ModerationParams = {},
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("rejectReview", [reviewId], params, options, REVIEW_SPEC);
  }

  hide(
    reviewId: string,
    params: ModerationParams = {},
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("hideReview", [reviewId], params, options, REVIEW_SPEC);
  }

  /** The pending edit of a published review; none throws ApiError `revision_not_found`. */
  getRevision(reviewId: string, options?: CallOptions): Promise<WithMeta<Revision>> {
    return this.one("getReviewRevision", [reviewId], {}, options, SPECS.Revision);
  }

  /** Applies the pending edit, guarded by the version the moderator saw. */
  approveRevision(
    reviewId: string,
    params: VersionGuard & { revisionId: string },
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("approveReviewRevision", [reviewId], params, options, REVIEW_SPEC);
  }

  rejectRevision(
    reviewId: string,
    params: { revisionId: string },
    options?: CallOptions,
  ): Promise<WithMeta<Review>> {
    return this.one("rejectReviewRevision", [reviewId], params, options, REVIEW_SPEC);
  }
}
