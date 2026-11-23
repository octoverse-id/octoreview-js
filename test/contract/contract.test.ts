import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CallOptions, ErrorCode, Octoreview } from "../../src";
import { ENTITY_SPEC, MEDIA_UPLOAD_SPEC, REVIEW_SPEC, SPECS, type Spec } from "../../src/models";
import { pathParams, takes } from "../../src/operation";
import { OPERATIONS } from "../../src/operations";
import { errorCodes, fixture, operations, responseData, surface } from "../support/contract";
import { Recorder } from "../support/recorder";

// The offline contract gate (`make contract`): the operation table, the surface, the error codes,
// every request and every response model are checked against the vendored server contract in
// testdata/contract, in both directions (server docs/spec.md section 18).

const RETRY_BEHAVIOR: Record<string, string> = {
  safe: "a read: retried on timeouts, 503 and 429, honoring Retry-After",
  idempotent: "repeats to the same state: retried like a read",
  keyed: "idempotent with its `clientUploadId`, which the SDK fills in: retried like a read",
  unsafe: "never retried; after a lost response, read the resource to learn the outcome",
};

const camel = (wire: string) => wire.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** A value that names its parameter, so a misrouted one shows up by name. */
function value(name: string): unknown {
  switch (name) {
    case "entity_id":
    case "review_id":
    case "media_id":
      return `v/${name}`; // path values carry a slash, which the SDK must escape
    case "include_global":
      return true;
    case "is_active":
    case "include_unpublished":
    case "has_media":
    case "is_verified_purchase":
    case "has_pending_revision":
      return false;
    case "external_ids":
    case "allowed_content_types":
      return [`v:${name}`];
    case "metadata":
    case "author_metadata":
      return { key: `v:${name}` };
    case "duration_seconds":
      return 3.5;
    default: {
      const numbers: Record<string, number> = {
        limit: 11,
        offset: 12,
        rating: 4,
        max_images: 21,
        max_videos: 22,
        max_image_bytes: 23,
        max_video_bytes: 24,
        max_storage_bytes: 25,
        size_bytes: 31,
        position: 32,
        width: 33,
        height: 34,
        expected_version: 41,
        expected_media_version: 42,
      };
      return numbers[name] ?? `v:${name}`;
    }
  }
}

/** camelCase params with self-describing values, by wire name. */
function pick(...names: string[]): never {
  return Object.fromEntries(names.map((n) => [camel(n), value(n)])) as never;
}

const v = (name: string) => value(name) as never;

type Call = (c: Octoreview, o: CallOptions) => Promise<unknown>;

