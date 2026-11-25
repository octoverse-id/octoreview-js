# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-25

### Changed

- The integration suite runs against the server's `1.0.0-rc.3` image (`SERVER_IMAGE`), the
  release candidate `0.1.0` ships with, and the vendored contract and fixtures come from its
  release merge (`20aca25`).
- `media.list()` pages like every other list: it takes `limit`/`offset` and returns a
  `Page<Media>` (`items` plus `pagination`) instead of `Media[]`. The server's `listReviewMedia`
  answers the `{data, pagination}` envelope from `sha-c324de22fab81afd0770b283f1447d2eeb6376e9`,
  which `SERVER_IMAGE` now pins, and the vendored contract and fixtures come from that commit.

### Added

- `.github/workflows/publish.yml` publishes a `vX.Y.Z` or `vX.Y.Z-rc.N` tag: it refuses a commit
  that is not a green commit on `main`, stamps that disagree with the tag (`make version-check`)
  and a commit that is not the release merge (`scripts/check-release-merge.sh`), then runs
  `npm publish` through npm trusted publishing with provenance (`latest`, or `next` for a
  candidate) and creates the GitHub release from the CHANGELOG section. A `workflow_dispatch`
  from `main` rehearses it. `make check` proves the release scripts (`make release-tooling-check`).
- `make integration` (and CI's `integration` job) also runs the quickstart and the suite with
  media on the RustFS S3 emulator, as the server's compose `s3` profile does.
- The client core (`@octoverse-id/octoreview`, TypeScript strict, axios, ESM and CommonJS,
  Node 20+): `new Octoreview()` and `Octoreview.fromEnv()`, client defaults (application,
  namespace, actor, timeout, retry bound) and per-call options (application, namespace or
  `"global"`, `includeGlobal`, actor, `ifNoneMatch`, request id, `AbortSignal`). It refuses to
  run in a browser unless `dangerouslyAllowBrowser` is set.
- Every operation of the server's SDK surface as `client.<resource>.<method>()` with camelCase
  params and models (`Date` timestamps, `meta` with the ETag and request id), plus `ratings.get`
  by entity key. Unknown, misplaced or missing parameters throw before anything is sent.
- Retries by retry class with a bounded `Retry-After`; `createUpload` fills in
  `clientUploadId`; `complete` retries its documented conflicts.
- Typed errors (`ApiError` with the 39 `ErrorCode` values, `TransportError`,
  `NotModifiedError`, `MalformedResponseError`, `ConfigurationError`) that never carry axios's
  error or config, the key, a signature or a media token.
- Uploads: `media.uploadFile()`, `uploadBytes()` and `uploadStream()` (intent, PUT, complete;
  Node). The PUT uses a separate axios instance with only the signed headers and an explicit
  `Content-Length`, follows no redirects, retries on the same URL until it expires (a stream
  factory is reopened per attempt), honors an `AbortSignal`, and frees the slot after a terminal
  failure unless another call completed the upload. `UploadError` reports the stage, ids,
  request ids and the provider's code with a fix, never the signed URL.
- Webhooks: `verifyWebhook()` / `client.webhooks.verify()` (WebCrypto, constant time, 300 s
  tolerance) and `WebhookEvent` with typed payloads (`review()`, `media()`, `ratingChanged()`,
  `authorErased()`), checked against the vendored `events.md`.
- `examples/quickstart.mjs`, the integration suite (`make integration`) against the pinned server
  image, fixtures captured from it (`make fixtures`), the real `integration` CI job, and the
  weekly `contract-drift` workflow.
- `ApiError` redacts every string in `details`; `NotModifiedError` carries the request id.
- The offline contract gate against the vendored server contract (`make contract`), including
  each response model against its contract schema; real `static`, `test (20)`, `test (22)`,
  `test (24)` and `contract` CI jobs, and `make package-check` (both module formats load; npm
  pack ships `dist/` only).
- Repository bootstrap: Apache-2.0 license, governance files (AGENTS.md, CONTRIBUTING,
  SECURITY, Code of Conduct), issue forms, PR template, Dependabot with auto-merge for minor and
  patch updates, `llms.txt` with a link check, rulesets mirror and export script, and a CI
  skeleton whose required job names are final (placeholder jobs are replaced as code lands).
