import { type EraseResult, SPECS, type WithMeta } from "../models";
import type { CallOptions } from "../options";
import { Service } from "./service";

/** Author data rights. */
export class AuthorsService extends Service {
  /**
   * Redacts one batch of an author's reviews and schedules their media for deletion. Call it
   * again while `remaining` is above 0 (retry-safe).
   */
  erase(authorId: string, options?: CallOptions): Promise<WithMeta<EraseResult>> {
    return this.one("eraseAuthor", [], { authorId }, options, SPECS.EraseResult);
  }
}
