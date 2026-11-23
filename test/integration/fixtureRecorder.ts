import { writeFileSync } from "node:fs";
import { join } from "node:path";
import axios, { type AxiosAdapter } from "axios";
import { OPERATIONS } from "../../src/operations";

/** Wraps axios's HTTP adapter and saves the first 2xx body of each operation into testdata/fixtures. */
export function fixtureRecorder(): AxiosAdapter {
  const http = axios.getAdapter("http");
  const saved = new Set<string>();
  return async (config) => {
    const response = await http(config);
    if (response.status < 200 || response.status >= 300 || typeof response.data !== "string") {
      return response;
    }
    const path = new URL(config.url ?? "").pathname.slice("/api/v1".length);
    for (const op of Object.values(OPERATIONS)) {
      const pattern = new RegExp(`^${op.path.replace(/\{[a-z_]+\}/g, "[^/]+")}$`);
      if (
        op.method === (config.method ?? "").toUpperCase() &&
        pattern.test(path) &&
        !saved.has(op.id)
      ) {
        saved.add(op.id);
        writeFileSync(
          join(__dirname, "..", "..", "testdata", "fixtures", `${op.id}.json`),
          response.data,
        );
      }
    }
    return response;
  };
}
