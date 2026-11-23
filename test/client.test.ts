import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConfigurationError,
  ErrorCode,
  MalformedResponseError,
  NotModifiedError,
  Octoreview,
  OctoreviewError,
  type OctoreviewOptions,
  TransportError,
} from "../src";
import { fixture } from "./support/contract";
import { type Answer, apiError, networkFailure, Recorder } from "./support/recorder";

const ok = (id: string, headers: Record<string, string> = {}): Answer => ({
  status: 200,
  body: fixture(id),
  headers,
});

function client(http: Recorder, options: Partial<OctoreviewOptions> = {}): Octoreview {
  return new Octoreview({
    baseUrl: "https://reviews.example.com",
    apiKey: "ocr_live_secret",
    tenantId: "mbizmarket",
    applicationId: "storefront",
    adapter: http.adapter,
    ...options,
  });
}

/** Settles a promise into a value or an error, so fake timers can run while it is pending. */
function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a read on 503 and 429, honoring Retry-After", async () => {
    const http = new Recorder().push(
      apiError(503, ErrorCode.STORAGE_UNAVAILABLE, {}, { "Retry-After": "2" }),
      apiError(429, "throttled"),
      ok("getEntity"),
    );
    const result = settle(client(http).entities.get("e-1"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(http.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(http.requests).toHaveLength(2);
    await vi.runAllTimersAsync();
    const { value } = await result;
    expect(value?.entityType).toBe("product");
    expect(http.requests).toHaveLength(3);
  });

  it("does not wait for a Retry-After longer than the bound", async () => {
    const http = new Recorder().push(
      apiError(503, ErrorCode.STORAGE_UNAVAILABLE, {}, { "Retry-After": "120" }),
    );
    const { error } = await settle(client(http).entities.get("e-1"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfter).toBe(120);
    expect(http.requests).toHaveLength(1);
  });

  it("never retries an unsafe write", async () => {
    const http = new Recorder().push(apiError(503, ErrorCode.STORAGE_UNAVAILABLE));
    const { error } = await settle(
      client(http).reviews.create({ authorId: "u-1", rating: 5, entityId: "e-1" }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(http.requests).toHaveLength(1);
  });

  it("retries a network failure for an idempotent call only", async () => {
    const refused = () => networkFailure("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443");
    const http = new Recorder().push(refused(), ok("deactivateEntity"));
    const deactivated = settle(client(http).entities.deactivate("e-1"));
    await vi.runAllTimersAsync();
    expect((await deactivated).value?.isActive).toBe(false);
    expect(http.requests).toHaveLength(2);

    http.push(refused());
    const { error } = await settle(client(http).reviews.remove("r-1"));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).networkFailure).toBe(true);
    expect((error as TransportError).errorCode).toBe("ECONNREFUSED");
    expect(http.requests).toHaveLength(3);
  });

  it("retries complete's documented conflicts, and only those", async () => {
    const http = new Recorder().push(
      apiError(409, ErrorCode.COMPLETE_IN_PROGRESS, {}, { "Retry-After": "1" }),
      apiError(409, ErrorCode.UPLOAD_CHANGED),
      ok("completeMediaUpload"),
    );
    const completed = settle(client(http).media.complete("r-1", "m-1"));
    await vi.runAllTimersAsync();
    expect((await completed).value?.status).toBe("ready");
    expect(http.requests).toHaveLength(3);

    http.push(apiError(409, ErrorCode.UPLOAD_EXPIRED));
    const { error } = await settle(client(http).media.complete("r-1", "m-1"));
    expect((error as ApiError).code).toBe(ErrorCode.UPLOAD_EXPIRED);
  });

  it("bounds the attempts", async () => {
    const http = new Recorder().push(
      ...Array.from({ length: 3 }, () => apiError(503, ErrorCode.STORAGE_UNAVAILABLE)),
    );
    const result = settle(client(http).entities.get("e-1"));
    await vi.runAllTimersAsync();
    expect((await result).error).toBeInstanceOf(ApiError);
    expect(http.requests).toHaveLength(3);
  });

  it("reuses the generated client upload id on every retry", async () => {
    const http = new Recorder().push(
      apiError(503, ErrorCode.STORAGE_UNAVAILABLE),
      ok("createMediaUpload"),
    );
    const result = settle(
      client(http).media.createUpload("r-1", {
        kind: "image",
        contentType: "image/png",
        sizeBytes: 1024,
      }),
    );
    await vi.runAllTimersAsync();
    expect((await result).value?.upload).not.toBeNull();
    const [first, second] = http.requests.map(
      (r) => (JSON.parse(r.body ?? "{}") as { client_upload_id: string }).client_upload_id,
    );
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  it("keeps a retry key when the caller passes clientUploadId: undefined", async () => {
    const http = new Recorder().push(
      apiError(503, ErrorCode.STORAGE_UNAVAILABLE),
      ok("createMediaUpload"),
    );
    const result = settle(
      client(http).media.createUpload("r-1", {
        kind: "image",
        contentType: "image/png",
        sizeBytes: 3,
        clientUploadId: undefined,
      }),
    );
    await vi.runAllTimersAsync();
    await result;
    const keys = http.requests.map(
      (r) => (JSON.parse(r.body ?? "{}") as { client_upload_id?: string }).client_upload_id,
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("stops waiting when the call is aborted", async () => {
    const http = new Recorder().push(
      apiError(503, ErrorCode.STORAGE_UNAVAILABLE, {}, { "Retry-After": "10" }),
    );
    const controller = new AbortController();
    const result = settle(client(http).entities.get("e-1", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const { error } = await result;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
    expect(http.requests).toHaveLength(1);
  });
});

describe("requests", () => {
  it("lets the call application win over the client default", async () => {
    const http = new Recorder().push(ok("getEntity"), ok("createReview"));
    const c = client(http);
    await c.entities.get("e-1", { applicationId: "backoffice" });
    expect(http.last.url.search).toBe("?application_id=backoffice");
    await c.reviews.create({ authorId: "u-1", rating: 4, entityId: "e-1" });
    expect((JSON.parse(http.last.body ?? "") as { application_id: string }).application_id).toBe(
      "storefront",
    );
  });

  it("refuses a missing application before sending", async () => {
    const http = new Recorder();
    await expect(
      client(http, { applicationId: undefined }).reviews.create({
        authorId: "u-1",
        rating: 4,
        entityId: "e-1",
      }),
    ).rejects.toThrow(/needs an application/);
    expect(http.requests).toHaveLength(0);
  });

  it("applies namespace defaults, overrides and the global scope", async () => {
    const http = new Recorder().push(ok("getEntity"), ok("getEntity"), ok("getEntity"));
    const c = client(http, { namespace: { type: "store", id: "s-1" } });
    await c.entities.get("e-1");
    expect([http.last.headers["x-namespace-type"], http.last.headers["x-namespace-id"]]).toEqual([
      "store",
      "s-1",
    ]);
    await c.entities.get("e-1", { namespace: { type: "store", id: "s-2" } });
    expect(http.last.headers["x-namespace-id"]).toBe("s-2");
    await c.entities.get("e-1", { namespace: "global" });
    expect(http.last.headers["x-namespace-type"]).toBeUndefined();
    expect(http.last.headers["x-namespace-id"]).toBeUndefined();
  });

  it("checks parameters before sending", async () => {
    const http = new Recorder();
    const c = client(http);
    const cases: [() => Promise<unknown>, string][] = [
      [() => c.entities.list({ entityTypo: "product" } as never), "does not take entityTypo"],
      [() => c.entities.list({ applicationId: "x" } as never), "CallOptions.applicationId"],
      [() => c.entities.list({ includeGlobal: true } as never), "includeGlobal from CallOptions"],
      [() => c.reviews.getRevision("r-1", { includeGlobal: true }), "does not take includeGlobal"],
      [() => c.entities.get(""), "needs entityId"],
      [() => c.reviews.get("r-1", { reviewId: "r-2" } as never), "does not take reviewId"],
      [() => c.reviews.create({ rating: 5 } as never), "needs authorId"],
    ];
    for (const [call, message] of cases) {
      await expect(call(), message).rejects.toThrow(message);
    }
    expect(http.requests).toHaveLength(0);
  });

  it("keeps nulls and caller map keys, and sends no body where the contract has none", async () => {
    const http = new Recorder().push(ok("updateEntity"), ok("completeMediaUpload"));
    const c = client(http);
    await c.entities.update("e-1", {
      metadata: { someKey: 1 },
      maxImages: null,
      maxVideos: undefined,
    });
    expect(http.requests[0]?.body).toBe('{"metadata":{"someKey":1},"max_images":null}');
    await c.media.complete("r-1", "m-1");
    expect(http.last.body).toBeUndefined();
    expect(http.last.headers["content-type"]).toBeUndefined();
  });

  it("sends every setting on put and uses the default application", async () => {
    const http = new Recorder().push(ok("putApplicationSettings"));
    await client(http).settings.put(undefined, { maxImages: 3 });
    expect(http.last.url.pathname).toBe("/api/v1/applications/storefront/settings");
    expect(JSON.parse(http.last.body ?? "")).toEqual({
      max_images: 3,
      max_videos: null,
      max_image_bytes: null,
      max_video_bytes: null,
      allowed_content_types: null,
      moderation_mode: null,
      max_storage_bytes: null,
    });
  });

  it("sends the actor on writes only", async () => {
    const http = new Recorder().push(ok("queryRatings"), ok("upsertEntity"), ok("upsertEntity"));
    const c = client(http, { actorId: "admin-7" });
    await c.ratings.query({ entityType: "product", externalIds: ["sku-1"] });
    expect(http.last.headers["x-actor-id"], "queryRatings is a POST but a read").toBeUndefined();
    await c.entities.upsert({ entityType: "product", externalId: "sku-1" });
    expect(http.last.headers["x-actor-id"]).toBe("admin-7");
    await c.entities.upsert(
      { entityType: "product", externalId: "sku-1" },
      { actorId: "moderator-2", requestId: "req-x" },
    );
    expect(http.last.headers["x-actor-id"]).toBe("moderator-2");
    expect(http.last.headers["x-request-id"]).toBe("req-x");
  });

  it("escapes path values", async () => {
    const http = new Recorder().push(ok("getReview"));
    await client(http).reviews.get("a/b?c");
    expect(http.last.url.pathname).toBe("/api/v1/reviews/a%2Fb%3Fc");
  });
});

describe("results and errors", () => {
  it("carries the ETag, and a conditional read throws NotModifiedError", async () => {
    const http = new Recorder().push(ok("getEntity", { ETag: '"v1"', "X-Request-ID": "req-1" }), {
      status: 304,
      headers: { "X-Request-ID": "req-304" },
    });
    const c = client(http);
    const entity = await c.entities.get("e-1");
    expect(entity.meta).toEqual({ etag: '"v1"', requestId: "req-1" });
    expect(JSON.stringify(entity)).not.toContain("req-1"); // meta is not a model field
    const notModified = await c.entities
      .get("e-1", { ifNoneMatch: '"v1"' })
      .catch((e: unknown) => e);
    expect(notModified).toBeInstanceOf(NotModifiedError);
    expect((notModified as NotModifiedError).requestId).toBe("req-304");
    expect(http.last.headers["if-none-match"]).toBe('"v1"');
  });

  it("decodes camelCase models with dates", async () => {
    const http = new Recorder().push(ok("getReview"));
    const review = await client(http).reviews.get("r-1");
    expect(review.createdAt).toBeInstanceOf(Date);
    expect(typeof review.isVerifiedPurchase).toBe("boolean");
    expect(review.media.every((m) => typeof m.sizeBytes === "number")).toBe(true);
  });

  it("turns the error envelope into a typed ApiError", async () => {
    const http = new Recorder().push(
      apiError(409, ErrorCode.REVIEW_CHANGED, { current_version: 3 }),
    );
    const error = await client(http)
      .reviews.publish("r-1", { expectedVersion: 2, expectedMediaVersion: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect([api.status, api.code, api.requestId]).toEqual([
      409,
      "review_changed",
      "req-review_changed",
    ]);
    expect(api.isReviewChanged()).toBe(true);
    expect(api.details).toEqual({ current_version: 3 });
    expect(api.message).toContain("review_changed (HTTP 409, request id req-review_changed)");
  });

  it("types an error without an envelope", async () => {
    const http = new Recorder().push({
      status: 502,
      body: "<html>bad gateway</html>",
      headers: { "X-Request-ID": "req-gw" },
    });
    const error = (await client(http)
      .reviews.get("r-1")
      .catch((e: unknown) => e)) as ApiError;
    expect([error.status, error.code, error.requestId]).toEqual([
      502,
      "unexpected_response",
      "req-gw",
    ]);
  });

  it("types malformed success responses with the request id", async () => {
    const shapes = ['{"id": "e-1"}', '{"data": [1, 2]}', '{"data": {"id": "e-1"}}', "not json"];
    for (const body of shapes) {
      const http = new Recorder().push({
        status: 200,
        body,
        headers: { "X-Request-ID": "req-shape" },
      });
      const error = await client(http)
        .entities.get("e-1")
        .catch((e: unknown) => e);
      expect(error, body).toBeInstanceOf(MalformedResponseError);
      expect((error as MalformedResponseError).requestId, body).toBe("req-shape");
    }
    const http = new Recorder().push({
      status: 200,
      body: '{"data": []}',
      headers: { "X-Request-ID": "req-page" },
    });
    const error = (await client(http)
      .entities.list()
      .catch((e: unknown) => e)) as MalformedResponseError;
    expect(error.requestId).toBe("req-page");
  });

  it("decodes health ready's unavailable answer without credentials", async () => {
    const http = new Recorder().push({
      status: 503,
      body: { data: { status: "unavailable", database: "down" } },
    });
    const ready = await client(http).health.ready();
    expect(ready.status).toBe("unavailable");
    expect(http.last.headers.authorization).toBeUndefined();
  });

  it("never carries the key, a signature or a token", async () => {
    const secrets = ["ocr_live_secret", "X-Amz-Signature", "deadbeef", "tok123"];
    const signed = "https://bucket.s3.amazonaws.com/media/x.png?X-Amz-Signature=deadbeef";
    const http = new Recorder().push(
      networkFailure("ERR_BAD_REQUEST", `failed for Bearer ocr_live_secret at ${signed}`, signed),
      apiError(400, "validation_failed"),
    );
    const envelope = http as unknown as { queue: Answer[] };
    const body = envelope.queue[1]?.body as {
      error: { message: string; details: Record<string, unknown> };
    };
    body.error.message = `bad ocr_live_secret ${signed} /api/v1/media-uploads/tok123`;
    // A free-form details field (details.reason) can carry a signed URL too, nested or not.
    body.error.details = { reason: `fetch ${signed}`, nested: [{ key: "ocr_live_secret" }] };
    const c = client(http, { maxAttempts: 1 });
    for (const call of [() => c.entities.get("e-1"), () => c.entities.get("e-1")]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OctoreviewError);
      // What a logger prints: the message, the stack, every own property, and a cause if any.
      const rendered = [String(error), inspect(error, { depth: 10 }), JSON.stringify(error)].join(
        "\n",
      );
      for (const secret of secrets) {
        expect(rendered, secret).not.toContain(secret);
      }
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe("construction", () => {
  it("validates its options", () => {
    const base = { baseUrl: "https://x.example.com", apiKey: "k", tenantId: "t" };
    const invalid: Partial<OctoreviewOptions>[] = [
      { baseUrl: "ftp://x" },
      { baseUrl: "/relative" },
      { apiKey: "" },
      { tenantId: "" },
      { namespace: { type: "store", id: "" } },
      { maxAttempts: 0 },
    ];
    for (const change of invalid) {
      expect(() => new Octoreview({ ...base, ...change }), JSON.stringify(change)).toThrow(
        ConfigurationError,
      );
    }
  });

  it("refuses a browser unless the caller insists", () => {
    const scope = globalThis as { window?: unknown };
    scope.window = { document: {} };
    try {
      const options = { baseUrl: "https://x.example.com", apiKey: "ocr_x", tenantId: "t" };
      expect(() => new Octoreview(options)).toThrow(/browser/);
      const http = new Recorder().push(ok("getHealthLive"));
      const trusted = new Octoreview({
        ...options,
        dangerouslyAllowBrowser: true,
        adapter: http.adapter,
      });
      return trusted.health.live().then(() => {
        expect(
          http.last.headers["user-agent"],
          "browsers forbid setting User-Agent",
        ).toBeUndefined();
      });
    } finally {
      delete scope.window;
    }
  });

  it("builds from the environment", async () => {
    const env = {
      OCTOREVIEW_BASE_URL: "https://reviews.example.com",
      OCTOREVIEW_API_KEY: "ocr_x",
      OCTOREVIEW_TENANT_ID: "demo",
      OCTOREVIEW_APPLICATION_ID: "storefront",
    };
    const http = new Recorder().push(ok("getEntity"));
    await Octoreview.fromEnv({ adapter: http.adapter }, env).entities.get("e-1");
    expect(http.last.headers["x-tenant-id"]).toBe("demo");
    expect(http.last.url.search).toBe("?application_id=storefront");
    expect(() => Octoreview.fromEnv({}, { OCTOREVIEW_BASE_URL: "https://x" })).toThrow(
      "OCTOREVIEW_API_KEY, OCTOREVIEW_TENANT_ID",
    );
  });
});
