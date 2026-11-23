import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ErrorCode, Octoreview, UploadError } from "../src";
import { fixture } from "./support/contract";
import { type Answer, apiError, Recorder } from "./support/recorder";

const SIGNED_URL = "https://storage.example.com/bucket/media/key.png?X-Amz-Signature=secret-sig";

interface Put {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** The octoreview API (intent, complete, delete) plus a storage endpoint for the PUTs. */
class Fake {
  readonly puts: Put[] = [];
  putAnswers: Answer[] = [];
  deleted: string[] = [];
  completeAnswer: Answer | null = null;
  intentAnswer: Answer | null = null;
  expiresAt = new Date(Date.now() + 15 * 60_000);
  readonly api = new Recorder((request) => {
    const path = request.url.pathname;
    const headers = { "X-Request-ID": `req-${request.method}` };
    if (request.method === "POST" && path.endsWith("/media")) {
      if (this.intentAnswer) return this.intentAnswer;
      const intent = JSON.parse(request.body ?? "{}") as { content_type: string };
      const body = JSON.parse(fixture("createMediaUpload")) as { data: Record<string, unknown> };
      (body.data.media as Record<string, unknown>).status = "pending";
      body.data.upload = {
        method: "PUT",
        url: SIGNED_URL,
        headers: { "Content-Type": intent.content_type },
        expires_at: this.expiresAt.toISOString(),
      };
      return { status: 201, body, headers };
    }
    if (path.endsWith("/complete")) {
      return this.completeAnswer ?? { status: 200, body: fixture("completeMediaUpload"), headers };
    }
    if (request.method === "DELETE") {
      this.deleted.push(path);
      return { status: 200, body: fixture("deleteMedia"), headers };
    }
    throw new Error(`unexpected ${request.method} ${path}`);
  });

  /** Reads each PUT body as a real client would send it. */
  readonly storage: AxiosAdapter = async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse> => {
    const chunks: Buffer[] = [];
    for await (const chunk of config.data as Readable) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers.toJSON())) {
      if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
    }
    this.puts.push({ url: config.url ?? "", headers, body: Buffer.concat(chunks) });
    const answer = this.putAnswers.shift() ?? { status: 200 };
    return {
      status: answer.status,
      statusText: "",
      headers: Object.fromEntries(
        Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      config,
      data: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? ""),
    };
  };

  client(): Octoreview {
    return new Octoreview({
      baseUrl: "https://reviews.example.com",
      apiKey: "ocr_live_secret",
      tenantId: "mbizmarket",
      applicationId: "storefront",
      namespace: { type: "store", id: "s-1" },
      actorId: "admin-7",
      adapter: this.api.adapter,
      uploadAdapter: this.storage,
    });
  }
}

