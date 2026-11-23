import { MalformedResponseError } from "./errors";
import type { ResponseMeta } from "./options";

// Response models: camelCase interfaces, each decoded from the server's snake_case JSON by a
// field spec. TypeScript checks that every spec covers every property of its interface, and the
// contract gate checks each spec's wire names against the contract's response schemas.

/** A list's limit/offset window and the total count. */
export interface Pagination {
  limit: number;
  offset: number;
  count: number;
}

/** An entity's published-review aggregate. `ratingAverage` has two decimals; null when the count is 0. */
export interface RatingSummary {
  ratingCount: number;
  ratingAverage: number | null;
  /** Star ("1".."5") to count. */
  histogram: Record<string, number>;
  /** Star ("1".."5") to percent. */
  histogramPercent: Record<string, number>;
  verifiedReviewCount: number;
}

/** An entity's rating summary. */
export interface EntityRating extends RatingSummary {
  entityId: string;
}

/** One external id's summary in a ratings query; `entityId` is null when the entity does not exist yet. */
export interface BatchRating extends RatingSummary {
  externalId: string;
  entityId: string | null;
  namespaceType: string | null;
  namespaceId: string | null;
}

/** An entity's media overrides; null inherits the application, then the server. */
export interface MediaPolicy {
  maxImages: number | null;
  maxVideos: number | null;
  maxImageBytes: number | null;
  maxVideoBytes: number | null;
}

/** An external resource that can be reviewed, such as product/sku-1. */
export interface Entity {
  id: string;
  tenantId: string;
  applicationId: string;
  namespaceType: string | null;
  namespaceId: string | null;
  entityType: string;
  externalId: string;
  metadata: Record<string, unknown>;
  isActive: boolean;
  mediaPolicy: MediaPolicy;
  rating: RatingSummary;
  createdAt: Date;
  updatedAt: Date;
}

/** An application's media policy defaults, moderation mode and storage quota. */
export interface ApplicationSettings {
  tenantId: string;
  applicationId: string;
  maxImages: number | null;
  maxVideos: number | null;
  maxImageBytes: number | null;
  maxVideoBytes: number | null;
  allowedContentTypes: string[] | null;
  moderationMode: string | null;
  maxStorageBytes: number | null;
  storedBytes: number;
  reservedBytes: number;
}

/**
 * One image or video of a review. `url` is null when the caller may not see it, or when signing
 * failed (`urlUnavailable` "signing").
 */
export interface Media {
  id: string;
  reviewId: string;
  kind: string;
  status: string;
  moderationStatus: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  position: number;
  uploadExpiresAt: Date | null;
  createdAt: Date;
  url: string | null;
  urlExpiresAt: Date | null;
  urlUnavailable: string | null;
}

/**
 * One review of an entity. Pass `version` and `mediaVersion` as the moderator saw them to
 * publish, approveRevision and media.approve.
 */
