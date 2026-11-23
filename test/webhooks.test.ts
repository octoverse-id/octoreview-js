import { describe, expect, it } from "vitest";
import { InvalidSignatureError, Octoreview, verifyWebhook } from "../src";

// Signed by the server's own octoreview.events.dispatch.webhook_signature (secret whsec-test).
const BODY =
  '{"id": "8d0c5a2e-7f0a-4b8e-9d55-2f4f8d6f3a10", "type": "review.published", "occurred_at": "2026-11-19T10:15:00.123456+00:00", "tenant_id": "example", "application_id": "storefront", "namespace_type": null, "namespace_id": null, "resource_type": "review", "resource_id": "1f9e7c5a-0b2d-4c8e-a6f1-3d5b7e9c1a20", "request_id": "req_1", "data": {"review_id": "1f9e7c5a-0b2d-4c8e-a6f1-3d5b7e9c1a20", "entity_id": "2a8f6d4b-1c3e-4f5a-9b7d-0e2c4a6b8d10", "entity_type": "product", "external_id": "sku-1", "status": "published", "previous_status": null, "rating": 5, "is_verified_purchase": true, "version": 2, "media_version": 1}}';
const SIGNATURE =
  "t=1795000000,v1=0bc8a000e4f4aee9b555b260a8f723569694a5ac8449ae1375fe1620d7165722";
const SECRET = "whsec-test";
const NOW = 1795000000 + 60;

describe("webhooks", () => {
  it("verifies and decodes a server-signed delivery", async () => {
    const event = await verifyWebhook(BODY, SIGNATURE, SECRET, { now: NOW });
    expect([event.type, event.id, event.namespaceType]).toEqual([
      "review.published",
      "8d0c5a2e-7f0a-4b8e-9d55-2f4f8d6f3a10",
      null,
    ]);
    expect(event.occurredAt).toBeInstanceOf(Date);
    const review = event.review();
    expect([
      review.externalId,
      review.previousStatus,
      review.isVerifiedPurchase,
      review.version,
      review.mediaVersion,
    ]).toEqual(["sku-1", null, true, 2, 1]);
    expect(() => event.media()).toThrow(TypeError);
    // The raw bytes verify the same way.
    expect(
      (await verifyWebhook(new TextEncoder().encode(BODY), SIGNATURE, SECRET, { now: NOW })).id,
    ).toBe(event.id);
  });

  it("rejects a tampered, foreign, stale or malformed delivery", async () => {
    const cases: [string, () => Promise<unknown>][] = [
      [
        "another body",
        () =>
          verifyWebhook(BODY.replace('"rating": 5', '"rating": 1'), SIGNATURE, SECRET, {
            now: NOW,
          }),
      ],
      ["another secret", () => verifyWebhook(BODY, SIGNATURE, "whsec-other", { now: NOW })],
      ["too old", () => verifyWebhook(BODY, SIGNATURE, SECRET, { now: 1795000000 + 301 })],
      ["from the future", () => verifyWebhook(BODY, SIGNATURE, SECRET, { now: 1795000000 - 301 })],
      ["malformed", () => verifyWebhook(BODY, "sha256=abc", SECRET, { now: NOW })],
      ["missing", () => verifyWebhook(BODY, "", SECRET, { now: NOW })],
    ];
    for (const [name, verify] of cases) {
      await expect(verify(), name).rejects.toBeInstanceOf(InvalidSignatureError);
    }
    await expect(verifyWebhook(BODY, SIGNATURE, "")).rejects.toThrow(TypeError);
  });

  it("accepts one v1 per rotated secret, and works through the client", async () => {
    const rotated = `t=1795000000,v1=${"0".repeat(64)},${SIGNATURE.slice(13)}`;
    expect((await verifyWebhook(BODY, rotated, SECRET, { now: NOW })).type).toBe(
      "review.published",
    );
    const client = new Octoreview({
      baseUrl: "https://reviews.example.com",
      apiKey: "ocr_x",
      tenantId: "t",
    });
    expect((await client.webhooks.verify(BODY, SIGNATURE, SECRET, { now: NOW })).type).toBe(
      "review.published",
    );
  });
});
