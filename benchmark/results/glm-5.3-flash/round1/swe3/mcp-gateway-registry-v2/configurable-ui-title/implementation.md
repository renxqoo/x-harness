# Implementation Summary: Configurable UI Title (UI_TITLE)

*Created: 2026-09-30*
*Baseline ref: `1.23.0` (commit `0038b687d8c3b83395d13ea199134733ee707e7f`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Adds an optional `UI_TITLE` configuration parameter. When set, the web UI shows that exact string; when unset, the title is derived from `DEPLOYMENT_MODE` (`AI Gateway & Registry` for with-gateway, `AI Registry` for registry-only). The effective title is served by the existing `GET /api/config`, shown in the System Config admin panel (as both the configured value and the effective value), and rendered by the four frontend surfaces that previously hardcoded the brand. The parameter is plumbed through Docker/Compose, Terraform/ECS, and Helm; deployments that do not set it see no change (conditional infra rendering keeps unset task definitions/pod envs byte-identical).

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/core/config.py` | modified | +20 / -0 | `ui_title: str \| None` field (after tab-visibility block) and `effective_ui_title` property (beside `nginx_updates_enabled`); blank/whitespace treated as unset |
| `registry/api/config_routes.py` | modified | +3 / -0 | `ui_title` key in `GET /api/config`; `("ui_title", "UI Title", False)` and `("effective_ui_title", "UI Title (Effective)", False)` tuples in the deployment group of `CONFIG_GROUPS` |
| `frontend/src/hooks/useRegistryConfig.ts` | modified | +2 / -0 | `ui_title: string` in `RegistryConfig`; `ui_title: 'AI Gateway & Registry'` in `DEFAULT_CONFIG` |
| `frontend/src/components/Layout.tsx` | modified | +3 / -1 | Header title renders `config?.ui_title ?? 'AI Gateway & Registry'`; hook import + call |
| `frontend/src/pages/Login.tsx` | modified | +3 / -1 | "Sign in to {title}" uses config with fallback |
| `frontend/src/pages/Logout.tsx` | modified | +3 / -1 | Footer brand uses config with fallback |
| `frontend/src/components/UptimeDisplay.tsx` | modified | +3 / -1 | Tooltip heading uses config with fallback |
| `.env.example` | modified | +11 / -0 | UI_BRANDING doc block (commented `# UI_TITLE=` default) |
| `docker-compose.yml` | modified | +1 / -0 | `- UI_TITLE=${UI_TITLE:-}` pass-through |
| `docker-compose.prebuilt.yml` | modified | +1 / -0 | same |
| `docker-compose.podman.yml` | modified | +1 / -0 | same |
| `terraform/aws-ecs/variables.tf` | modified | +10 / -0 | root `ui_title` variable (string, default `""`) |
| `terraform/aws-ecs/main.tf` | modified | +1 / -0 | `ui_title = var.ui_title` into the module block |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | modified | +6 / -0 | module `ui_title` variable |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +8 / -0 | conditional `UI_TITLE` env entry appended to the registry container env concat (only when non-empty) |
| `terraform/aws-ecs/terraform.tfvars.example` | modified | +5 / -0 | documented commented example |
| `charts/registry/values.yaml` | modified | +4 / -0 | `app.uiTitle: ""` |
| `charts/registry/templates/deployment.yaml` | modified | +4 / -0 | conditional `{{- with .Values.app.uiTitle }}` env entry |
| `charts/registry/templates/_helpers.tpl` | modified | +1 / -0 | `UI_TITLE` added to `reservedEnvNames` |
| `charts/registry/tests/extra_env_test.yaml` | modified | +39 / -5 | three new cases (absent by default, rendered with index asserts when set, reserved-name rejection); index comment rewritten |
| `charts/mcp-gateway-registry-stack/values.yaml` | modified | +4 / -0 | `registry.app.uiTitle: ""` |
| `tests/unit/core/test_config.py` | modified | +75 / -0 | `TestUiTitleConfiguration`: default None, derived both modes, explicit override, blank and whitespace-only unset handling |
| `tests/unit/api/test_config_routes_title.py` | added | +136 / -0 | `/api/config` key + derivation; `/api/config/full` deployment-group entries unmasked; effective-vs-configured display |

Totals: 23 files, +344 / -9.

## How to Apply

```bash
git clone --branch 1.23.0 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` was verified against a pristine worktree at the baseline commit `0038b68` (tag `1.23.0`): the patch applies cleanly.

## Deviations from the LLD
- **`ecs-services.tf` env entry placement:** the LLD sketched wrapping the whole env list in `concat(...)`; the implementation instead appends the conditional element as an additional `concat` argument after the existing MONGODB_CONNECTION_STRING conditional (the file already used this exact idiom), leaving all pre-existing entries untouched. Functionally identical to the LLD intent; smaller diff.
- **`effective_ui_title` panel tuple:** this was the review Step 7.5 must-fix and was already incorporated into the revised LLD (two tuples instead of one); no further deviation.
- None otherwise - implemented exactly as the revised LLD specifies.

## Not Implemented / Follow-ups
- Prose docs (`docs/configuration.md`, `docs/unified-parameter-reference.md`) UI_TITLE rows: deferred; LLD lists them as nice-to-have and the docs pages are long generated tables where a partial row risks inconsistency.
- Frontend jest component tests for the four surfaces: deferred; the repo's jest suite does not currently cover Layout/Login/Logout/UptimeDisplay rendering, and the hook-level typing plus backend tests cover the contract. Noted in testing.md Section 2.3.
- Release-notes entry and logo `alt` text: out of scope (review non-blocking notes).

## Verification (not executed)
Testing steps are specified in `./testing.md`. Per skill constraints, no tests, linters, builds, or any target-repo commands were executed; verification was limited to `git` inspection (staged diff, numstat) and a `git apply --check` against a pristine baseline worktree, which passed.
