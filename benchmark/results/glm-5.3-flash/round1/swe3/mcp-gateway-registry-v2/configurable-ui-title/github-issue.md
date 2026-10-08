# GitHub Issue: Configurable UI title via UI_TITLE (deployment-mode-aware default)

## Title
Add optional `UI_TITLE` configuration parameter so the UI title is brandable and correct for registry-only deployments

## Labels
- enhancement
- configuration
- frontend
- backwards-compatibility

## Description

### Problem Statement
The top-left UI title is the hardcoded string `AI Gateway & Registry`, baked into several frontend files (`Layout.tsx`, `Login.tsx`, `Logout.tsx`, `UptimeDisplay.tsx`). That is wrong for registry-only deployments (`DEPLOYMENT_MODE=registry-only` has no gateway, so the title should read `AI Registry`), and enterprises that want their own product name have to fork the frontend to rebrand it.

### Proposed Solution
Add an optional `UI_TITLE` configuration parameter to the registry Settings model:

- When `UI_TITLE` is set (non-empty), the UI shows that exact string.
- When it is unset (or empty), the title is derived from the existing `DEPLOYMENT_MODE`: `AI Gateway & Registry` for `with-gateway` and `AI Registry` for `registry-only`.
- The effective title is served from the existing `GET /api/config` endpoint (and shown in the System Config admin panel under the Deployment group), so the frontend reads it at runtime and no frontend rebuild is needed.
- The parameter is plumbed through all three deployment surfaces: Docker/Docker Compose (`.env.example` and every compose file), Terraform/ECS (root and module variables, task definition, tfvars example), and Helm (registry chart values, its deployment template, the reserved-env list, and the stack chart values).

Deployments that do not set `UI_TITLE` see no change in `with-gateway` mode (title stays `AI Gateway & Registry`).

### User Stories
- As an operator running `DEPLOYMENT_MODE=registry-only`, I want the UI to read `AI Registry` so that users are not misled into thinking a gateway is present.
- As an enterprise operator, I want to set `UI_TITLE="Acme AI Platform"` so my deployment is branded without forking or rebuilding the frontend.
- As a developer, I want the title served by `/api/config` so the frontend keeps using its existing runtime-config pattern.

### Acceptance Criteria
- [ ] `Settings` gains an optional `ui_title: str | None = None` field; an empty string is treated as unset.
- [ ] A mode-aware `effective_ui_title` property returns `UI_TITLE` when set, else `AI Registry` for `registry-only`, else `AI Gateway & Registry`.
- [ ] `GET /api/config` returns `ui_title` (effective value).
- [ ] `GET /api/config/full` (System Config admin panel) lists `UI Title` in the `deployment` group.
- [ ] Layout header, Login, Logout, and UptimeDisplay tooltip render the title from `/api/config` with the current hardcoded strings as fallback.
- [ ] `.env.example` documents `UI_TITLE`; all three compose files pass `UI_TITLE` through to the registry container.
- [ ] Terraform: `ui_title` variable added at root and `mcp-gateway` module, passed in `main.tf`, injected as `UI_TITLE` env in the task definition, documented in `terraform.tfvars.example`.
- [ ] Helm: `uiTitle` value in `charts/registry/values.yaml` and `charts/mcp-gateway-registry-stack/values.yaml`, rendered conditionally in `charts/registry/templates/deployment.yaml`, `UI_TITLE` added to the reserved env names.
- [ ] Deployments that do not set `UI_TITLE` see no behavioral change (with-gateway default title unchanged; Helm template renders no extra env when unset).

### Out of Scope
- i18n of the title
- Per-user customization
- Favicon / logo changes
- The pre-first-render browser tab title in the static `index.html`
- Changing `REGISTRY_NAME` (federation card name, an unrelated UI concept)

### Dependencies
- None. This change uses only existing dependencies.

### Related Issues
- Reference: agentic-community/mcp-gateway-registry#984
