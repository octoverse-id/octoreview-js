# Octoreview JavaScript SDK

The official JavaScript/TypeScript client for [Octoreview](https://github.com/octoverse-id/octoreview),
the multi-tenant review and rating service with image and video review media.

```sh
npm install @octoverse-id/octoreview
```

TypeScript strict, axios, ESM and CommonJS, Node 20 or newer. No release yet: `0.1.0` ships
with the server's `1.0.0-rc.3` ([`docs/versioning.md`](docs/versioning.md)).

## Usage

```ts
import { Octoreview } from "@octoverse-id/octoreview";

const client = Octoreview.fromEnv(); // OCTOREVIEW_BASE_URL, _API_KEY, _TENANT_ID, _APPLICATION_ID

const review = await client.reviews.create({
  authorId: currentUser.id, // from your own authentication, never from request input
  rating: 5,
  entityType: "product",
  externalId: "sku-1",
  title: "Fits perfectly",
});

const summary = await client.ratings.get("product", "sku-1");               // one entity's stars
const ratings = await client.ratings.query({ entityType: "product", externalIds: ["sku-1", "sku-2"] }); // a listing page's
```

`new Octoreview({ baseUrl, apiKey, tenantId, ...defaults })` builds a client explicitly. The
defaults are `applicationId`, `namespace`, `actorId`, `timeoutMs`, `maxAttempts` and
`maxRetryAfterSeconds`, and call options override them per call: `applicationId`, `namespace`
(or `"global"`), `includeGlobal`, `actorId`, `ifNoneMatch`, `requestId` and `signal`.

```ts
const client = new Octoreview({
  baseUrl: "https://reviews.example.com",
  apiKey: process.env.OCTOREVIEW_API_KEY!,
  tenantId: "example",
  applicationId: "storefront",
  namespace: { type: "store", id: "store-9" },
});
const page = await client.reviews.list({ entityType: "product", externalId: "sku-1", limit: 20 }, { includeGlobal: true });
```

**Server only.** The client holds a service key, so it refuses to run in a browser unless you
pass `dangerouslyAllowBrowser: true` for a trusted context. Browsers upload media through your
server: create the intent with `media.createUpload`, hand `upload.url` and `upload.headers` to
the browser, then call `media.complete`.

**Parameters** are camelCase and checked at runtime too: an unknown or missing one throws
`ConfigurationError` before anything is sent. In `update` calls `null` is sent as null (a media
limit then inherits, a title clears) and `undefined` leaves the field unchanged.

**Render safely.** Review titles and bodies are user input: escape them when you render them.
React escapes text by default (`<p>{review.body}</p>`); never pass them to
`dangerouslySetInnerHTML` or `innerHTML`.

**Moderation.** `reviews.publish`, `reviews.approveRevision` and `media.approve` take the
review's `version` and `mediaVersion` as the moderator saw them (`expectedVersion`,
`expectedMediaVersion`). A review that changed since then throws `ApiError` with
`isReviewChanged()`: reload it and show the new content.

## Methods

Every method of the server's [SDK surface](https://github.com/octoverse-id/octoreview/blob/main/docs/sdk-surface.yaml):
`health`, `entities`, `ratings`, `settings`, `reviews`, `media`, `authors` and `auditLogs`.
Models are camelCase with `Date` timestamps; single results carry a non-enumerable `meta`
(`etag`, `requestId`), and lists return a `Page` (`items`, `pagination`, `meta`).

## Uploads

```ts
const media = await client.media.uploadFile(review.id, "/path/photo.jpg");     // type and size from the file
const photo = await client.media.uploadBytes(review.id, bytes, "image/png");
const video = await client.media.uploadStream(review.id, () => createReadStream(path), "video/mp4", size, {
  onProgress: (sent, total) => console.log(`${sent}/${total}`),
});
```

Each runs intent, PUT and complete, and returns the ready media (Node only).
- **The PUT** goes to the signed `upload.url` with only the headers the server returned and an
  explicit `Content-Length`, through a separate axios instance (`uploadAdapter`). It never sends
  the service key, tenant or namespace headers, follows no redirects, and has no total timeout;
  `callOptions.signal` cancels it.
- **Retries:** a failed PUT is retried on the same URL until it expires. A stream factory
  (`() => stream`) is reopened for each attempt; a plain stream cannot rewind, so it is tried once.
  `complete` retries on 503, `complete_in_progress` and `upload_changed`.
