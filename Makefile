# Engineering Toolkit — an Obsidian plugin
#
# Run `make` with no arguments for the list.
#
# Obsidian loads a plugin out of <vault>/.obsidian/plugins/engineering-toolkit/, so the built
# bundle is an artefact and this tree is the source. Edit here, then install --
# never the other way round.

SHELL       := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# The vault to install into. Nothing is assumed: pass VAULT=, or set OBSIDIAN_VAULT.
# Use a throwaway vault while developing, never your real one.
VAULT ?= $(OBSIDIAN_VAULT)

.PHONY: help
help: ## Show this help
	@echo
	@echo "  Engineering Toolkit — an Obsidian plugin"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  installs to $(if $(VAULT),$(VAULT)/.obsidian/plugins/engineering-toolkit,the vault named by VAULT=)"
	@echo

# --- install ----------------------------------------------------------------

# obsidian-plugin-install is used when it is on PATH; otherwise the script in
# scripts/ does the same build and copy.
.PHONY: install
install: need-vault ## Build and install into VAULT
	@if command -v obsidian-plugin-install >/dev/null 2>&1; then \
		OBSIDIAN_VAULT="$(VAULT)" obsidian-plugin-install "$(CURDIR)"; \
	else \
		scripts/install-plugin.sh "$(VAULT)"; \
	fi

.PHONY: plan
plan: need-vault ## What install would build and copy, changing nothing
	@if command -v obsidian-plugin-install >/dev/null 2>&1; then \
		OBSIDIAN_VAULT="$(VAULT)" obsidian-plugin-install -n "$(CURDIR)"; \
	else \
		scripts/install-plugin.sh -n "$(VAULT)"; \
	fi

.PHONY: need-vault
need-vault:
	@if [ -z "$(VAULT)" ]; then \
		echo "  VAULT is not set. Name the vault to install into, for example:" >&2; \
		echo '    make install VAULT="$$HOME/obsidian-test-vault"' >&2; \
		exit 2; \
	fi

# --- build ------------------------------------------------------------------

.PHONY: build
build: ## Type-check and produce the production bundle
	@npm run build

.PHONY: dev
dev: ## Rebuild on change
	@npm run dev

# --- checks -----------------------------------------------------------------

.PHONY: test
test: ## The suite
	@npm test

.PHONY: manifest
manifest: ## Check manifest.json, package.json and versions.json agree
	@node scripts/check-manifest.mjs

.PHONY: check
check: build test manifest ## Everything a commit has to pass
	@echo
	@echo "  the bundle builds, the suite passes and the versions agree"
