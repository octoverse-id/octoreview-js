import { MalformedResponseError } from "../errors";
import { decode, type Page, SPECS, type Spec, type WithMeta } from "../models";
import { OPERATIONS } from "../operations";
import type { CallOptions, ResponseMeta } from "../options";
import type { Envelope, Transport } from "../transport";

/**
 * Shared plumbing of the resource services: send one operation, decode its data. Subclasses
 * declare only surface methods (the contract gate lists their prototypes).
 *
 * @internal
 */
export abstract class Service {
  constructor(protected readonly transport: Transport) {}

  protected send(
    operation: string,
    pathValues: readonly string[],
    params: object,
    options: CallOptions | undefined,
    acceptStatus?: number,
  ): Promise<Envelope> {
    const op = OPERATIONS[operation];
    if (!op) {
      throw new Error(`octoreview: unknown operation ${operation}`);
    }
    return this.transport.call(op, pathValues, { ...params }, options, acceptStatus);
  }

  protected async one<T>(
    operation: string,
    pathValues: readonly string[],
    params: object,
    options: CallOptions | undefined,
    spec: Spec<T>,
    acceptStatus?: number,
  ): Promise<WithMeta<T>> {
    const envelope = await this.send(operation, pathValues, params, options, acceptStatus);
    return decoding(envelope.meta, () =>
      withMeta(decode(spec, envelope.data, "data"), envelope.meta),
    );
  }

  protected async page<T>(
    operation: string,
    pathValues: readonly string[],
    params: object,
    options: CallOptions | undefined,
    spec: Spec<T>,
  ): Promise<Page<T>> {
    const envelope = await this.send(operation, pathValues, params, options);
    return decoding(envelope.meta, () => {
      if (envelope.pagination === null || envelope.pagination === undefined) {
        throw new MalformedResponseError(`octoreview: ${operation} answered without pagination`);
      }
      return {
        items: items(envelope.data, spec, operation),
        pagination: decode(SPECS.Pagination, envelope.pagination, "pagination"),
        meta: envelope.meta,
      };
    });
  }

  protected async many<T>(
    operation: string,
    pathValues: readonly string[],
    params: object,
    options: CallOptions | undefined,
    spec: Spec<T>,
  ): Promise<T[]> {
    const envelope = await this.send(operation, pathValues, params, options);
    return decoding(envelope.meta, () => items(envelope.data, spec, operation));
  }
}

function items<T>(data: unknown, spec: Spec<T>, operation: string): T[] {
  if (!Array.isArray(data)) {
    throw new MalformedResponseError(`octoreview: ${operation} answered data that is not a list`);
  }
  return data.map((item, i) => decode(spec, item, `data[${i}]`));
}

/** Attaches `meta` without making it part of the model's own (enumerable, serialized) fields. */
function withMeta<T>(model: T, meta: ResponseMeta): WithMeta<T> {
  Object.defineProperty(model, "meta", { value: meta, enumerable: false });
  return model as WithMeta<T>;
}

/** Runs a decode, adding the response's request id to a MalformedResponseError. */
function decoding<T>(meta: ResponseMeta, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof MalformedResponseError && error.requestId === null && meta.requestId) {
      throw new MalformedResponseError(error.message, meta.requestId);
    }
    throw error;
  }
}
