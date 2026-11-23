.DEFAULT_GOAL := help
SHELL := /bin/bash

# `make check` is the fast gate: Node and npm only (no Docker, no network once dependencies are
# installed). `make release-check` is the full gate. CI runs the same targets.

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

node_modules/.package-lock.json: package-lock.json
	@npm ci --no-audit --no-fund

install: node_modules/.package-lock.json ## Install the locked dependencies

lint: install ## Lint and check formatting (biome)
	@npx biome check .

typecheck: install ## Type-check src and tests (tsc, strict)
	@npx tsc --noEmit

build: install ## Build dist/ (ESM, CommonJS and type declarations)
	@npx tsup

package-check: build ## Load both module formats from dist/ and check what npm pack ships
	@./scripts/package-check.sh

test: install ## Run the unit tests (offline)
	@npx vitest run --project unit

contract: install ## Run the offline contract gate against testdata/contract (server docs/spec.md section 18)
	@npx vitest run --project contract

vendor-contract: ## Refresh testdata/contract from the server (SERVER=<ref or checkout path>, default main; network)
	@./scripts/vendor-contract.sh $(or $(SERVER),main)

llms-check: ## Fail when llms.txt links a missing local path (and prove the check can fail)
	@./scripts/check-llms-txt.sh
	@./scripts/check-llms-txt-test.sh

actionlint: ## Lint GitHub Actions workflows (needs actionlint on PATH)
	@actionlint -color

placeholder-check: ## Fail while any bootstrap CI placeholder job remains
	@if grep -rn 'octoreview:placeholder' .github/workflows; then \
		echo "placeholder-check: bootstrap placeholder jobs remain; replace them before a release" >&2; exit 1; \
	fi; echo "placeholder-check OK"

check: lint typecheck test contract package-check llms-check ## Fast gate (Node and npm only)

release-check: check placeholder-check ## Full pre-release gate (fails while placeholders remain)

export-rulesets: ## Export the live rulesets into .github/rulesets/ (needs gh with repo admin)
	@./scripts/export-rulesets.sh

.PHONY: help install lint typecheck build package-check test contract vendor-contract llms-check actionlint placeholder-check check release-check export-rulesets
