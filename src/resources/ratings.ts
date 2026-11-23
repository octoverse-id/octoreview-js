import {
  type BatchRating,
  type EntityRating,
  type RatingSummary,
  SPECS,
  type WithMeta,
} from "../models";
import type { CallOptions } from "../options";
import type { Transport } from "../transport";
import type { EntitiesService } from "./entities";
import { Service } from "./service";

/** ratings.query: the summaries of many external ids at once (a listing page). */
export interface QueryRatingsParams {
  entityType: string;
  externalIds: string[];
}

/** Rating summaries of published reviews. */
export class RatingsService extends Service {
  constructor(
    transport: Transport,
    private readonly entities: EntitiesService,
  ) {
    super(transport);
  }

  forEntity(entityId: string, options?: CallOptions): Promise<WithMeta<EntityRating>> {
    return this.one("getEntityRating", [entityId], {}, options, SPECS.EntityRating);
  }

  /** One summary per external id, in request order; unknown ids answer zeros. */
  query(params: QueryRatingsParams, options?: CallOptions): Promise<BatchRating[]> {
    return this.many("queryRatings", [], params, options, SPECS.BatchRating);
  }

  /**
   * The summary of {entityType, externalId} without knowing the entity id (the ratingsByKey
   * helper; it composes entities.lookup). An entity that does not exist yet throws ApiError
   * `entity_not_found`.
   */
  async get(entityType: string, externalId: string, options?: CallOptions): Promise<RatingSummary> {
    return (await this.entities.lookup(entityType, externalId, options)).rating;
  }
}
