#!/usr/bin/env bash
# Prove the built package works as published (make package-check; CI static): both module
# formats load from dist/ and build a client, and `npm pack` ships dist/ and nothing private.
set -euo pipefail
cd "$(dirname "$0")/.."
node -e '
const { Octoreview, VERSION } = require("./dist/index.cjs");
new Octoreview({ baseUrl: "https://reviews.example.com", apiKey: "ocr_x", tenantId: "t" });
console.log("package-check: CommonJS OK", VERSION);'
node --input-type=module -e '
import { Octoreview, VERSION } from "./dist/index.js";
new Octoreview({ baseUrl: "https://reviews.example.com", apiKey: "ocr_x", tenantId: "t" });
console.log("package-check: ESM OK", VERSION);'
files=$(npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].files.map(f=>f.path).join("\n")))')
unexpected=$(printf '%s\n' "$files" | grep -vE '^(dist/|package\.json$|README\.md$|LICENSE$|NOTICE$|CHANGELOG\.md$)' || true)
if [ -n "$unexpected" ]; then
  echo "package-check: the package would ship unexpected files:" >&2
  printf '%s\n' "$unexpected" >&2
  exit 1
fi
echo "package-check: npm pack ships $(printf '%s\n' "$files" | wc -l) files, all expected"
