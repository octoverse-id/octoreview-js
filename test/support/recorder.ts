import {
  type AxiosAdapter,
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

/** A canned answer: a status, a body (JSON-encoded unless a string) and headers. */
export interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One recorded request, normalized. */
export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * An axios adapter that records every request and answers from a queue (or a responder). Unit
 * tests never touch the network.
 */
export class Recorder {
  readonly requests: Recorded[] = [];
  private readonly queue: (Answer | Error)[] = [];

  constructor(private readonly responder?: (request: Recorded) => Answer) {}

  push(...answers: (Answer | Error)[]): this {
    this.queue.push(...answers);
    return this;
  }

  get last(): Recorded {
    const request = this.requests.at(-1);
    if (!request) {
      throw new Error("no request was sent");
    }
    return request;
  }

  readonly adapter: AxiosAdapter = async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers.toJSON())) {
      if (value !== undefined && value !== null) {
        headers[name.toLowerCase()] = String(value);
      }
    }
    const request: Recorded = {
      method: (config.method ?? "get").toUpperCase(),
      url: new URL(config.url ?? ""),
      headers,
      body: typeof config.data === "string" ? config.data : undefined,
    };
    this.requests.push(request);
    const answer = this.queue.shift() ?? this.responder?.(request);
    if (answer === undefined) {
      throw new Error(`Recorder: no answer queued for ${request.method} ${request.url}`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      status: answer.status,
      statusText: "",
      headers: Object.fromEntries(
        Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      config,
      data: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? ""),
    };
  };
}

/** The server's error envelope. */
export function apiError(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Answer {
  return {
    status,
    headers,
    body: {
      error: {
        code,
        message: `the server said ${code}`,
        details,
        request_id: `req-${code}`,
        doc_url: `https://docs.example/errors#${code}`,
        retryable: status === 429 || status === 503,
      },
    },
  };
}

/** A network failure as axios reports it: the error carries the request config (and its headers). */
export function networkFailure(
  code: string,
  message: string,
  url = "https://reviews.example.com/api/v1/x",
): AxiosError {
  const config = {
    url,
    headers: { Authorization: "Bearer ocr_live_secret" },
  } as unknown as InternalAxiosRequestConfig;
  return new AxiosError(message, code, config);
}
