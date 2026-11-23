import { OctoreviewError } from "./errors";
import { decode, type Spec } from "./models";

/** Event types (the server's docs/events.md); the contract gate checks them against the vendored copy. */
export const EventType = {
  REVIEW_CREATED: "review.created",
  REVIEW_UPDATED: "review.updated",
  REVIEW_REVISION_SUBMITTED: "review.revision_submitted",
  REVIEW_STATUS_CHANGED: "review.status_changed",
  REVIEW_PUBLISHED: "review.published",
  REVIEW_REMOVED: "review.removed",
  MEDIA_READY: "review_media.ready",
  MEDIA_INVALID: "review_media.invalid",
  MEDIA_DELETED: "review_media.deleted",
  MEDIA_MODERATED: "review_media.moderated",
  ENTITY_RATING_CHANGED: "entity.rating_changed",
  AUTHOR_ERASED: "author.erased",
} as const;

/** One of the server's event types. */
export type EventType = (typeof EventType)[keyof typeof EventType];

/** The types whose payload is a ReviewEvent. */
export const REVIEW_EVENTS: readonly string[] = [
  EventType.REVIEW_CREATED,
  EventType.REVIEW_UPDATED,
  EventType.REVIEW_REVISION_SUBMITTED,
  EventType.REVIEW_STATUS_CHANGED,
  EventType.REVIEW_PUBLISHED,
  EventType.REVIEW_REMOVED,
];

/** The types whose payload is a MediaEvent. */
export const MEDIA_EVENTS: readonly string[] = [
  EventType.MEDIA_READY,
  EventType.MEDIA_INVALID,
  EventType.MEDIA_DELETED,
  EventType.MEDIA_MODERATED,
];

/** The header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = "X-Octoreview-Signature";

/** How far a signature's timestamp may be from the clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * A webhook whose signature header is missing, malformed, from the wrong secret, or outside the
 * tolerance. Reject the delivery with a 4xx.
 */
export class InvalidSignatureError extends OctoreviewError {}

/**
 * The payload of every review.* event. Compare `version` and `mediaVersion` with what you stored
 * before applying it: events have no global order.
 */
export interface ReviewEvent {
  reviewId: string;
  entityId: string;
  entityType: string;
  externalId: string;
  status: string;
  previousStatus: string | null;
  rating: number;
  isVerifiedPurchase: boolean;
  version: number;
  mediaVersion: number;
}

/** The payload of every review_media.* event; `reason` is set on review_media.invalid. */
export interface MediaEvent {
  mediaId: string;
  reviewId: string;
  entityId: string;
  kind: string;
  status: string;
  moderationStatus: string;
  reason: string | null;
}

/** entity.rating_changed: replace your stored summary with it. */
export interface RatingChangedEvent {
  entityId: string;
  entityType: string;
  externalId: string;
  ratingCount: number;
  ratingAverage: number | null;
  histogram: Record<string, number>;
  verifiedReviewCount: number;
}

/**
 * author.erased: delete every copy you hold of this author's reviews and personal data, and drop
 * older events about the author that arrive later.
 */
export interface AuthorErasedEvent {
  authorId: string;
  erasedAt: Date;
  reviewsRedacted: number;
}

type Raw = Record<string, unknown>;

const str = (v: unknown, f: string): string => {
  if (typeof v !== "string")
    throw new OctoreviewError(`octoreview: the event's ${f} is not a string`);
  return v;
};
const nstr = (v: unknown, f: string): string | null =>
  v === null || v === undefined ? null : str(v, f);
const int = (v: unknown, f: string): number => {
  if (!Number.isInteger(v))
    throw new OctoreviewError(`octoreview: the event's ${f} is not an integer`);
  return v as number;
};
const nnum = (v: unknown, f: string): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number")
    throw new OctoreviewError(`octoreview: the event's ${f} is not a number`);
  return v;
};
const bool = (v: unknown, f: string): boolean => {
  if (typeof v !== "boolean")
    throw new OctoreviewError(`octoreview: the event's ${f} is not a boolean`);
  return v;
};
const counts = (v: unknown, f: string): Record<string, number> => {
  if (typeof v !== "object" || v === null)
    throw new OctoreviewError(`octoreview: the event's ${f} is not an object`);
  return Object.fromEntries(Object.entries(v as Raw).map(([k, n]) => [k, int(n, `${f}.${k}`)]));
};
const time = (v: unknown, f: string): Date => {
  const date = new Date(str(v, f));
  if (Number.isNaN(date.getTime()))
    throw new OctoreviewError(`octoreview: the event's ${f} is not a timestamp`);
  return date;
};

/** Each payload's field spec, by payload name. @internal */
export const EVENT_SPECS = {
  ReviewEvent: {
    reviewId: ["review_id", str],
    entityId: ["entity_id", str],
    entityType: ["entity_type", str],
    externalId: ["external_id", str],
    status: ["status", str],
    previousStatus: ["previous_status", nstr],
    rating: ["rating", int],
    isVerifiedPurchase: ["is_verified_purchase", bool],
    version: ["version", int],
    mediaVersion: ["media_version", int],
  } satisfies Spec<ReviewEvent>,
  MediaEvent: {
    mediaId: ["media_id", str],
    reviewId: ["review_id", str],
    entityId: ["entity_id", str],
    kind: ["kind", str],
    status: ["status", str],
    moderationStatus: ["moderation_status", str],
    reason: ["reason", nstr],
  } satisfies Spec<MediaEvent>,
  RatingChangedEvent: {
    entityId: ["entity_id", str],
    entityType: ["entity_type", str],
    externalId: ["external_id", str],
    ratingCount: ["rating_count", int],
    ratingAverage: ["rating_average", nnum],
    histogram: ["histogram", counts],
    verifiedReviewCount: ["verified_review_count", int],
  } satisfies Spec<RatingChangedEvent>,
  AuthorErasedEvent: {
    authorId: ["author_id", str],
    erasedAt: ["erased_at", time],
    reviewsRedacted: ["reviews_redacted", int],
  } satisfies Spec<AuthorErasedEvent>,
} as const;

