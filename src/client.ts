import { ConfigurationError } from "./errors";
import type { OctoreviewOptions } from "./options";
import { redactUrl } from "./redact";
import { AuditLogsService } from "./resources/auditLogs";
import { AuthorsService } from "./resources/authors";
import { EntitiesService } from "./resources/entities";
import { HealthService } from "./resources/health";
import { MediaService } from "./resources/media";
import { RatingsService } from "./resources/ratings";
import { ReviewsService } from "./resources/reviews";
import { SettingsService } from "./resources/settings";
import { Transport } from "./transport";

/** Options of `Octoreview.fromEnv()`: everything but what the environment provides. */
export type FromEnvOptions = Partial<Omit<OctoreviewOptions, "baseUrl" | "apiKey" | "tenantId">>;

/** A browser page or a web worker, where a service key would be public. */
function inBrowser(): boolean {
  const scope = globalThis as { window?: { document?: unknown }; WorkerGlobalScope?: unknown };
  return (
    (typeof scope.window === "object" &&
      scope.window !== null &&
      scope.window.document !== undefined) ||
    typeof scope.WorkerGlobalScope === "function"
  );
}

/**
 * The Octoreview client. One instance per service key; it is safe to share.
 *
 * ```ts
 * const client = new Octoreview({ baseUrl: "https://reviews.example.com", apiKey, tenantId: "mbizmarket", applicationId: "storefront" });
 * const review = await client.reviews.create({ authorId: user.id, rating: 5, entityType: "product", externalId: "sku-1" });
 * ```
 */
export class Octoreview {
  readonly health: HealthService;
  readonly entities: EntitiesService;
  readonly ratings: RatingsService;
  readonly settings: SettingsService;
  readonly reviews: ReviewsService;
  readonly media: MediaService;
  readonly authors: AuthorsService;
  readonly auditLogs: AuditLogsService;

  constructor(options: OctoreviewOptions) {
    const browser = inBrowser();
    if (browser && options.dangerouslyAllowBrowser !== true) {
      throw new ConfigurationError(
        "octoreview: refusing to run in a browser, where the service key would be public; call Octoreview from your server, or set dangerouslyAllowBrowser: true for a trusted context",
      );
    }
    let url: URL | null = null;
    try {
      url = new URL(options.baseUrl);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
      throw new ConfigurationError(
        `octoreview: base URL "${redactUrl(String(options.baseUrl))}" must be an absolute http(s) URL`,
      );
    }
    if (!options.apiKey) {
      throw new ConfigurationError(
        "octoreview: the API key is empty; pass a service key (ocr_...)",
      );
    }
    if (!options.tenantId) {
      throw new ConfigurationError("octoreview: the tenant id is empty");
    }
    if (options.namespace && (!options.namespace.type || !options.namespace.id)) {
      throw new ConfigurationError("octoreview: a namespace needs both a type and an id");
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new ConfigurationError("octoreview: maxAttempts must be at least 1");
    }
    const transport = new Transport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      tenantId: options.tenantId,
      applicationId: options.applicationId,
      namespace: options.namespace,
      actorId: options.actorId,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxAttempts,
      maxRetryAfterSeconds: options.maxRetryAfterSeconds ?? 30,
      adapter: options.adapter,
      sendUserAgent: !browser,
    });
    this.health = new HealthService(transport);
    this.entities = new EntitiesService(transport);
    this.ratings = new RatingsService(transport, this.entities);
    this.settings = new SettingsService(transport);
    this.reviews = new ReviewsService(transport);
    this.media = new MediaService(transport);
    this.authors = new AuthorsService(transport);
    this.auditLogs = new AuditLogsService(transport);
  }

  /**
   * Builds a client from OCTOREVIEW_BASE_URL, OCTOREVIEW_API_KEY, OCTOREVIEW_TENANT_ID and the
   * optional OCTOREVIEW_APPLICATION_ID (the server's compose stack writes all four with
   * `make dev-env`). An applicationId in `options` wins over the variable.
   */
  static fromEnv(
    options: FromEnvOptions = {},
    env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
  ): Octoreview {
    const value = (name: string) => (env[name] ?? "").trim();
    const missing = ["OCTOREVIEW_BASE_URL", "OCTOREVIEW_API_KEY", "OCTOREVIEW_TENANT_ID"].filter(
      (name) => value(name) === "",
    );
    if (missing.length > 0) {
      throw new ConfigurationError(`octoreview: set ${missing.join(", ")}`);
    }
    const application = value("OCTOREVIEW_APPLICATION_ID");
    return new Octoreview({
      ...options,
      baseUrl: value("OCTOREVIEW_BASE_URL"),
      apiKey: value("OCTOREVIEW_API_KEY"),
      tenantId: value("OCTOREVIEW_TENANT_ID"),
      applicationId: options.applicationId ?? (application === "" ? undefined : application),
    });
  }
}
