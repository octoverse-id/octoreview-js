#!/usr/bin/env bash
# The version stamps of a release must agree (make version-check; docs/release.md). publish.yml
# runs it with the tag's version; a release PR makes it pass.
#
#   package.json       "version": "0.1.0"   (what npm publishes)
#   package-lock.json  "version" and packages[""].version (npm version keeps them in step)
#   src/version.ts     export const VERSION = "0.1.0";   (sent in the User-Agent)
#   CHANGELOG.md       a "## [0.1.0] - YYYY-MM-DD" heading
#
# A development version (0.1.0-dev) is never releasable, so this fails on main between releases.
#
# Usage: scripts/version-check.sh [VERSION] [REPO_DIR]
#   VERSION   the version the stamps must name ("0.1.0" or "v0.1.0"); default: package.json's
# Exit codes: 0 agree | 1 disagree or not releasable | 2 unreadable or usage
set -euo pipefail
expected=${1:-}
expected=${expected#v}
cd "${2:-$(dirname "$0")/..}"

read_json() { # FILE KEY.PATH (an empty segment is the "" key: packages..version)
  node -e '
    const [file, path] = process.argv.slice(1);
    const data = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data);
    if (typeof value !== "string") process.exit(1);
    process.stdout.write(value);' "$1" "$2" 2>/dev/null
}
pkg=$(read_json package.json version) || { echo "version-check: could not read package.json" >&2; exit 2; }
lock=$(read_json package-lock.json version) || { echo "version-check: could not read package-lock.json" >&2; exit 2; }
lockroot=$(read_json package-lock.json packages..version) ||
  { echo "version-check: could not read packages[\"\"] in package-lock.json" >&2; exit 2; }
ts=$(sed -nE 's/^export const VERSION = "([^"]+)";$/\1/p' src/version.ts 2>/dev/null | head -n1)
[ -n "$ts" ] || { echo "version-check: could not read the version from src/version.ts" >&2; exit 2; }

echo "package.json=$pkg package-lock.json=$lock/$lockroot src/version.ts=$ts"
status=0
if ! [[ $pkg =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  echo "FAIL  $pkg is not a releasable X.Y.Z or X.Y.Z-rc.N version (a release PR sets one)"
  status=1
fi
for pair in "package-lock.json:$lock" "package-lock.json packages[\"\"]:$lockroot" "src/version.ts:$ts"; do
  [ "${pair##*:}" = "$pkg" ] || { echo "FAIL  ${pair%:*} says ${pair##*:}, not $pkg"; status=1; }
done
if [ -n "$expected" ] && [ "$pkg" != "$expected" ]; then
  echo "FAIL  package.json says $pkg, not $expected"
  status=1
fi
grep -qE "^## \[$(printf '%s' "$pkg" | sed 's/\./\\./g')\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md ||
  { echo "FAIL  CHANGELOG.md has no \"## [$pkg] - YYYY-MM-DD\" heading"; status=1; }
[ "$status" = 0 ] && echo "version-check OK ($pkg)"
exit "$status"