/** One call per operation with every parameter set to a self-describing value. */
const CALLS: Record<string, Call> = {
  getHealthLive: (c, o) => c.health.live(o),
  getHealthReady: (c, o) => c.health.ready(o),
  listEntities: (c, o) =>
    c.entities.list(pick("entity_type", "external_id", "is_active", "limit", "offset"), o),
  upsertEntity: (c, o) =>
    c.entities.upsert(
      pick(
        "entity_type",
        "external_id",
        "metadata",
        "max_images",
        "max_videos",
        "max_image_bytes",
        "max_video_bytes",
      ),
      o,
    ),
  lookupEntity: (c, o) => c.entities.lookup(v("entity_type"), v("external_id"), o),
  getEntity: (c, o) => c.entities.get(v("entity_id"), o),
  updateEntity: (c, o) =>
    c.entities.update(
      v("entity_id"),
      pick(
        "metadata",
        "max_images",
        "max_videos",
        "max_image_bytes",
        "max_video_bytes",
        "is_active",
      ),
      o,
    ),
  deactivateEntity: (c, o) => c.entities.deactivate(v("entity_id"), o),
  getEntityRating: (c, o) => c.ratings.forEntity(v("entity_id"), o),
  queryRatings: (c, o) => c.ratings.query(pick("entity_type", "external_ids"), o),
  getApplicationSettings: (c, o) => c.settings.get(undefined, o),
  putApplicationSettings: (c, o) =>
    c.settings.put(
      undefined,
      pick(
        "max_images",
        "max_videos",
        "max_image_bytes",
        "max_video_bytes",
        "allowed_content_types",
        "moderation_mode",
        "max_storage_bytes",
      ),
      o,
    ),
  listReviews: (c, o) =>
    c.reviews.list(
      pick(
        "entity_id",
        "entity_type",
        "external_id",
        "author_id",
        "include_unpublished",
        "status",
        "rating",
        "has_media",
        "is_verified_purchase",
        "has_pending_revision",
        "media_moderation_status",
        "sort",
        "limit",
        "offset",
      ),
      o,
    ),
  createReview: (c, o) =>
    c.reviews.create(
      pick(
        "author_id",
        "rating",
        "entity_id",
        "entity_type",
        "external_id",
        "title",
        "body",
        "metadata",
        "author_metadata",
        "source_ref",
        "is_verified_purchase",
      ),
      o,
    ),
  getReview: (c, o) => c.reviews.get(v("review_id"), pick("author_id", "include_unpublished"), o),
  updateReview: (c, o) =>
    c.reviews.update(
      v("review_id"),
      pick("rating", "title", "body", "metadata", "author_metadata", "is_verified_purchase"),
      o,
    ),
  removeReview: (c, o) => c.reviews.remove(v("review_id"), o),
  publishReview: (c, o) =>
    c.reviews.publish(
      v("review_id"),
      pick("expected_version", "expected_media_version", "reason"),
      o,
    ),
  rejectReview: (c, o) => c.reviews.reject(v("review_id"), pick("reason"), o),
  hideReview: (c, o) => c.reviews.hide(v("review_id"), pick("reason"), o),
  getReviewRevision: (c, o) => c.reviews.getRevision(v("review_id"), o),
  approveReviewRevision: (c, o) =>
    c.reviews.approveRevision(
      v("review_id"),
      pick("revision_id", "expected_version", "expected_media_version"),
      o,
    ),
  rejectReviewRevision: (c, o) => c.reviews.rejectRevision(v("review_id"), pick("revision_id"), o),
  listReviewMedia: (c, o) =>
    c.media.list(v("review_id"), pick("author_id", "include_unpublished"), o),
  createMediaUpload: (c, o) =>
    c.media.createUpload(
      v("review_id"),
      pick(
        "kind",
        "content_type",
        "size_bytes",
        "client_upload_id",
        "position",
        "width",
        "height",
        "duration_seconds",
      ),
      o,
    ),
  completeMediaUpload: (c, o) => c.media.complete(v("review_id"), v("media_id"), o),
  deleteMedia: (c, o) => c.media.delete(v("review_id"), v("media_id"), o),
  approveMedia: (c, o) =>
    c.media.approve(
      v("review_id"),
      v("media_id"),
      pick("expected_version", "expected_media_version", "reason"),
      o,
    ),
  rejectMedia: (c, o) => c.media.reject(v("review_id"), v("media_id"), pick("reason"), o),
  eraseAuthor: (c, o) => c.authors.erase(v("author_id"), o),
  listAuditLogs: (c, o) =>
    c.auditLogs.list(
      pick("action", "aggregate_type", "aggregate_id", "actor_id", "limit", "offset"),
      o,
    ),
};

/** The spec each operation's `data` decodes with (an item spec for lists). */
const RESPONSE_SPECS: Record<string, Spec<unknown>> = {
  getHealthLive: SPECS.HealthLive,
  getHealthReady: SPECS.HealthReady,
  listEntities: ENTITY_SPEC,
  upsertEntity: ENTITY_SPEC,
  lookupEntity: ENTITY_SPEC,
  getEntity: ENTITY_SPEC,
  updateEntity: ENTITY_SPEC,
  deactivateEntity: ENTITY_SPEC,
  getEntityRating: SPECS.EntityRating,
  queryRatings: SPECS.BatchRating,
  getApplicationSettings: SPECS.ApplicationSettings,
  putApplicationSettings: SPECS.ApplicationSettings,
  listReviews: REVIEW_SPEC,
  createReview: REVIEW_SPEC,
  getReview: REVIEW_SPEC,
  updateReview: REVIEW_SPEC,
  removeReview: REVIEW_SPEC,
  publishReview: REVIEW_SPEC,
  rejectReview: REVIEW_SPEC,
  hideReview: REVIEW_SPEC,
  getReviewRevision: SPECS.Revision,
  approveReviewRevision: REVIEW_SPEC,
  rejectReviewRevision: REVIEW_SPEC,
  listReviewMedia: SPECS.Media,
  createMediaUpload: MEDIA_UPLOAD_SPEC,
  completeMediaUpload: SPECS.Media,
  deleteMedia: SPECS.Media,
  approveMedia: SPECS.Media,
  rejectMedia: SPECS.Media,
  eraseAuthor: SPECS.EraseResult,
  listAuditLogs: SPECS.AuditLog,
} as Record<string, Spec<unknown>>;

