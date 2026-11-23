import { ConfigurationError } from "../errors";
import { type ApplicationSettings, SPECS, type WithMeta } from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/** settings.put: every field; one left out is sent as null and inherits the server default. */
export interface PutSettingsParams {
  maxImages?: number | null;
  maxVideos?: number | null;
  maxImageBytes?: number | null;
  maxVideoBytes?: number | null;
  allowedContentTypes?: string[] | null;
  moderationMode?: "auto_publish" | "pre_moderation" | null;
  maxStorageBytes?: number | null;
}

const FIELDS = [
  "maxImages",
  "maxVideos",
  "maxImageBytes",
  "maxVideoBytes",
  "allowedContentTypes",
  "moderationMode",
  "maxStorageBytes",
] as const;

/** An application's media policy defaults, moderation mode and storage quota. */
export class SettingsService extends Service {
  /** An undefined application id uses CallOptions.applicationId, then the client default. */
  get(applicationId?: string, options?: CallOptions): Promise<WithMeta<ApplicationSettings>> {
    const application = applicationId ?? requireApplication(this.transport.application(options));
    return this.one(
      "getApplicationSettings",
      [application],
      {},
      options,
      SPECS.ApplicationSettings,
    );
  }

  /** Replaces the settings (retry-safe). */
  put(
    applicationId: string | undefined,
    settings: PutSettingsParams,
    options?: CallOptions,
  ): Promise<WithMeta<ApplicationSettings>> {
    const application = applicationId ?? requireApplication(this.transport.application(options));
    const params = Object.fromEntries(FIELDS.map((f) => [f, settings[f] ?? null]));
    return this.one(
      "putApplicationSettings",
      [application],
      { ...settings, ...params },
      options,
      SPECS.ApplicationSettings,
    );
  }
}

function requireApplication(applicationId: string | undefined): string {
  if (!applicationId) {
    throw new ConfigurationError(
      "octoreview: settings need an application id, CallOptions.applicationId or a client default",
    );
  }
  return applicationId;
}
