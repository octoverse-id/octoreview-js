# Release runbook

Releases of octoreview-js are cut from `main` through a dedicated PR and published by
`.github/workflows/publish.yml` when the tag is pushed.

## Invariants

- A release PR is named `release/<version>` and only bumps the version and moves the
  `[Unreleased]` CHANGELOG entries under the new version heading. The version lives in
  `package.json`, both copies in `package-lock.json` (`npm version <v> --no-git-tag-version`
  keeps them in step) and `src/version.ts` (sent in the User-Agent); `make version-check` fails
  until they and a `## [<version>] - <date>` CHANGELOG heading agree, and always on a `-dev`
  version.
- The tag `v<version>` is created on the merge commit of that PR after its CI is green.
- Release tags never move: the `release tags: never move` ruleset rejects re-pointing or
  force-pushing a `v*` tag, admins included. Only repo admins can delete a wrong tag
  (`release tags: deletion is admin-only`), and the version is then re-cut, not re-used.
- `make release-check` must pass on the release commit.

## Steps

1. Open an issue for the release and a `release/<version>` branch from `main`.
2. Bump the version and update `CHANGELOG.md`; open the PR with `Closes #<issue-number>`.
   `make version-check` passes on the branch.
3. Merge when CI is green and `make release-check` passes on the merge commit, then wait for that
   commit's CI run on `main`. Tag the merge commit `v<version>` and push the tag.
4. The tag starts `.github/workflows/publish.yml`. Before checking out the tree it refuses a commit
   that is not on `main` or has no green CI push run on `main`; then it refuses stamps that disagree
   with the tag (`scripts/version-check.sh`) and a commit that is not the release merge
   (`scripts/check-release-merge.sh`). It runs `npm publish` in the `npm` environment through npm
   trusted publishing (an OIDC token, no stored npm token; provenance is attached), with the
   dist-tag `latest` for `X.Y.Z` and `next` for `X.Y.Z-rc.N`, and waits until the registry serves
   the version. It creates the GitHub release from the CHANGELOG section
   (`scripts/release-notes.sh`), marked pre-release for `-rc.N`.
5. A failed run is re-run from the Actions tab, never re-tagged. npm never accepts the same version
   twice, even after an unpublish, so if the tag or the published package is wrong the version is
   burned and the next one is cut.

`make release-tooling-check` (part of `make check`) proves the three scripts pass and fail as
documented, against real merge commits.

## One-time setup

- **GitHub environment `npm`** (repository settings, Environments): deployment branches and tags
  limited to tags matching `v*`. The publish job runs in it, so only a release tag can request the
  OIDC token npm accepts.
- **npm trusted publisher** (npmjs.com, package `@octoverse-id/octoreview`, Settings, Trusted
  publishing): GitHub Actions, repository `octoverse-id/octoreview-js`, workflow `publish.yml`,
  environment `npm`. Add it shortly before the first tag: npm drops a configuration whose first
  publish does not succeed within two days. Trusted publishing needs npm 11.5.1 or later, which the
  workflow installs.

## Rehearsing a release

Run the Publish workflow from `main` (Actions, "Run workflow"). It runs the main and CI gates and
extracts the `[Unreleased]` notes (or, right after a release, the newest section), but skips the two
release-commit checks, npm's upload (`npm publish --dry-run`) and the GitHub release. Rehearse after
changing `publish.yml` or the release scripts.

## Who can publish

Anyone who can push a `v*` tag. GitHub loads `publish.yml` from the pushed tag, so the gates above
guard against mistakes, not against someone with write access, who could push a tag whose workflow
skips them. The `release tags: never move` and `release tags: deletion is admin-only` rulesets keep
a published tag in place. npm accepts a publish of this package only from this repository's
`publish.yml` running in the `npm` environment.
