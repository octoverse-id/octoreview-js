import { type HealthLive, type HealthReady, SPECS, type WithMeta } from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/** The unauthenticated probes. */
export class HealthService extends Service {
  /** The server process serves. */
  live(options?: CallOptions): Promise<WithMeta<HealthLive>> {
    return this.one("getHealthLive", [], {}, options, SPECS.HealthLive);
  }

  /** Whether the server and its database serve; `status` is "unavailable" (not an error) when the database is down. */
  ready(options?: CallOptions): Promise<WithMeta<HealthReady>> {
    return this.one("getHealthReady", [], {}, options, SPECS.HealthReady, 503);
  }
}