function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("uploads", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("sends only the signed headers and an explicit length", async () => {
    const fake = new Fake();
    const media = await fake
      .client()
      .media.uploadBytes("r-1", new TextEncoder().encode("png-bytes"), "image/png", {
        position: 2,
      });
    expect(media.status).toBe("ready");
    const [put] = fake.puts;
    expect(put?.url).toBe(SIGNED_URL);
    expect(put?.headers["content-type"]).toBe("image/png");
    expect(put?.headers["content-length"]).toBe("9");
    for (const credential of [
      "authorization",
      "x-tenant-id",
      "x-namespace-type",
      "x-namespace-id",
      "x-actor-id",
    ]) {
      expect(put?.headers[credential], credential).toBeUndefined();
    }
    expect(put?.body.toString()).toBe("png-bytes");
    const intent = JSON.parse(fake.api.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect([intent.kind, intent.size_bytes, intent.position]).toEqual(["image", 9, 2]);
    expect(intent.client_upload_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("infers a file's type and size and streams a large body with progress", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octoreview-"));
    const path = join(dir, "clip.MP4");
    const size = 11 * 1024 * 1024;
    writeFileSync(path, Buffer.alloc(size, 118));
    const reports: [number, number][] = [];
    try {
      const fake = new Fake();
      await fake.client().media.uploadFile("r-1", path, {
        durationSeconds: 12.5,
        onProgress: (sent, total) => reports.push([sent, total]),
      });
      const intent = JSON.parse(fake.api.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect([
        intent.kind,
        intent.content_type,
        intent.size_bytes,
        intent.duration_seconds,
      ]).toEqual(["video", "video/mp4", size, 12.5]);
      expect(fake.puts[0]?.headers["content-length"]).toBe(String(size));
      expect(fake.puts[0]?.body.length).toBe(size);
      expect(reports.length).toBeGreaterThan(1);
      expect(reports.at(-1)).toEqual([size, size]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a failed PUT from the start with a reopened body", async () => {
    const fake = new Fake();
    fake.putAnswers = [{ status: 503, headers: { "Retry-After": "1" } }];
    const result = settle(
      fake.client().media.uploadBytes("r-1", new TextEncoder().encode("abcdef"), "image/webp"),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect((await result).value?.status).toBe("ready");
    expect(fake.puts.map((p) => p.body.toString())).toEqual(["abcdef", "abcdef"]);
  });

  it("tries a plain stream once, since it cannot rewind", async () => {
    const fake = new Fake();
    fake.putAnswers = [{ status: 503 }];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_NOT_FOUND);
    const { error } = await settle(
      fake.client().media.uploadStream("r-1", Readable.from([Buffer.from("abc")]), "image/png", 3),
    );
    expect((error as UploadError).stage).toBe("put");
    expect(fake.puts).toHaveLength(1);
  });

  it("never retries past the URL's expiry", async () => {
    const fake = new Fake();
    fake.expiresAt = new Date(Date.now() + 10_000);
    fake.putAnswers = [{ status: 503, headers: { "Retry-After": "20" } }];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_NOT_FOUND);
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1, 2, 3]), "image/png"),
    );
    expect((error as UploadError).stage).toBe("put");
    expect(fake.puts).toHaveLength(1);
  });

  it("explains a terminal PUT failure and frees the slot when no bytes landed", async () => {
    const fake = new Fake();
    fake.putAnswers = [
      {
        status: 403,
        body: '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>',
      },
    ];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_NOT_FOUND); // the only case that deletes
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1, 2, 3]), "image/png"),
    );
    expect(error).toBeInstanceOf(UploadError);
    const upload = error as UploadError;
    expect([upload.stage, upload.reviewId, upload.providerCode]).toEqual([
      "put",
      "r-1",
      "SignatureDoesNotMatch",
    ]);
    expect(upload.mediaId).not.toBeNull();
    expect(upload.uploadExpiresAt).toBeInstanceOf(Date);
    expect(upload.fix).toContain("Content-Length");
    expect(upload.requestIds).toEqual(["req-POST"]);
    const rendered = [String(upload), inspect(upload, { depth: 10 }), JSON.stringify(upload)].join(
      "\n",
    );
    for (const secret of ["secret-sig", "X-Amz-Signature", "ocr_live_secret"]) {
      expect(rendered, secret).not.toContain(secret);
    }
    expect(fake.puts).toHaveLength(1);
    expect(fake.deleted).toHaveLength(1);
  });

  it("never follows a redirect", async () => {
    const fake = new Fake();
    fake.putAnswers = [{ status: 307, headers: { Location: "https://elsewhere.example.com/" } }];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_NOT_FOUND);
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1]), "image/png"),
    );
    expect((error as UploadError).fix).toContain("redirected");
    expect(fake.puts).toHaveLength(1);
  });

  it("never deletes media another call completed", async () => {
    // Two helpers share a client upload id; the other one completed first, so this PUT meets
    // upload_already_completed. The media is ready: return it, delete nothing.
    const fake = new Fake();
    fake.putAnswers = [apiError(409, ErrorCode.UPLOAD_ALREADY_COMPLETED)];
    const media = await fake
      .client()
      .media.uploadBytes("r-1", new Uint8Array([1]), "image/png", { clientUploadId: "shared" });
    expect(media.status).toBe("ready");
    expect(fake.deleted).toEqual([]);
  });

  it("keeps the row when complete cannot tell", async () => {
    const fake = new Fake();
    fake.putAnswers = [{ status: 403 }];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_EXPIRED);
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1]), "image/png"),
    );
    expect((error as UploadError).stage).toBe("put");
    expect(fake.deleted).toEqual([]);
  });

  it("reports a complete rejection at its stage", async () => {
    const fake = new Fake();
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_EXPIRED);
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1]), "image/png"),
    );
    const upload = error as UploadError;
    expect(upload.stage).toBe("complete");
    expect(upload.cause).toBeInstanceOf(ApiError);
    expect(upload.requestIds).toEqual(["req-POST", "req-upload_expired"]);
  });

  it("reports an intent failure without a PUT, with the call options applied", async () => {
    const fake = new Fake();
    fake.intentAnswer = apiError(409, ErrorCode.MEDIA_LIMIT_EXCEEDED);
    const { error } = await settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1]), "image/png", {
        callOptions: { applicationId: "backoffice" },
      }),
    );
    const upload = error as UploadError;
    expect(upload.stage).toBe("intent");
    expect(upload.mediaId).toBeNull();
    expect((upload.cause as ApiError).code).toBe(ErrorCode.MEDIA_LIMIT_EXCEEDED);
    expect(fake.api.last.url.search).toBe("?application_id=backoffice");
    expect(fake.puts).toEqual([]);
  });

  it("checks its inputs before any call", async () => {
    const fake = new Fake();
    const c = fake.client();
    for (const call of [
      () => c.media.uploadFile("r-1", "/tmp/notes.txt"),
      () => c.media.uploadFile("r-1", "/nonexistent/photo.png"),
      () => c.media.uploadBytes("r-1", new Uint8Array([1]), "text/plain"),
    ]) {
      const { error } = await settle(call());
      expect((error as UploadError).stage).toBe("intent");
    }
    expect(fake.api.requests).toEqual([]);
  });

  it("returns the media of a replayed intent that already completed", async () => {
    const fake = new Fake();
    const body = JSON.parse(fixture("createMediaUpload")) as { data: Record<string, unknown> };
    (body.data.media as Record<string, unknown>).status = "ready";
    body.data.upload = null;
    fake.intentAnswer = { status: 200, body };
    const media = await fake
      .client()
      .media.uploadBytes("r-1", new Uint8Array([1]), "image/png", { clientUploadId: "replayed" });
    expect(media.status).toBe("ready");
    expect(fake.puts).toEqual([]);
  });

  it("stops when the call is aborted during a retry wait", async () => {
    const fake = new Fake();
    fake.putAnswers = [{ status: 503, headers: { "Retry-After": "5" } }];
    fake.completeAnswer = apiError(409, ErrorCode.UPLOAD_NOT_FOUND);
    const controller = new AbortController();
    const result = settle(
      fake.client().media.uploadBytes("r-1", new Uint8Array([1]), "image/png", {
        callOptions: { signal: controller.signal },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.runAllTimersAsync();
    const { error } = await result;
    expect((error as UploadError).stage).toBe("put");
    expect(fake.puts).toHaveLength(1);
  });
});
