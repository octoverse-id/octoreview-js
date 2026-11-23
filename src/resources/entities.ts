import { ENTITY_SPEC, type Entity, type Page, type WithMeta } from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/** Filters of entities.list. */
export interface ListEntitiesParams {
  entityType?: string;
  externalId?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

/** Media policy overrides: null inherits the application, then the server. */
export interface MediaPolicyParams {
  maxImages?: number | null;
  maxVideos?: number | null;
  maxImageBytes?: number | null;
  maxVideoBytes?: number | null;
}

/** entities.upsert: the entity's key, metadata and media policy overrides. */
export interface UpsertEntityParams extends MediaPolicyParams {
  entityType: string;
  externalId: string;
  metadata?: Record<string, unknown>;
}

/** entities.update: only the given fields change. */
export interface UpdateEntityParams extends MediaPolicyParams {
  metadata?: Record<string, unknown>;
  isActive?: boolean;
}

/** Reviewable entities: an external resource such as product/sku-1, with its media policy. */
export class EntitiesService extends Service {
  list(params: ListEntitiesParams = {}, options?: CallOptions): Promise<Page<Entity>> {
    return this.page("listEntities", [], params, options, ENTITY_SPEC);
  }

  /** Creates the entity or updates it in place (retry-safe). */
  upsert(params: UpsertEntityParams, options?: CallOptions): Promise<WithMeta<Entity>> {
    return this.one("upsertEntity", [], params, options, ENTITY_SPEC);
  }

  /** Finds an entity by its key; a missing one throws ApiError `entity_not_found`. */
  lookup(entityType: string, externalId: string, options?: CallOptions): Promise<WithMeta<Entity>> {
    return this.one("lookupEntity", [], { entityType, externalId }, options, ENTITY_SPEC);
  }

  get(entityId: string, options?: CallOptions): Promise<WithMeta<Entity>> {
    return this.one("getEntity", [entityId], {}, options, ENTITY_SPEC);
  }

  /** Changes the given fields only; a null media policy value inherits. */
  update(
    entityId: string,
    params: UpdateEntityParams,
    options?: CallOptions,
  ): Promise<WithMeta<Entity>> {
    return this.one("updateEntity", [entityId], params, options, ENTITY_SPEC);
  }

  /** Stops new reviews of the entity; existing ones stay readable. */
  deactivate(entityId: string, options?: CallOptions): Promise<WithMeta<Entity>> {
    return this.one("deactivateEntity", [entityId], {}, options, ENTITY_SPEC);
  }
}