const contract = operations();
const sdkNone = new Set(surface.operations.filter((r) => r.sdk === "none").map((r) => r.operation));
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("the operation table", () => {
  it("matches the OpenAPI contract in both directions", () => {
    expect(sorted(Object.keys(OPERATIONS))).toEqual(
      sorted(Object.keys(contract).filter((id) => !sdkNone.has(id))),
    );
    for (const op of Object.values(OPERATIONS)) {
      const want = contract[op.id]!;
      expect(op.method, `${op.id} method`).toBe(want.method);
      expect(op.path, `${op.id} path`).toBe(want.path);
      expect(sorted(op.body), `${op.id} body`).toEqual(sorted(want.body));
      const query = [...op.required, ...op.optional].filter(
        (p) => !pathParams(op).includes(p) && !op.body.includes(p),
      );
      expect(sorted(query), `${op.id} query`).toEqual(sorted(want.query));
    }
  });

  it("matches the surface", () => {
    for (const row of surface.operations) {
      if (row.sdk === "none") continue;
      const op = OPERATIONS[row.operation]!;
      expect(op.jsMethod, `${op.id} JS name`).toBe(row.js);
      expect(op.retry, `${op.id} retry class`).toBe(row.retry);
      expect(op.required, `${op.id} required`).toEqual(row.required ?? []);
      expect(op.optional, `${op.id} optional`).toEqual(row.optional ?? []);
    }
  });
});

function declaredMethods(client: Octoreview): string[] {
  const out: string[] = [];
  for (const [name, service] of Object.entries(client)) {
    for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
      if (method !== "constructor") out.push(`${name}.${method}`);
    }
  }
  return out;
}

describe("the surface", () => {
  it("names every client method, and the client declares nothing else", () => {
    const named = [
      ...surface.operations.filter((r) => r.sdk !== "none").map((r) => r.js as string),
      ...surface.helpers.map((h) => h.js),
    ];
    const declared = declaredMethods(
      new Octoreview({ baseUrl: "https://r.example.com", apiKey: "ocr_x", tenantId: "t" }),
    );
    for (const name of named) {
      expect(declared, `the surface names ${name}`).toContain(name);
    }
    for (const name of declared) {
      expect(named, `the client declares ${name}, which the surface does not name`).toContain(name);
    }
  });

  it("declares every error code", () => {
    expect(sorted(Object.values(ErrorCode))).toEqual(sorted(errorCodes()));
  });
});