export interface Review {
  id: string;
  tenantId: string;
  applicationId: string;
  namespaceType: string | null;
  namespaceId: string | null;
  entityId: string;
  entityType: string;
  externalId: string;
  authorId: string;
  authorMetadata: Record<string, unknown>;
  rating: number;
  title: string | null;
  body: string | null;
  status: string;
  statusReason: string | null;
  metadata: Record<string, unknown>;
  sourceRef: string | null;
  isVerifiedPurchase: boolean;
  version: number;
  mediaVersion: number;
  media: Media[];
  mediaTruncated: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An edit to a published review waiting for moderation. */
export interface Revision {
  id: string;
  reviewId: string;
  rating: number;
  title: string | null;
  body: string | null;
  baseVersion: number;
  createdAt: Date;
}

/** Where to PUT a media file: send exactly `headers` plus an explicit Content-Length, never the service key. */
export interface UploadTarget {
  method: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

/** An upload intent's answer; `upload` is null when a replayed intent is no longer uploadable. */
export interface MediaUpload {
  media: Media;
  upload: UploadTarget | null;
}

/** One erasure batch; call erase again while `remaining` is above 0. */
export interface EraseResult {
  reviewsRedacted: number;
  pendingMediaDeletes: number;
  remaining: number;
}

/** One recorded change. */
export interface AuditLog {
  id: string;
  tenantId: string;
  applicationId: string | null;
  namespaceType: string | null;
  namespaceId: string | null;
  action: string;
  aggregateType: string;
  aggregateId: string;
  actorId: string | null;
  requestId: string | null;
  operationId: string;
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** The liveness probe's answer: `status` is "ok" while the process serves. */
export interface HealthLive {
  status: string;
}

/**
 * The readiness probe's answer: `status` "ok" or "unavailable", `database` "ok" or "down". A
 * down database is an answer (HTTP 503), not an error.
 */
export interface HealthReady {
  status: string;
  database: string;
}

/** A single result with what its response said about itself. */
export type WithMeta<T> = T & { readonly meta: ResponseMeta };

/** One page of a list operation. */
export interface Page<T> {
  items: T[];
  pagination: Pagination;
  meta: ResponseMeta;
}

// --- decoding ----------------------------------------------------------------------------------

/** @internal */
export type Reader<T> = (value: unknown, field: string) => T;

/** For each model property, its wire name and how to read it. @internal */
export type Spec<T> = { readonly [K in keyof T]-?: readonly [wire: string, read: Reader<T[K]>] };

function fail(field: string, what: string): never {
  throw new MalformedResponseError(`octoreview: the response's ${field} is not ${what}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (v, f) => (v === null || v === undefined ? null : read(v, f));
}

const str: Reader<string> = (v, f) => (typeof v === "string" ? v : fail(f, "a string"));
const int: Reader<number> = (v, f) => (Number.isInteger(v) ? (v as number) : fail(f, "an integer"));
const num: Reader<number> = (v, f) => (typeof v === "number" ? v : fail(f, "a number"));
const bool: Reader<boolean> = (v, f) => (typeof v === "boolean" ? v : fail(f, "a boolean"));
const map: Reader<Record<string, unknown>> = (v, f) => (isObject(v) ? v : fail(f, "an object"));
const numberMap: Reader<Record<string, number>> = (v, f) =>
  Object.fromEntries(Object.entries(map(v, f)).map(([k, n]) => [k, num(n, `${f}.${k}`)]));
const stringMap: Reader<Record<string, string>> = (v, f) =>
  Object.fromEntries(Object.entries(map(v, f)).map(([k, s]) => [k, str(s, `${f}.${k}`)]));
const time: Reader<Date> = (v, f) => {
  const date = typeof v === "string" ? new Date(v) : null;
  return date && !Number.isNaN(date.getTime()) ? date : fail(f, "a timestamp");
};
const stringList: Reader<string[]> = (v, f) =>
  Array.isArray(v) ? v.map((s, i) => str(s, `${f}[${i}]`)) : fail(f, "a list");

/** @internal */
export function decode<T>(spec: Spec<T>, value: unknown, where: string): T {
  if (!isObject(value)) {
    fail(where, "an object");
  }
  const out: Partial<T> = {};
  for (const key of Object.keys(spec) as (keyof T)[]) {
    const [wire, read] = spec[key];
    out[key] = read(value[wire], `${where}.${wire}`);
  }
  return out as T;
}

function model<T>(spec: Spec<T>): Reader<T> {
  return (v, f) => decode(spec, v, f);
}

function list<T>(read: Reader<T>): Reader<T[]> {
  return (v, f) =>
    Array.isArray(v) ? v.map((item, i) => read(item, `${f}[${i}]`)) : fail(f, "a list");
}

const ratingFields = {
  ratingCount: ["rating_count", int],
  ratingAverage: ["rating_average", nullable(num)],
  histogram: ["histogram", numberMap],
  histogramPercent: ["histogram_percent", numberMap],
  verifiedReviewCount: ["verified_review_count", int],
} as const satisfies Spec<RatingSummary>;

/** Every model's field spec, by model name. @internal */
export const SPECS = {
  Pagination: {
    limit: ["limit", int],
    offset: ["offset", int],
    count: ["count", int],
  } satisfies Spec<Pagination>,
  RatingSummary: ratingFields satisfies Spec<RatingSummary>,
  EntityRating: { entityId: ["entity_id", str], ...ratingFields } satisfies Spec<EntityRating>,
  BatchRating: {
    externalId: ["external_id", str],
    entityId: ["entity_id", nullable(str)],
    namespaceType: ["namespace_type", nullable(str)],
    namespaceId: ["namespace_id", nullable(str)],
    ...ratingFields,
  } satisfies Spec<BatchRating>,
  MediaPolicy: {
    maxImages: ["max_images", nullable(int)],
    maxVideos: ["max_videos", nullable(int)],
    maxImageBytes: ["max_image_bytes", nullable(int)],
    maxVideoBytes: ["max_video_bytes", nullable(int)],
  } satisfies Spec<MediaPolicy>,
  ApplicationSettings: {
    tenantId: ["tenant_id", str],
    applicationId: ["application_id", str],
    maxImages: ["max_images", nullable(int)],
    maxVideos: ["max_videos", nullable(int)],
    maxImageBytes: ["max_image_bytes", nullable(int)],
    maxVideoBytes: ["max_video_bytes", nullable(int)],
    allowedContentTypes: ["allowed_content_types", nullable(stringList)],
    moderationMode: ["moderation_mode", nullable(str)],
    maxStorageBytes: ["max_storage_bytes", nullable(int)],
    storedBytes: ["stored_bytes", int],
    reservedBytes: ["reserved_bytes", int],
  } satisfies Spec<ApplicationSettings>,
  Media: {
    id: ["id", str],
    reviewId: ["review_id", str],
    kind: ["kind", str],
    status: ["status", str],
    moderationStatus: ["moderation_status", str],
    contentType: ["content_type", str],
    sizeBytes: ["size_bytes", int],
    width: ["width", nullable(int)],
    height: ["height", nullable(int)],
    durationSeconds: ["duration_seconds", nullable(num)],
    position: ["position", int],
    uploadExpiresAt: ["upload_expires_at", nullable(time)],
    createdAt: ["created_at", time],
    url: ["url", nullable(str)],
    urlExpiresAt: ["url_expires_at", nullable(time)],
    urlUnavailable: ["url_unavailable", nullable(str)],
  } satisfies Spec<Media>,
  Revision: {
    id: ["id", str],
    reviewId: ["review_id", str],
    rating: ["rating", int],
    title: ["title", nullable(str)],
    body: ["body", nullable(str)],
    baseVersion: ["base_version", int],
    createdAt: ["created_at", time],
  } satisfies Spec<Revision>,
  UploadTarget: {
    method: ["method", str],
    url: ["url", str],
    headers: ["headers", stringMap],
    expiresAt: ["expires_at", time],
  } satisfies Spec<UploadTarget>,
  EraseResult: {
    reviewsRedacted: ["reviews_redacted", int],
    pendingMediaDeletes: ["pending_media_deletes", int],
    remaining: ["remaining", int],
  } satisfies Spec<EraseResult>,
  AuditLog: {
    id: ["id", str],
    tenantId: ["tenant_id", str],
    applicationId: ["application_id", nullable(str)],
    namespaceType: ["namespace_type", nullable(str)],
    namespaceId: ["namespace_id", nullable(str)],
    action: ["action", str],
    aggregateType: ["aggregate_type", str],
    aggregateId: ["aggregate_id", str],
    actorId: ["actor_id", nullable(str)],
    requestId: ["request_id", nullable(str)],
    operationId: ["operation_id", str],
    changes: ["changes", map],
    metadata: ["metadata", map],
    createdAt: ["created_at", time],
  } satisfies Spec<AuditLog>,
  HealthLive: { status: ["status", str] } satisfies Spec<HealthLive>,
  HealthReady: { status: ["status", str], database: ["database", str] } satisfies Spec<HealthReady>,
} as const;

/** Specs that nest other specs. @internal */
export const ENTITY_SPEC = {
  id: ["id", str],
  tenantId: ["tenant_id", str],
  applicationId: ["application_id", str],
  namespaceType: ["namespace_type", nullable(str)],
  namespaceId: ["namespace_id", nullable(str)],
  entityType: ["entity_type", str],
  externalId: ["external_id", str],
  metadata: ["metadata", map],
  isActive: ["is_active", bool],
  mediaPolicy: ["media_policy", model(SPECS.MediaPolicy)],
  rating: ["rating", model(SPECS.RatingSummary)],
  createdAt: ["created_at", time],
  updatedAt: ["updated_at", time],
} as const satisfies Spec<Entity>;

/** @internal */
export const REVIEW_SPEC = {
  id: ["id", str],
  tenantId: ["tenant_id", str],
  applicationId: ["application_id", str],
  namespaceType: ["namespace_type", nullable(str)],
  namespaceId: ["namespace_id", nullable(str)],
  entityId: ["entity_id", str],
  entityType: ["entity_type", str],
  externalId: ["external_id", str],
  authorId: ["author_id", str],
  authorMetadata: ["author_metadata", map],
  rating: ["rating", int],
  title: ["title", nullable(str)],
  body: ["body", nullable(str)],
  status: ["status", str],
  statusReason: ["status_reason", nullable(str)],
  metadata: ["metadata", map],
  sourceRef: ["source_ref", nullable(str)],
  isVerifiedPurchase: ["is_verified_purchase", bool],
  version: ["version", int],
  mediaVersion: ["media_version", int],
  media: ["media", list(model(SPECS.Media))],
  mediaTruncated: ["media_truncated", bool],
  publishedAt: ["published_at", nullable(time)],
  createdAt: ["created_at", time],
  updatedAt: ["updated_at", time],
} as const satisfies Spec<Review>;

/** @internal */
export const MEDIA_UPLOAD_SPEC = {
  media: ["media", model(SPECS.Media)],
  upload: ["upload", nullable(model(SPECS.UploadTarget))],
} as const satisfies Spec<MediaUpload>;
