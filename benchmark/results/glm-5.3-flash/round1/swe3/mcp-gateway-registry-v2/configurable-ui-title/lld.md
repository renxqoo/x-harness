# Low-Level Design: Configurable UI Title (UI_TITLE)

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (revised after expert review, see review.md)*

## Table of Contents
1. [Overview](#overview)
2. [Codebase Analysis](#codebase-analysis)
3. [Architecture](#architecture)
4. [Data Models](#data-models)
5. [API / CLI Design](#api--cli-design)
6. [Configuration Parameters](#configuration-parameters)
7. [New Dependencies](#new-dependencies)
8. [Implementation Details](#implementation-details)
9. [Observability](#observability)
10. [Scaling Considerations](#scaling-considerations)
11. [File Changes](#file-changes)
12. [Testing Strategy](#testing-strategy)
13. [Alternatives Considered](#alternatives-considered)
14. [Rollout Plan](#rollout-plan)

## Overview

### Problem Statement
The top-left UI title is the hardcoded string `AI Gateway & Registry`, baked into several frontend files. This is wrong for registry-only deployments (`DEPLOYMENT_MODE=registry-only` has no gateway; the title should read `AI Registry`), and enterprises that want their own product name must fork the frontend.

### Goals
- Add an optional `UI_TITLE` configuration parameter (settings field + env var).
- When set (non-empty), the UI shows that exact string everywhere the brand title appears.
- When unset, derive the title from `DEPLOYMENT_MODE`: `AI Gateway & Registry` for `with-gateway`, `AI Registry` for `registry-only`.
- Serve the effective title from the existing `GET /api/config` endpoint so the frontend reads it at runtime, no rebuild needed.
- Surface it in the System Config admin panel (`GET /api/config/full`, deployment group).
- Plumb it through all three deployment surfaces: Docker/Compose, Terraform/ECS, Helm.

### Non-Goals
- i18n of the title
- Per-user customization
- Favicon / logo changes
- The pre-first-render browser tab title in the static `index.html` (explicitly out of scope per the task)
- Changes to `REGISTRY_NAME` (federation registry-card name, a separate concept)

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/core/config.py` | Pydantic BaseSettings model, `DeploymentMode`/`RegistryMode` enums (lines 38-52), `deployment_mode` field at ~line 490, `nginx_updates_enabled` property pattern at ~line 546 | Add `ui_title` field next to the deployment-mode block and an `effective_ui_title` property beside `nginx_updates_enabled` |
| `registry/api/config_routes.py` | `/api/config` public endpoint (line 620), `CONFIG_GROUPS` (line 35, deployment group fields at 40-46), `_get_field_value` (line 399) unwraps enums | Add `ui_title` to the endpoint payload and a `("ui_title", "UI Title", False)` tuple to the deployment group |
| `frontend/src/hooks/useRegistryConfig.ts` | React hook fetching `/api/config` with a module-level cache and `DEFAULT_CONFIG` fallback | Extend `RegistryConfig` interface + default with `ui_title` |
| `frontend/src/components/Layout.tsx` | App shell; hardcoded `AI Gateway & Registry` title at lines 92-97 | Replace literal with config value + fallback |
| `frontend/src/pages/Login.tsx` | Login page; `Sign in to AI Gateway & Registry` at line 76 | Replace literal with config value + fallback |
| `frontend/src/pages/Logout.tsx` | Logout page; `AI Gateway & Registry - Secure Access Management` at line 55 | Replace brand portion with config value + fallback |
| `frontend/src/components/UptimeDisplay.tsx` | Header uptime tooltip; `AI Gateway and Registry` heading at line 134 | Replace literal with config value + fallback |
| `.env.example` | Compose env sample; `DEPLOYMENT_MODE` docs at lines 48-58 | Add a `UI_TITLE` doc block after `REGISTRY_MODE` |
| `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml` | Compose files passing `DEPLOYMENT_MODE=${DEPLOYMENT_MODE:-with-gateway}` to the registry service | Add `- UI_TITLE=${UI_TITLE:-}` pass-through |
| `terraform/aws-ecs/variables.tf` (root) | Root vars; `deployment_mode` var at line 956 with validation block | Add `ui_title` variable (string, default `""`) |
| `terraform/aws-ecs/main.tf` | Module wiring; `deployment_mode = var.deployment_mode` at line 235 | Pass `ui_title = var.ui_title` |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | Module vars; `deployment_mode` at line 970 | Add `ui_title` variable |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ECS task definition env blocks; `DEPLOYMENT_MODE` at line 903 | Add conditional `UI_TITLE` env entry |
| `terraform/aws-ecs/terraform.tfvars.example` | tfvars sample; deployment-mode docs at lines 683-693 | Add `ui_title` example |
| `charts/registry/values.yaml` | Registry chart values; `app.deploymentMode` at line 104 | Add `app.uiTitle: ""` |
| `charts/registry/templates/deployment.yaml` | Chart deployment; env block at lines 80-91 | Add conditional `UI_TITLE` env entry |
| `charts/registry/templates/_helpers.tpl` | `reservedEnvNames` list (line 22+) guarding against extraEnv collisions | Add `UI_TITLE` to the reserved list |
| `charts/registry/tests/extra_env_test.yaml` | helm-unittest suite asserting env order and reserved-name failures | Update env index expectations; add UI_TITLE render tests |
| `charts/mcp-gateway-registry-stack/values.yaml` | Stack umbrella values; `registry.app.deploymentMode` at line 213 | Add `uiTitle: ""` |

### Existing Patterns Identified
1. **Optional settings field + env var (pydantic-settings BaseSettings)**: fields declared on `Settings` with `Field(default=..., description=...)`; env vars are case-insensitive (`MCP_TELEMETRY_DEBUG` -> `telemetry_debug`).
   - Files: `registry/core/config.py`
   - How a future implementer should follow this: declare `ui_title: str | None` with a `Field` description; no validator needed.
2. **Mode-derived property on Settings**: `nginx_updates_enabled` is a `@property` computing from `deployment_mode` (config.py:543-546).
   - Files: `registry/core/config.py`
   - How: add `effective_ui_title` as a `@property` in the same style.
3. **Public config endpoint returning a flat dict**: `get_config()` at `config_routes.py:615-648` returns `deployment_mode`, `registry_mode`, feature flags. There is a 60s TTL cache but it only wraps `/api/config/full`; the public endpoint builds fresh each call.
   - Files: `registry/api/config_routes.py`
   - How: add one key to the returned dict; consume from the existing frontend hook.
4. **Admin config groups**: `CONFIG_GROUPS["deployment"]["fields"]` tuples of `(settings_attr, display_label, is_sensitive)`; `_get_field_value` unwraps enum `.value`; `_is_sensitive_field` masks by name patterns (title is not sensitive).
   - Files: `registry/api/config_routes.py:35-48, 333-445`
   - How: append `("ui_title", "UI Title", False)`.
5. **Compose pass-through with empty default**: e.g. `- GATEWAY_ADDITIONAL_SERVER_NAMES=${GATEWAY_ADDITIONAL_SERVER_NAMES:-}` passes optional vars.
   - Files: `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml`
   - How: add `- UI_TITLE=${UI_TITLE:-}`.
6. **Terraform optional string var**: ECS env entries are `{name, value}` blocks in a plain list literal; optional entries are handled with list `concat` conditionals.
   - Files: `terraform/aws-ecs/{variables.tf,main.tf}`, `terraform/aws-ecs/modules/mcp-gateway/{variables.tf,ecs-services.tf}`
   - How: root var -> module input -> conditional env entry (only emit when non-empty, preserving no-change deployments).
7. **Helm chart-managed env list**: `charts/registry/templates/deployment.yaml` renders chart-managed env entries; optional values render conditionally (`{{- if .Values.awsRegistry.federationEnabled }}` pattern at line 92); reserved names in `_helpers.tpl` reject `extraEnv` collisions.
   - Files: `charts/registry/templates/{deployment.yaml,_helpers.tpl}`, `charts/registry/values.yaml`, `charts/mcp-gateway-registry-stack/values.yaml`
   - How: add `uiTitle` value, conditional env entry, reserved name, stack default.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `Settings` (registry/core/config.py) | Extends | New `ui_title` field + `effective_ui_title` property |
| `GET /api/config` (registry/api/config_routes.py) | Extends | New `ui_title` key in payload |
| `GET /api/config/full` (System Config panel) | Extends | New field tuple in deployment group |
| `useRegistryConfig` hook (frontend) | Uses | New `ui_title` in `RegistryConfig`; consumers fall back to current literals |
| Mode filter (`registry/middleware/mode_filter.py`) | Unchanged | `/api/config` is already allow-listed in all modes (line 28), so registry-only pods serve it |

### Constraints and Limitations Discovered
- **Pre-first-render tab title cannot change without rebuild**: `frontend/public/index.html` and the built `registry/static/index.html` contain static `<title>`; the task explicitly puts this out of scope.
- **Unauthenticated surface**: `/api/config` is public (mode filter allow-list). The title is non-sensitive branding, acceptable by design; reviewers flagged and we keep the payload addition minimal (title only).
- **Frontend fallback must not flash wrong default**: default config says `with-gateway`; while `/api/config` loads, a registry-only pod would briefly show the gateway title. The pre-existing hook behaves the same for `deployment_mode`; accepted for consistency (UX reviewer note).
- **Helm env index tests**: `charts/registry/tests/extra_env_test.yaml` asserts exact env indices (`env[6]` = KEYCLOAK_ADMIN_PASSWORD when keycloak). A conditional entry placed after `SHOW_AGENTS_TAB` renders nothing when unset (indices unchanged); when set, indices shift, so the test file gains a UI_TITLE variant with its own index asserts.
- **Empty vs unset**: compose `${UI_TITLE:-}` yields empty string, not unset; Settings must treat `""` same as `None`.

## Architecture

### System Context Diagram

```
+----------------+     UI_TITLE env var      +---------------------------+
| Deployment     | ------------------------> | registry (FastAPI)        |
| Surfaces       |   (compose / ECS task     | Settings.ui_title         |
| - Docker       |     def / Helm values)    |   .effective_ui_title     |
| - Terraform/   |                           |            |              |
|   ECS          |                           |            v              |
| - Helm/K8s     |                           | GET /api/config           |
+----------------+                           | GET /api/config/full      |
                                              +------------+--------------+
                                                           |
                                                           v
                                              +---------------------------+
                                              | React frontend (runtime)  |
                                              | useRegistryConfig()       |
                                              | Layout / Login / Logout / |
                                              | UptimeDisplay             |
                                              +---------------------------+
```

### Sequence Diagram

```
Operator            Deployment surface        Registry (FastAPI)         Browser
   |                       |                        |                      |
   | set UI_TITLE=Acme     |                        |                      |
   |---------------------->|                        |                      |
   |                       | inject env UI_TITLE    |                      |
   |                       |----------------------->|                      |
   |                       |                        | Settings.ui_title    |
   |                       |                        | = "Acme"             |
   |                       |                        |                      |
   |                       |                        |<--- GET /api/config -|
   |                       |                        | { ..., "ui_title":   |
   |                       |                        |  "Acme" }            |
   |                       |                        |--------------------->|
   |                       |                        |                      | render title
```

Unset case: `UI_TITLE` absent/empty -> `effective_ui_title` derives from `deployment_mode` (`registry-only` -> `AI Registry`, else `AI Gateway & Registry`).

### Component Diagram

```
registry/core/config.py
  Settings
    ui_title: str | None = None          # new, optional
    effective_ui_title -> str            # new, mode-aware @property
        ^
        | reads
registry/api/config_routes.py
  GET /api/config      -> ui_title (effective)
  CONFIG_GROUPS.deployment -> ("ui_title", "UI Title", False) -> /api/config/full
        ^
        | HTTP JSON
frontend/src/hooks/useRegistryConfig.ts
  RegistryConfig.ui_title: string
        ^
        | hook
Layout.tsx / Login.tsx / Logout.tsx / UptimeDisplay.tsx
  title ?? 'AI Gateway & Registry'      # literal fallbacks preserved
```

## Data Models

### New Models
None. One field is added to the existing `Settings` model.

### Model Changes

```python
# registry/core/config.py (inside class Settings, after the deployment-mode block)

ui_title: str | None = Field(
    default=None,
    description=(
        "Custom UI title. When set, the UI shows this exact string. "
        "When unset, the title is derived from DEPLOYMENT_MODE: "
        "'AI Gateway & Registry' for with-gateway, 'AI Registry' for "
        "registry-only. Set via UI_TITLE."
    ),
)

@property
def effective_ui_title(self) -> str:
    """UI title shown in the frontend: UI_TITLE when set, else mode-derived."""
    if self.ui_title and self.ui_title.strip():
        return self.ui_title
    if self.deployment_mode == DeploymentMode.REGISTRY_ONLY:
        return "AI Registry"
    return "AI Gateway & Registry"
```

Note on the env name: `Settings.model_config` sets no `env_prefix`, so the env var is exactly `UI_TITLE` (case-insensitive matching). The description states `Set via UI_TITLE` to avoid implying a prefix.

## API / CLI Design

### Modified Endpoints

**`GET /api/config`** (public, existing)

**Description:** Returns registry runtime config; now includes the effective UI title.

**Request:**
```bash
curl -s http://localhost/api/config | jq .ui_title
```

**Expected Response** (new key added; all existing keys unchanged):
```json
{
  "deployment_mode": "registry-only",
  "registry_mode": "full",
  "nginx_updates_enabled": false,
  "registration_gate_enabled": false,
  "asset_lifecycle_statuses": ["draft", "active"],
  "ui_title": "AI Registry",
  "features": { "mcp_servers": true }
}
```

**Error Cases:** none new; endpoint already allow-listed by the mode filter in all modes.

**`GET /api/config/full`** (admin, existing): the `deployment` group gains two field entries (review must-fix resolution):
- `{"key": "ui_title", "label": "UI Title", ...}` - configured value; `(not set)` when deriving.
- `{"key": "effective_ui_title", "label": "UI Title (Effective)", ...}` - always populated with the effective title, derived default included. `effective_ui_title` is a `@property` on `Settings`, which `_get_field_value` reads as a plain string (no enum unwrap needed), exactly like the existing derived `nginx_updates_enabled` entry in the same group.

No new endpoints; no CLI change.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `UI_TITLE` | string | unset (empty) | No | Custom UI title. Unset: `AI Gateway & Registry` (with-gateway) or `AI Registry` (registry-only) |

### Settings / Config Class Updates
See [Data Models](#data-models). `Settings.ui_title` + `Settings.effective_ui_title`.

### Deployment Surface Checklist

| Surface | File | Change |
|---------|------|--------|
| Compose env sample | `.env.example` | Document `UI_TITLE` (commented default) after `REGISTRY_MODE` block |
| Compose (build) | `docker-compose.yml` | `- UI_TITLE=${UI_TITLE:-}` in registry environment |
| Compose (prebuilt) | `docker-compose.prebuilt.yml` | same |
| Compose (podman) | `docker-compose.podman.yml` | same |
| Terraform root var | `terraform/aws-ecs/variables.tf` | `variable "ui_title"` (string, default `""`) |
| Terraform root wiring | `terraform/aws-ecs/main.tf` | `ui_title = var.ui_title` in module block |
| Terraform module var | `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | `variable "ui_title"` |
| ECS task definition | `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | conditional `UI_TITLE` env entry |
| tfvars example | `terraform/aws-ecs/terraform.tfvars.example` | documented example |
| Helm subchart values | `charts/registry/values.yaml` | `app.uiTitle: ""` |
| Helm subchart template | `charts/registry/templates/deployment.yaml` | conditional `UI_TITLE` env |
| Helm reserved names | `charts/registry/templates/_helpers.tpl` | add `UI_TITLE` to reserved env list |
| Helm stack values | `charts/mcp-gateway-registry-stack/values.yaml` | `registry.app.uiTitle: ""` |
| Helm tests | `charts/registry/tests/extra_env_test.yaml` | keep green; add UI_TITLE cases |

`docker-compose.dhi.yml` does not define registry service env (verified: no DEPLOYMENT_MODE there), so it is untouched. `docker/Dockerfile.registry` needs no change (no env baking).

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Settings field + derived property
**File:** `registry/core/config.py`
**Lines:** after the tab-visibility block (~line 504); property beside `nginx_updates_enabled` (~line 543)

```python
    # UI branding
    ui_title: str | None = Field(
        default=None,
        description=(
            "Custom UI title. When set, the UI shows this exact string. "
            "When unset, the title is derived from DEPLOYMENT_MODE: "
            "'AI Gateway & Registry' for with-gateway, 'AI Registry' for "
            "registry-only. Set via UI_TITLE."
        ),
    )

    @property
    def effective_ui_title(self) -> str:
        """UI title: UI_TITLE when set (non-blank), else derived from DEPLOYMENT_MODE."""
        if self.ui_title and self.ui_title.strip():
            return self.ui_title
        if self.deployment_mode == DeploymentMode.REGISTRY_ONLY:
            return "AI Registry"
    return "AI Gateway & Registry"
```

#### Step 2: Serve from /api/config and the admin panel
**File:** `registry/api/config_routes.py`
**Lines:** 40-47 (deployment group), 620-648 (get_config)

- Add two tuples to `CONFIG_GROUPS["deployment"]["fields"]` (after `registry_mode`) - review must-fix from Backend/SMTS:
  - `("ui_title", "UI Title", False)` - the configured value; displays `(not set)` when deriving.
  - `("effective_ui_title", "UI Title (Effective)", False)` - the `@property`; `_get_field_value` reads it as a plain string, so the panel also shows the mode-derived default.
- In `get_config()` return dict, add `"ui_title": settings.effective_ui_title,` (placed after `nginx_updates_enabled`).

#### Step 3: Frontend hook
**File:** `frontend/src/hooks/useRegistryConfig.ts`

```typescript
interface RegistryConfig {
  deployment_mode: 'with-gateway' | 'registry-only';
  registry_mode: 'full' | 'skills-only' | 'mcp-servers-only' | 'agents-only';
  nginx_updates_enabled: boolean;
  ui_title: string;                    // new
  features: { ... };                   // unchanged
}

const DEFAULT_CONFIG: RegistryConfig = {
  ...
  ui_title: 'AI Gateway & Registry',   // matches legacy default
  ...
};
```

#### Step 4: Frontend consumers
**Files:** `Layout.tsx` (~92-97), `Login.tsx` (~76), `Logout.tsx` (~55), `UptimeDisplay.tsx` (~134)

Pattern (defensive; no behavior change when the key is missing, e.g. an older API):

```tsx
const { config } = useRegistryConfig();
const uiTitle = config?.ui_title ?? 'AI Gateway & Registry';
...
<span className="ml-2 text-xl font-bold text-gray-900 dark:text-white">
  {uiTitle}
</span>
```

- `Layout.tsx`: `const { config } = useRegistryConfig();` at component top; replace the `<span>` literal with `{config?.ui_title ?? 'AI Gateway & Registry'}`; keep the logo `alt` text as-is (alt text is not the visible title).
- `Login.tsx`: `Sign in to {config?.ui_title ?? 'AI Gateway & Registry'}`.
- `Logout.tsx`: `{config?.ui_title ?? 'AI Gateway & Registry'} - Secure Access Management`.
- `UptimeDisplay.tsx`: tooltip heading `{config?.ui_title ?? 'AI Gateway & Registry'}` (the legacy literal there reads "AI Gateway and Registry"; the fallback uses the canonical `&` form).

#### Step 5: Compose plumbing
**Files:** `.env.example`, `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml`

`.env.example` (after the `REGISTRY_MODE` block):

```
# UI_TITLE overrides the title shown in the web UI header and auth pages.
# When unset, the title is derived from DEPLOYMENT_MODE:
#   - with-gateway (default): "AI Gateway & Registry"
#   - registry-only: "AI Registry"
# Set to your own product name to rebrand, e.g. UI_TITLE="Acme AI Platform"
# UI_TITLE=
```

Compose files (registry service environment, after `SHOW_AGENTS_TAB`):

```yaml
      - UI_TITLE=${UI_TITLE:-}
```

#### Step 6: Terraform/ECS plumbing
**Files:** `terraform/aws-ecs/variables.tf`, `terraform/aws-ecs/main.tf`, `terraform/aws-ecs/modules/mcp-gateway/variables.tf`, `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf`, `terraform/aws-ecs/terraform.tfvars.example`

Root variable (mirrors the `deployment_mode` doc style; no enum validation since free text):

```hcl
variable "ui_title" {
  description = <<-EOT
    Custom UI title shown in the registry web UI. When empty (default),
    the title is derived from deployment_mode: "AI Gateway & Registry"
    for with-gateway, "AI Registry" for registry-only.
  EOT
  type        = string
  default     = ""
}
```

Module variable: same shape, shorter description. `main.tf` module block: `ui_title = var.ui_title` next to `deployment_mode = var.deployment_mode`.

Task definition env: the registry container env is a plain list literal (verified `ecs-services.tf:880-930`). Keep every existing index unchanged by appending the conditional entry via list `concat` at the end of the list:

```hcl
      env = concat(
        [
          # ...existing static entries unchanged...
        ],
        var.ui_title != "" ? [
          {
            name  = "UI_TITLE"
            value = var.ui_title
          }
        ] : []
      )
```

Minimal-edit alternative implemented in this patch: keep the literal list and append the conditional element directly after the last static entry using the same ternary-in-list idiom already present in this file for optional entries; either formulation preserves unset-deployment task definitions byte-for-byte.

`terraform.tfvars.example` (after the deployment-mode example):

```hcl
# UI_TITLE overrides the title shown in the registry web UI. When empty,
# the title is derived from deployment_mode ("AI Gateway & Registry" for
# with-gateway, "AI Registry" for registry-only).
# ui_title = "Acme AI Platform"
```

#### Step 7: Helm plumbing
**Files:** `charts/registry/values.yaml`, `charts/registry/templates/deployment.yaml`, `charts/registry/templates/_helpers.tpl`, `charts/registry/tests/extra_env_test.yaml`, `charts/mcp-gateway-registry-stack/values.yaml`

- `charts/registry/values.yaml`, after `deploymentMode`:

```yaml
  # Custom UI title. When empty, derived from deploymentMode:
  # "AI Gateway & Registry" (with-gateway) or "AI Registry" (registry-only)
  uiTitle: ""
```

- `charts/registry/templates/deployment.yaml`, after the `SHOW_AGENTS_TAB` entry:

```yaml
            {{- with .Values.app.uiTitle }}
            - name: UI_TITLE
              value: {{ . | quote }}
            {{- end }}
```

Because the entry is conditional, unset deployments render exactly as before (index-sensitive tests unaffected); set deployments shift `KEYCLOAK_ADMIN_PASSWORD` from `env[6]` to `env[7]` under the keycloak test preset. Review must-fix: the test updates land in the same patch, with three cases added to `charts/registry/tests/extra_env_test.yaml`:
1. default render asserts `UI_TITLE` is NOT present in the env list;
2. a variant setting `app.uiTitle: "Acme"` asserts `env[6].name == UI_TITLE`, `env[6].value == "Acme"`, `env[7].name == KEYCLOAK_ADMIN_PASSWORD`;
3. a variant putting `UI_TITLE` in `extraEnv` asserts a failed template matching the reserved-variable error pattern.

- `_helpers.tpl` reserved list: add `- UI_TITLE` after `- SHOW_AGENTS_TAB` so users cannot shadow it via `extraEnv` (consistent with the other chart-managed names; `uiTitle` is the supported path).

- `charts/mcp-gateway-registry-stack/values.yaml`, under `registry.app`, after `deploymentMode`:

```yaml
    # Custom UI title. When empty, derived from deploymentMode
    uiTitle: ""
```

#### Step 8: Backend tests (see testing.md for full plan)
- `tests/unit/core/test_config.py`: add tests for `effective_ui_title` (set / unset + both modes / blank-string).
- `tests/unit/api/test_config_routes_title.py` (new): `/api/config` includes `ui_title`; `/api/config/full` deployment group includes it unmasked. Fixture pattern follows `tests/integration/test_deployment_mode_integration.py`.

### Error Handling
- No new error paths. `ui_title` is free text; blank/whitespace-only values normalize to the derived default (property-level guard).
- Terraform validation is intentionally absent (free text); Helm renders the entry only when non-empty.

### Logging
- No logging change. A startup banner line was considered and rejected as noise; the effective title is visible via `/api/config` and the System Config panel.

## Observability
### Tracing / Metrics / Logging Points
- No new metrics. `/api/config` responses are already unauthenticated; title is non-sensitive.
- The System Config panel (`/api/config/full`) shows the effective value for support diagnostics.

## Scaling Considerations
- Title is read from Settings (process env) on each `/api/config` call; no I/O, no cache invalidation concern. The 60s `/api/config/full` cache applies but is irrelevant to correctness (title changes require a pod restart, like all env config).

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `tests/unit/api/test_config_routes_title.py` | Unit tests for ui_title in /api/config and /api/config/full |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~490-546 | Add `ui_title` field and `effective_ui_title` property |
| `registry/api/config_routes.py` | ~47, ~626 | Add deployment-group field tuples (`ui_title` + `effective_ui_title`); add `ui_title` key to `get_config()` |
| `frontend/src/hooks/useRegistryConfig.ts` | ~5-30 | Add `ui_title` to interface and default config |
| `frontend/src/components/Layout.tsx` | ~19, ~96 | Use hook; render config title with fallback |
| `frontend/src/pages/Login.tsx` | ~2, ~14, ~76 | Use hook; render config title with fallback |
| `frontend/src/pages/Logout.tsx` | ~9, ~55 | Use hook; render config title with fallback |
| `frontend/src/components/UptimeDisplay.tsx` | ~134 | Render config title with fallback (hook already imported there? verify: yes, `useRegistryConfig` imported for indicator components) |
| `.env.example` | ~70 | Document `UI_TITLE` |
| `docker-compose.yml` | ~85 | Pass through `UI_TITLE` |
| `docker-compose.prebuilt.yml` | ~24 | Pass through `UI_TITLE` |
| `docker-compose.podman.yml` | ~19 | Pass through `UI_TITLE` |
| `terraform/aws-ecs/variables.tf` | ~975 | New `ui_title` variable |
| `terraform/aws-ecs/main.tf` | ~236 | Pass `ui_title` to module |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | ~981 | New `ui_title` variable |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ~915 | Conditional `UI_TITLE` env entry |
| `terraform/aws-ecs/terraform.tfvars.example` | ~695 | Document `ui_title` |
| `charts/registry/values.yaml` | ~106 | `app.uiTitle: ""` |
| `charts/registry/templates/deployment.yaml` | ~91 | Conditional `UI_TITLE` env |
| `charts/registry/templates/_helpers.tpl` | ~28 | Reserve `UI_TITLE` |
| `charts/registry/tests/extra_env_test.yaml` | tests | UI_TITLE render + reserved-name cases |
| `charts/mcp-gateway-registry-stack/values.yaml` | ~215 | `registry.app.uiTitle: ""` |
| `tests/unit/core/test_config.py` | new tests | `effective_ui_title` unit tests |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (backend) | ~30 |
| New code (frontend) | ~15 |
| Plumbing/config (compose, tf, helm, env samples) | ~80 |
| New tests | ~120 |
| **Total** | **~245** |

## Testing Strategy
Full executable plan in [testing.md](./testing.md). Summary: unit tests for the property and both endpoints; frontend jest coverage where the harness runs it; deployment-surface checks are grep/template-render assertions (helm unittest, terraform validate).

## Alternatives Considered

### Alternative 1: Build-time env baked into the React bundle (REACT_APP_UI_TITLE)
**Description:** CRA-style build env var inlined at `npm run build`.
**Pros / Cons:** Simple; but requires a frontend rebuild per brand change and diverges from the runtime-config pattern the app already uses for deployment_mode.
**Why Rejected:** Task explicitly requires runtime configuration via `/api/config`; no rebuild.

### Alternative 2: Derive the title from REGISTRY_NAME
**Description:** Reuse the existing federation registry-card name as the UI title.
**Pros / Cons:** No new parameter; but `REGISTRY_NAME` has unrelated semantics (federation listings), defaults to a random Docker-style name when unset, and lacks the mode-aware default requirement.
**Why Rejected:** Conflates two concepts; breaks the explicit mode-derived default requirement.

### Alternative 3: Hardcode "AI Registry" for registry-only without a parameter
**Description:** Only fix the mode mismatch, no branding knob.
**Pros / Cons:** Smallest diff; but fails the enterprise-rebranding user story (core task requirement).
**Why Rejected:** Does not meet acceptance criteria.

### Comparison Matrix

| Criteria | Chosen (UI_TITLE + /api/config) | Alt 1 (build env) | Alt 2 (REGISTRY_NAME) | Alt 3 (mode-only) |
|----------|--------------------------------|-------------------|------------------------|-------------------|
| Runtime, no rebuild | Yes | No | Yes | Yes |
| Enterprise rebranding | Yes | Yes | Partial | No |
| Mode-aware default | Yes | No | No | Yes |
| Conceptual cleanliness | High | High | Low | High |

## Rollout Plan
- Phase 1: Implementation (this patch)
- Phase 2: Testing (testing.md; unit + integration + helm unittest)
- Phase 3: Deployment: purely additive env var; default behavior unchanged. Document in release notes; operators opt in by setting `UI_TITLE`.

## Open Questions
- None blocking. Prose docs under `docs/` (`docs/configuration.md`, `docs/unified-parameter-reference.md`) also enumerate parameters; a UI_TITLE row there is nice-to-have and may be included if trivially targeted.

## References
- Task reference issue: agentic-community/mcp-gateway-registry#984
- Existing mode plumbing: `registry/middleware/mode_filter.py` (public `/api/config` allow-list)
- Frontend runtime-config pattern: `frontend/src/hooks/useRegistryConfig.ts`