- **Failures** throw `UploadError` with `stage` (`intent`, `put` or `complete`), the media and
  review ids, `uploadExpiresAt`, `requestIds` and, for a failed PUT, the storage provider's
  `providerCode` and a `fix`; never the signed URL. A terminal PUT failure frees the slot unless
  another call with the same client upload id completed the upload.

## Webhooks

```ts
import { EventType, InvalidSignatureError, verifyWebhook } from "@octoverse-id/octoreview";

app.post("/webhooks/octoreview", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body, req.get("X-Octoreview-Signature") ?? "", secret);
  } catch (error) {
    if (error instanceof InvalidSignatureError) return res.sendStatus(401);
    throw error;
  }
  if (event.type === EventType.ENTITY_RATING_CHANGED) await store.replaceSummary(event.ratingChanged());
  if (event.type === EventType.AUTHOR_ERASED) await store.forgetAuthor(event.authorErased().authorId);
  res.sendStatus(204);
});
```

`verifyWebhook()` (also `client.webhooks.verify()`) checks `X-Octoreview-Signature` against the
raw body in constant time (WebCrypto) with a 300 s tolerance, then decodes the event. Pass the
body exactly as received, and deduplicate on `event.id`: delivery is at least once.

## Quickstart

With the server's compose stack running (`make up && make dev-env` in the server repository):

```sh
make build && node examples/quickstart.mjs path/to/.octoreview-dev.env
```

It creates a review, uploads a photo, and prints the review id, the rating summary and the photo
URL. CI runs it against the pinned server image.

## Errors

Every error extends `OctoreviewError`:

| Error | When |
| --- | --- |
| `ApiError` | the server answered an error: `status`, `code` (an `ErrorCode` value), `details`, `requestId`, `docUrl`, `retryable`, `retryAfter` |
| `TransportError` | the server could not be reached (`networkFailure`, `errorCode`), the call was aborted (`aborted`), or its answer could not be read |
| `NotModifiedError` | a conditional read (`ifNoneMatch`) found the resource unchanged |
| `MalformedResponseError` | a success response lacks a field this SDK needs (`requestId`) |
| `ConfigurationError` | a missing or invalid option or parameter, or a browser without `dangerouslyAllowBrowser` |
| `UploadError` | an upload helper failed: `stage`, ids, `requestIds`, `providerCode`, `fix` |
| `InvalidSignatureError` | a webhook signature is missing, wrong or outside the tolerance |

Messages never contain the API key, a query string (signatures) or a media token, and no error
carries axios's own error or request config (which hold the `Authorization` header).

## Retries

Each method's retry class comes from the server's `docs/sdk-surface.yaml`. Retries back off and
honor `Retry-After` up to `maxRetryAfterSeconds` (default 3 attempts, 30 s); an aborted
`signal` stops them.

<!-- retry-table:start -->
| Retry class | Behavior | Methods |
| --- | --- | --- |
| `safe` | a read: retried on timeouts, 503 and 429, honoring Retry-After | `auditLogs.list`, `entities.get`, `entities.list`, `entities.lookup`, `health.live`, `health.ready`, `media.list`, `ratings.forEntity`, `ratings.query`, `reviews.getRevision`, `reviews.get`, `reviews.list`, `settings.get` |
| `idempotent` | repeats to the same state: retried like a read | `authors.erase`, `entities.deactivate`, `entities.update`, `entities.upsert`, `media.complete`, `media.delete`, `media.reject`, `settings.put` |
| `keyed` | idempotent with its `clientUploadId`, which the SDK fills in: retried like a read | `media.createUpload` |
| `unsafe` | never retried; after a lost response, read the resource to learn the outcome | `media.approve`, `reviews.approveRevision`, `reviews.create`, `reviews.hide`, `reviews.publish`, `reviews.rejectRevision`, `reviews.reject`, `reviews.remove`, `reviews.update` |
<!-- retry-table:end -->

## Working on this repository

Read [`AGENTS.md`](AGENTS.md) first (humans too): it holds the rules, gates and development
pipeline. `make help` lists the targets; `make check` is the fast gate, and it includes the
offline contract gate against the vendored server contract
([`docs/architecture.md`](docs/architecture.md)). `make integration` runs the quickstart and the
integration suite against the pinned server image, with local and S3 (RustFS) media (needs
Docker).

## License

[Apache License 2.0](LICENSE).
