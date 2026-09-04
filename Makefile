# Root Makefile — orchestration layer, delegates only, no build logic here
# All actual build commands are defined in each sub-project's Makefile

.PHONY: help test lint lint-config test-e2e helm-e2e-install helm-e2e-crd-check helm-e2e-verify helm-e2e-uninstall helm-e2e-cleanup build

.DEFAULT_GOAL := help

# ============================================================
# Global targets
# ============================================================

test: ## Run tests for all sub-projects
	$(MAKE) -C operator test

lint: ## Run linters for all sub-projects
	$(MAKE) -C operator lint

lint-config: ## Verify linter configuration for all sub-projects
	$(MAKE) -C operator lint-config

test-e2e: ## Run end-to-end tests for all sub-projects
	$(MAKE) -C operator test-e2e

helm-e2e-install: ## Install operator via helm into the dedicated kind cluster
	$(MAKE) -C operator helm-e2e-install

helm-e2e-crd-check: ## Verify CRDs/VAPs/RBAC installed by the helm-e2e chart
	$(MAKE) -C operator helm-e2e-crd-check

helm-e2e-verify: ## Full gpu-less happy path via helm-installed operator
	$(MAKE) -C operator helm-e2e-verify

helm-e2e-uninstall: ## Uninstall the helm-e2e operator release (CRDs kept)
	$(MAKE) -C operator helm-e2e-uninstall

helm-e2e-cleanup: ## Delete the dedicated helm e2e kind cluster
	$(MAKE) -C operator helm-e2e-cleanup

build: ## Build all sub-projects
	$(MAKE) -C operator build

# ============================================================
# Help
# ============================================================

help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