describe.each(Object.keys(OPERATIONS))("%s", (id) => {
  it("sends the request the contract describes and decodes the server's response", async () => {
    const call = CALLS[id];
    expect(call, `${id} has no recorded call`).toBeDefined();
    const want = contract[id]!;
    const http = new Recorder().push({ status: 200, body: fixture(id) });
    const client = new Octoreview({
      baseUrl: "https://reviews.example.com/",
      apiKey: "ocr_secret",
      tenantId: "v:tenant",
      applicationId: "v:application_id",
      namespace: { type: "v:namespace_type", id: "v:namespace_id" },
      actorId: "v:actor",
      adapter: http.adapter,
    });
    const options: CallOptions = takes(OPERATIONS[id]!, "include_global")
      ? { includeGlobal: true }
      : {};

    const result = await call!(client, options);
    const request = http.last;

    expect(request.method).toBe(want.method);
    const path = want.path.replace(/\{([a-z_]+)\}/g, (_, name: string) =>
      encodeURIComponent(String(value(name))),
    );
    expect(request.url.pathname).toBe(`/api/v1${path}`);
    const query = Object.fromEntries(request.url.searchParams);
    expect(sorted(Object.keys(query)), "query parameters").toEqual(sorted(want.query));
    for (const [name, got] of Object.entries(query)) {
      expect(got, `query ${name}`).toBe(String(value(name)));
    }
    if (want.body.length === 0) {
      expect(request.body, "an operation without body fields sends no body").toBeUndefined();
    } else {
      expect(request.headers["content-type"]).toBe("application/json");
      const body = JSON.parse(request.body ?? "") as Record<string, unknown>;
      expect(sorted(Object.keys(body)), "body fields").toEqual(sorted(want.body));
      for (const [name, got] of Object.entries(body)) {
        expect(got, `body ${name}`).toEqual(value(name));
      }
    }
    const authenticated = want.headers.includes("X-Tenant-ID");
    expect(request.headers.authorization).toBe(authenticated ? "Bearer ocr_secret" : undefined);
    expect(request.headers["x-tenant-id"]).toBe(authenticated ? "v:tenant" : undefined);
    const namespaced = want.headers.includes("X-Namespace-Type");
    expect(request.headers["x-namespace-type"]).toBe(namespaced ? "v:namespace_type" : undefined);
    expect(request.headers["x-namespace-id"]).toBe(namespaced ? "v:namespace_id" : undefined);
    expect(request.headers["x-actor-id"]).toBe(
      want.headers.includes("X-Actor-ID") ? "v:actor" : undefined,
    );
    expect(request.headers["user-agent"]).toMatch(/^octoreview-js\//);

    // The response model declares exactly the contract schema's properties, and the captured
    // server response filled it with mostly non-default values.
    const data = responseData(id);
    expect(data, `${id} has no JSON data response in the contract`).not.toBeNull();
    const spec = RESPONSE_SPECS[id];
    expect(spec, `${id} has no response spec`).toBeDefined();
    const wire = Object.values(spec as Record<string, readonly [string, unknown]>).map(
      ([name]) => name,
    );
    expect(
      sorted(wire),
      `${id}: the model differs from the contract schema ${data!.schema}`,
    ).toEqual(sorted(data!.fields));
    const isList =
      Array.isArray(result) ||
      (typeof result === "object" &&
        result !== null &&
        "items" in result &&
        "pagination" in result);
    expect(isList, `${id}: list or single result`).toBe(data!.list);
    const items = Array.isArray(result)
      ? result
      : isList
        ? (result as { items: unknown[] }).items
        : [result];
    expect(
      items.length,
      `${id}: testdata/fixtures/${id}.json has no items (run make fixtures)`,
    ).toBeGreaterThan(0);
    const model = items[0] as Record<string, unknown>;
    const defaults = Object.values(model).filter(
      (x) => x === "" || x === 0 || (Array.isArray(x) && x.length === 0),
    );
    expect(defaults.length * 2, `${id}: most decoded fields are defaults`).toBeLessThan(
      wire.length,
    );
  });
});

/** The README's retry table, rendered from the operation table. */
function retryTable(): string {
  const byClass: Record<string, string[]> = {};
  for (const op of Object.values(OPERATIONS)) {
    const methods = byClass[op.retry] ?? [];
    methods.push(`\`${op.jsMethod}\``);
    byClass[op.retry] = methods;
  }
  let out = "| Retry class | Behavior | Methods |\n| --- | --- | --- |\n";
  for (const [retry, behavior] of Object.entries(RETRY_BEHAVIOR)) {
    out += `| \`${retry}\` | ${behavior} | ${(byClass[retry] ?? []).sort().join(", ")} |\n`;
  }
  return out;
}

describe("the README", () => {
  it("has the retry table the operation table renders", () => {
    const readme = readFileSync(join(__dirname, "..", "..", "README.md"), "utf8");
    const start = "<!-- retry-table:start -->\n";
    const end = "<!-- retry-table:end -->";
    const i = readme.indexOf(start);
    const j = readme.indexOf(end);
    expect(i, "README.md lost its retry-table markers").toBeGreaterThanOrEqual(0);
    expect(
      readme.slice(i + start.length, j),
      `README.md's retry table is stale; replace it with:\n${retryTable()}`,
    ).toBe(retryTable());
  });
});
