/** How the SDK retries an operation (the server's docs/sdk-surface.yaml retry classes). */
export type RetryClass = "safe" | "idempotent" | "keyed" | "unsafe";

/**
 * One REST operation (see OPERATIONS).
 *
 * @internal
 */
export interface Operation {
  readonly id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to /api/v1, with {name} path parameters. */
  readonly path: string;
  readonly retry: RetryClass;
  /** The surface name, for example reviews.create. */
  readonly jsMethod: string;
  /** Wire names of the parameters the server requires (path, query or body). */
  readonly required: readonly string[];
  /** Wire names of the parameters the server accepts besides those. */
  readonly optional: readonly string[];
  /** The parameters that travel in the JSON body; every other non-path one is a query parameter. */
  readonly body: readonly string[];
}

/** @internal */
export function pathParams(op: Operation): string[] {
  return [...op.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
}

/** @internal */
export function takes(op: Operation, param: string): boolean {
  return op.required.includes(param) || op.optional.includes(param);
}
