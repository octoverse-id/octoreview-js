import { readFileSync } from "node:fs";
import { join } from "node:path";

type Node = Record<string, unknown> & { $ref?: string };

const root = join(__dirname, "..", "..");

function read(file: string): Node {
  return JSON.parse(readFileSync(join(root, "testdata", "contract", file), "utf8")) as Node;
}

/** The vendored server contract (testdata/contract). */
export const openapi = read("openapi.json");
export const surface = read("sdk-surface.json") as unknown as {
  operations: {
    operation: string;
    js?: string;
    retry?: string;
    required?: string[];
    optional?: string[];
    sdk?: string;
  }[];
  helpers: { name: string; js: string }[];
};

function resolve(node: Node): Node {
  if (!node.$ref) {
    return node;
  }
  let target: unknown = openapi;
  for (const part of node.$ref.slice(2).split("/")) {
    target = (target as Record<string, unknown>)[part];
  }
  return target as Node;
}

/** A recorded call's expectations: method, path, and its query, header and body parameter names. */
export interface ContractOperation {
  method: string;
  path: string;
  query: string[];
  headers: string[];
  body: string[];
  responses: Record<string, Node>;
}

export function operations(): Record<string, ContractOperation> {
  const out: Record<string, ContractOperation> = {};
  for (const [path, item] of Object.entries(openapi.paths as Record<string, Node>)) {
    const common = (item.parameters as Node[] | undefined) ?? [];
    for (const [method, raw] of Object.entries(item)) {
      if (method === "parameters") {
        continue;
      }
      const op = raw as Node;
      const params = [...common, ...((op.parameters as Node[] | undefined) ?? [])].map(resolve);
      const content = (op.requestBody as Node | undefined)?.content as
        | Record<string, Node>
        | undefined;
      const schema = content?.["application/json"]?.schema as Node | undefined;
      const body = schema ? resolve(schema) : undefined;
      out[op.operationId as string] = {
        method: method.toUpperCase(),
        path,
        query: params.filter((p) => p.in === "query").map((p) => p.name as string),
        headers: params.filter((p) => p.in === "header").map((p) => p.name as string),
        body: Object.keys((body?.properties as Node | undefined) ?? {}),
        responses: op.responses as Record<string, Node>,
      };
    }
  }
  return out;
}

/** A component schema's property names. */
export function properties(schema: string): string[] {
  const node = (openapi.components as Node).schemas as Record<string, Node>;
  return Object.keys((node[schema]?.properties as Node | undefined) ?? {});
}

/** The schema an operation's success response carries under `data`, and whether it is a list. */
export function responseData(
  id: string,
): { schema: string; fields: string[]; list: boolean } | null {
  const op = operations()[id];
  if (!op) {
    return null;
  }
  const code = Object.keys(op.responses)
    .filter((c) => c.startsWith("2"))
    .sort()[0];
  if (!code) {
    return null;
  }
  const response = resolve(op.responses[code] as Node);
  const schema = (response.content as Record<string, Node> | undefined)?.["application/json"]
    ?.schema as Node | undefined;
  const data = schema
    ? (resolve(schema).properties as Record<string, Node> | undefined)?.data
    : undefined;
  if (!data) {
    return null;
  }
  const list = data.type === "array";
  const item = list ? (data.items as Node) : data;
  if (item.$ref) {
    const name = item.$ref.slice(item.$ref.lastIndexOf("/") + 1);
    return { schema: name, fields: properties(name), list };
  }
  return {
    schema: "inline",
    fields: Object.keys((item.properties as Node | undefined) ?? {}),
    list,
  };
}

/** The error codes the contract declares. */
export function errorCodes(): string[] {
  const schemas = (openapi.components as Node).schemas as Record<string, Node>;
  return schemas.ErrorCode?.enum as string[];
}

/** A captured server response (testdata/fixtures). */
export function fixture(id: string): string {
  return readFileSync(join(root, "testdata", "fixtures", `${id}.json`), "utf8");
}