/**
 * One delivered outbox event. `data` is the type's thin payload: decode it with review(), media(),
 * ratingChanged() or authorErased(). Deduplicate on `id` (delivery is at least once).
 */
export class WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly applicationId: string | null;
  readonly namespaceType: string | null;
  readonly namespaceId: string | null;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly requestId: string | null;
  readonly data: Raw;

  constructor(event: Raw) {
    this.id = str(event.id, "id");
    this.type = str(event.type, "type");
    this.occurredAt = time(event.occurred_at, "occurred_at");
    this.tenantId = str(event.tenant_id, "tenant_id");
    this.applicationId = nstr(event.application_id, "application_id");
    this.namespaceType = nstr(event.namespace_type, "namespace_type");
    this.namespaceId = nstr(event.namespace_id, "namespace_id");
    this.resourceType = str(event.resource_type, "resource_type");
    this.resourceId = str(event.resource_id, "resource_id");
    this.requestId = nstr(event.request_id, "request_id");
    if (typeof event.data !== "object" || event.data === null) {
      throw new OctoreviewError("octoreview: the event has no data object");
    }
    this.data = event.data as Raw;
  }

  /** A review.* payload. */
  review(): ReviewEvent {
    return this.payload(REVIEW_EVENTS, "ReviewEvent", EVENT_SPECS.ReviewEvent);
  }

  /** A review_media.* payload. */
  media(): MediaEvent {
    return this.payload(MEDIA_EVENTS, "MediaEvent", EVENT_SPECS.MediaEvent);
  }

  /** An entity.rating_changed payload. */
  ratingChanged(): RatingChangedEvent {
    return this.payload(
      [EventType.ENTITY_RATING_CHANGED],
      "RatingChangedEvent",
      EVENT_SPECS.RatingChangedEvent,
    );
  }

  /** An author.erased payload. */
  authorErased(): AuthorErasedEvent {
    return this.payload(
      [EventType.AUTHOR_ERASED],
      "AuthorErasedEvent",
      EVENT_SPECS.AuthorErasedEvent,
    );
  }

  private payload<T>(types: readonly string[], name: string, spec: Spec<T>): T {
    if (!types.includes(this.type)) {
      throw new TypeError(`octoreview: a ${this.type} event has no ${name} payload`);
    }
    return decode(spec, this.data, "data");
  }
}

/** Options of verifyWebhook. */
export interface VerifyOptions {
  /** How far the signature's timestamp may be from the clock (default 300 s). */
  toleranceSeconds?: number;
  /** The clock in unix seconds, for tests. */
  now?: number;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return null;
  }
  return Uint8Array.from(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

/**
 * Checks a delivery's X-Octoreview-Signature against the raw request body and the webhook secret
 * (constant time through WebCrypto, 300 s tolerance), then decodes the event. Verify before you
 * parse, and pass the body exactly as received.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  if (!secret) {
    throw new TypeError("octoreview: the webhook secret is empty");
  }
  let timestamp: string | null = null;
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined) {
      timestamp = value;
    } else if (key === "v1" && value !== undefined) {
      const bytes = hexBytes(value); // a malformed candidate cannot match; it is skipped
      if (bytes) signatures.push(bytes);
    }
  }
  if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new InvalidSignatureError(
      "octoreview: invalid webhook signature: the header is not t=<seconds>,v1=<hex>",
    );
  }
  const encoder = new TextEncoder();
  const raw = typeof body === "string" ? encoder.encode(body) : body;
  const signed = new Uint8Array(timestamp.length + 1 + raw.byteLength);
  signed.set(encoder.encode(`${timestamp}.`), 0);
  signed.set(raw, timestamp.length + 1);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let matched = false;
  for (const candidate of signatures) {
    // subtle.verify compares in constant time; check every candidate (one per rotated secret).
    matched = (await globalThis.crypto.subtle.verify("HMAC", key, candidate, signed)) || matched;
  }
  if (!matched) {
    throw new InvalidSignatureError(
      "octoreview: invalid webhook signature: no v1 signature matches this secret and body",
    );
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const skew = (options.now ?? Math.floor(Date.now() / 1000)) - Number(timestamp);
  if (Math.abs(skew) > tolerance) {
    throw new InvalidSignatureError(
      `octoreview: invalid webhook signature: the timestamp is ${skew} s from this clock (tolerance ${tolerance} s)`,
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    throw new OctoreviewError("octoreview: the webhook body is not JSON");
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new OctoreviewError("octoreview: the webhook body is not a JSON object");
  }
  return new WebhookEvent(event as Raw);
}

/** Webhook verification as a client method; verifyWebhook() is the same without a client. */
export class WebhooksService {
  verify(
    body: string | Uint8Array,
    signatureHeader: string,
    secret: string,
    options?: VerifyOptions,
  ): Promise<WebhookEvent> {
    return verifyWebhook(body, signatureHeader, secret, options);
  }
}
