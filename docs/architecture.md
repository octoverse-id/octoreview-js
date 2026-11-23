# Architecture

How the JavaScript SDK is built. The server's `docs/spec.md` section 18 is the contract for every
SDK; this page records how this one meets it. octoreview-go and octoreview-php are the
reference implementations; all three share the operation table's shape, the retry classes and
the gate's checks.

## Layout

| File | Owns |
| --- | --- |
| `src/client.ts`, `src/options.ts` | `new Octoreview()`, `Octoreview.fromEnv()`, the browser guard, client defaults and per-call options |
| `src/operations.ts`, `src/operation.ts` | One table of every REST operation: id, method, path, retry class, surface name, required and optional parameters (wire names), and which travel in the body |
| `src/transport.ts`, `src/redact.ts` | Parameter checks and the query/body split, headers, path escaping, application and namespace defaults, retries, the data envelope, typed errors and redaction |
| `src/resources/*.ts` | `client.<resource>.<method>()` for every operation, plus the `ratings.get` helper |
| `src/models.ts` | camelCase response interfaces and the field specs that decode them from snake_case JSON |
| `src/errors.ts`, `src/errorCodes.ts` | `ApiError` and the 39 code values, `TransportError`, `NotModifiedError`, `MalformedResponseError`, `ConfigurationError` |

One runtime dependency: axios. tsup builds ESM, CommonJS and type declarations for Node 20+.

**Parameters** are camelCase objects. `Transport.split()` converts each top-level key to its wire
name (`externalIds` to `external_ids`; the keys inside `metadata` are the caller's and stay as
given). It refuses an unknown key, a path value, `applicationId` and `includeGlobal` (they come
from call options and the client defaults), checks the contract's required parameters, then
sends each parameter where the contract puts it: the body when the operation lists it as a body
field, the query otherwise. `undefined` is omitted and `null` is sent, so an `update` can clear a
field. An operation without body fields (for example `complete`) sends no body and no
`Content-Type`.

**Models** are interfaces with a field spec each (`SPECS`, `ENTITY_SPEC`, `REVIEW_SPEC`,
`MEDIA_UPLOAD_SPEC`): property, wire name and a typed reader. TypeScript checks that a spec covers
every property of its interface; the readers fail loudly (`MalformedResponseError` naming the
field) instead of passing a wrong type through. Timestamps decode to `Date`. Single results carry
`meta` as a non-enumerable property, so serializing a model gives the model alone.

**Browsers.** A service key must not reach a browser. The constructor refuses when it sees a
`window.document` or a worker scope, unless the caller sets `dangerouslyAllowBrowser: true`; it
never sends `User-Agent` there, since browsers forbid setting it.

**Errors** never carry axios's own error or request config, whose headers include
`Authorization`: `TransportError` keeps only what the retry decision needs (`networkFailure`,
`aborted`, `errorCode`) and a redacted message.

## The contract gate

`make check` runs the gate offline (`make contract` runs it alone) against `testdata/contract/`:
the server's `docs/openapi.yaml` and `docs/sdk-surface.yaml`, vendored as JSON by
`make vendor-contract`, plus `events.md`. `SOURCE` names the server commit.
`test/contract/contract.test.ts` checks:

- the operation table equals the contract: every operation (except `sdk: none`) has one row, with
  the same method, path, body fields and query parameters (both directions);
- each row's JS name, retry class, required and optional parameters equal the surface's;
- every surface method and helper exists on the client, and the client declares nothing else
  (the upload and webhook helpers are listed as pending until the next PR, and the test fails if
  one exists while still listed);
- the error code values equal the contract's `ErrorCode` enum;
- a recording axios adapter calls every operation with self-describing values (`v:entity_type`,
  `v/review_id`, distinct numbers): method, escaped path, each value under its own name in the
  query or the body, credential, namespace and actor headers exactly where the contract declares
  them;
- the spec each method decodes with declares exactly the properties of the schema the contract
  names for that operation's response (`data`, or each item of a list), and the real server
  response in `testdata/fixtures` decodes with mostly non-default values;
- the README's retry table matches the operation table.

## Retries

The transport retries by the surface's retry class: `safe`, `idempotent` and `keyed` calls are
retried on network failures, 503 and 429 (and `complete` on `complete_in_progress` and
`upload_changed`), up to `maxAttempts`, honoring `Retry-After` up to `maxRetryAfterSeconds`;
`unsafe` calls never are. Waits end early when the call's `AbortSignal` fires. `createUpload`
fills in `clientUploadId` (`crypto.randomUUID()`) before the first attempt, so every retry sends
the same key.
