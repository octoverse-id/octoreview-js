import { type AuditLog, type Page, SPECS } from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/** Filters of auditLogs.list. */
export interface ListAuditLogsParams {
  action?: string;
  aggregateType?: string;
  aggregateId?: string;
  actorId?: string;
  limit?: number;
  offset?: number;
}

/** The record of every change. */
export class AuditLogsService extends Service {
  list(params: ListAuditLogsParams = {}, options?: CallOptions): Promise<Page<AuditLog>> {
    return this.page("listAuditLogs", [], params, options, SPECS.AuditLog);
  }
}
