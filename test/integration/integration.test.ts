import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ApiError,
  type ApplicationSettings,
  ErrorCode,
  NotModifiedError,
  Octoreview,
  type PutSettingsParams,
  UploadError,
} from "../../src";
import { fixtureRecorder } from "./fixtureRecorder";

// The integration suite against a real server (`make integration`, CI `integration`). It reads
// the harness's .octoreview-dev.env from OCTOREVIEW_DEV_ENV. With OCTOREVIEW_WRITE_FIXTURES=1 it
// also saves one response per operation into testdata/fixtures (`make fixtures`), which the
// contract gate decodes offline.

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(56).fill(0),
]);
const devEnv = process.env.OCTOREVIEW_DEV_ENV;

function client(): Octoreview {
  const env: Record<string, string> = {};
  for (const line of readFileSync(devEnv as string, "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length > 0) env[key] = rest.join("=");
  }
  return Octoreview.fromEnv(
    {
      actorId: "js-integration",
      timeoutMs: 60_000,
      ...(process.env.OCTOREVIEW_WRITE_FIXTURES === "1" ? { adapter: fixtureRecorder() } : {}),
    },
    env,
  );
}

/** Put replaces every setting, so this keeps them all as they are. */
function settingsOf(app: ApplicationSettings): PutSettingsParams {
  return {
    maxImages: app.maxImages,
    maxVideos: app.maxVideos,
    maxImageBytes: app.maxImageBytes,
    maxVideoBytes: app.maxVideoBytes,
    allowedContentTypes: app.allowedContentTypes,
    moderationMode: app.moderationMode as PutSettingsParams["moderationMode"],
    maxStorageBytes: app.maxStorageBytes,
  };
}

describe.skipIf(!devEnv)("the main flows against a real server", () => {
  it("runs end to end", { timeout: 180_000 }, async () => {
    const c = client();
    const run = `js-${randomBytes(6).toString("hex")}`;

    expect((await c.health.live()).status).toBe("ok");
    expect((await c.health.ready()).database).toBe("ok");

    // An entity allowing two images: the third is refused (the epic's acceptance check).
    const entity = await c.entities.upsert({
      entityType: "product",
      externalId: run,
      metadata: { source: "js" },
      maxImages: 2,
    });
    const review = await c.reviews.create({
      authorId: `${run}-a`,
      rating: 4,
      entityId: entity.id,
      title: "Good",
      isVerifiedPurchase: true,
    });
    expect(review.status).toBe("published");
    for (const position of [0, 1]) {
      const media = await c.media.uploadBytes(review.id, PNG, "image/png", { position });
      expect(media.status).toBe("ready");
      expect(media.url).not.toBeNull();
      expect((await fetch(media.url as string)).status, "the photo is served").toBe(200);
    }
    const third = await c.media.uploadBytes(review.id, PNG, "image/png").catch((e: unknown) => e);
    expect(third).toBeInstanceOf(UploadError);
    expect((third as UploadError).stage).toBe("intent");
    expect(((third as UploadError).cause as ApiError).code).toBe(ErrorCode.MEDIA_LIMIT_EXCEEDED);

    const summary = await c.ratings.get("product", run);
    const batch = await c.ratings.query({
      entityType: "product",
      externalIds: [run, `${run}-missing`],
    });
    const forEntity = await c.ratings.forEntity(entity.id);
    expect([summary.ratingCount, batch.length, batch[1]?.entityId, forEntity.ratingCount]).toEqual([
      1,
      2,
      null,
      1,
    ]);
    // The server answers conditional reads from 1.0.0-rc.4 (its spec 5.3). The rating summary's
    // ETag does not carry the signing epoch, so an unchanged summary always answers 304.
    const etag = forEntity.meta.etag;
    expect(etag).toBeTruthy();
    await expect(
      c.ratings.forEntity(entity.id, { ifNoneMatch: etag ?? "" }),
    ).rejects.toBeInstanceOf(NotModifiedError);
    const listed = await c.reviews.list({ entityId: entity.id, hasMedia: true });
    expect(listed.pagination.count).toBe(1);
    expect(listed.items[0]?.media).toHaveLength(2);
    const media = await c.media.list(review.id);
    expect([media.pagination.count, media.items.length]).toEqual([2, 2]);
    const second = await c.media.list(review.id, { limit: 1, offset: 1 });
    expect([second.pagination.limit, second.items.map((m) => m.id)]).toEqual([
      1,
      [media.items[1]?.id],
    ]);

    // Pre-moderation: a new review waits; the version guard protects publishing.
    const original = settingsOf(await c.settings.get());
    await c.settings.put(undefined, { ...original, moderationMode: "pre_moderation" });
    try {
      const pending = await c.reviews.create({
        authorId: `${run}-b`,
        rating: 2,
        entityId: entity.id,
      });
      expect(pending.status).toBe("pending");
      const stale = await c.reviews
        .publish(pending.id, {
          expectedVersion: pending.version + 1,
          expectedMediaVersion: pending.mediaVersion,
        })
        .catch((e: unknown) => e);
      expect((stale as ApiError).isReviewChanged()).toBe(true);
      const published = await c.reviews.publish(pending.id, {
        expectedVersion: pending.version,
        expectedMediaVersion: pending.mediaVersion,
      });
      expect(published.status).toBe("published");

      // An edit of a published review under pre-moderation becomes a revision.
      const edited = await c.reviews.update(published.id, { rating: 3 });
      const revision = await c.reviews.getRevision(edited.id);
      const approved = await c.reviews.approveRevision(edited.id, {
        revisionId: revision.id,
        expectedVersion: edited.version,
        expectedMediaVersion: edited.mediaVersion,
      });
      expect(approved.rating).toBe(3);

      // Media on a published review waits for moderation under pre-moderation.
      const photo = await c.media.uploadFile(
        approved.id,
        join(__dirname, "..", "..", "examples", "photo.png"),
      );
      const current = await c.reviews.get(approved.id);
      const moderated = await c.media.approve(approved.id, photo.id, {
        expectedVersion: current.version,
        expectedMediaVersion: current.mediaVersion,
      });
      expect(moderated.moderationStatus).toBe("approved");
      await c.media.reject(approved.id, photo.id, { reason: "blurry" });
      await c.media.delete(approved.id, photo.id);

      await c.reviews.hide(approved.id, { reason: "spam" });
      const rejectable = await c.reviews.create({
        authorId: `${run}-c`,
        rating: 1,
        entityId: entity.id,
      });
      await c.reviews.reject(rejectable.id);
      await c.reviews.remove(rejectable.id);
      const revised = await c.reviews.update(review.id, { body: "an edit to drop" });
      const dropped = await c.reviews.getRevision(revised.id);
      await c.reviews.rejectRevision(revised.id, { revisionId: dropped.id });
    } finally {
      await c.settings.put(undefined, original);
    }

    expect((await c.auditLogs.list({ aggregateId: review.id })).pagination.count).toBeGreaterThan(
      0,
    );
    expect((await c.authors.erase(`${run}-a`)).reviewsRedacted).toBe(1);
    const found = await c.entities.lookup("product", run);
    const got = await c.entities.get(found.id);
    const listedEntities = await c.entities.list({ externalId: run });
    const updated = await c.entities.update(got.id, { maxImages: null });
    const deactivated = await c.entities.deactivate(updated.id);
    expect(listedEntities.pagination.count).toBe(1);
    expect(updated.mediaPolicy.maxImages).toBeNull();
    expect(deactivated.isActive).toBe(false);
  });
});
