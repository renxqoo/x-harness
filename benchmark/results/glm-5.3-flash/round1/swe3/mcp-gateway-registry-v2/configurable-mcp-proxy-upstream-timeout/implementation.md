# Implementation Summary: Configurable /mcp-proxy upstream timeout (MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS)

*Created: 2026-09-30*
*Baseline ref: `1.25.0` (commit `765f35c729f9d03af5f974874f59563ac7a9f682`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md` (revised per review)*

## What Changed
The auth-server `/mcp-proxy` hop's upstream timeout is no longer hardcoded to 30 seconds. A new reader helper resolves the timeout from the `mcp_proxy_upstream_timeout_seconds` settings field (pydantic, `ge=1.0`), falling back to the `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` environment variable, then to the historical 30s default; sub-1 values clamp to 1 and non-finite/junk values fall back to the default with a warning. The knob is exposed on every surface the existing `MCP_PROXY_MAX_BODY_BYTES` knob uses (admin config, `.env.example`, three compose files, auth-server Helm chart, Terraform root/module/task-def/tfvars, unified parameter docs), and unit tests pin the default, override, floor, junk, non-finite, and settings-cascade behaviour through the wired handler.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `auth_server/server.py` | modified | +46 / -1 | `import math`; new `_read_mcp_proxy_upstream_timeout_seconds()` (settings -> env -> 30.0, 1s floor, non-finite rejected); handler reads it per request and passes it to `httpx.AsyncClient(timeout=...)` |
| `registry/core/config.py` | modified | +9 / -0 | `mcp_proxy_upstream_timeout_seconds: float = Field(default=30.0, ge=1.0)` after the body-bytes field |
| `registry/api/config_routes.py` | modified | +1 / -0 | Admin config `auth` section entry |
| `.env.example` | modified | +6 / -0 | Documented knob, default 30 |
| `docker-compose.yml` | modified | +1 / -0 | env passthrough, default 30 |
| `docker-compose.prebuilt.yml` | modified | +1 / -0 | env passthrough |
| `docker-compose.podman.yml` | modified | +1 / -0 | env passthrough |
| `charts/auth-server/values.yaml` | modified | +1 / -0 | `mcpProxyUpstreamTimeoutSeconds: "30"` |
| `charts/auth-server/templates/secret.yaml` | modified | +1 / -0 | renders `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` (`toString \| b64enc`) |
| `charts/auth-server/reserved-env-names.txt` | modified | +1 / -0 | reserved name |
| `terraform/aws-ecs/variables.tf` | modified | +11 / -0 | root variable + `>= 1` validation |
| `terraform/aws-ecs/main.tf` | modified | +4 / -3 | module input wiring (group realigned to terraform fmt style) |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | modified | +6 / -0 | module variable (no validation, module convention) |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +4 / -0 | task-definition env entry |
| `terraform/aws-ecs/terraform.tfvars.example` | modified | +1 / -0 | commented example |
| `docs/unified-parameter-reference.md` | modified | +1 / -0 | parameter row incl. edge-proxy caveat |
| `tests/auth_server/unit/test_server.py` | modified | +166 / -1 | `_patch_httpx_async_client` now patches in a mock AsyncClient *class* (bare-`with` call sites unchanged; `as` yields the class so tests assert `call_args.kwargs["timeout"]`); new `TestMcpProxyUpstreamTimeoutConfig` with 6 tests |

Totals: 17 files, +261 / -5.

## How to Apply

```bash
git clone --branch 1.25.0 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` verified against a pristine `1.25.0` checkout (commit `765f35c`).

## Deviations from the LLD
- `_patch_httpx_async_client` extension: the LLD said "attach the mock class object so tests can read call_args"; the implementation instead patches the attribute with `new=mock_client_cls` so `with ... as mock_cls:` yields the class. Functionally equivalent, and it preserves the helper's existing bare-`with` call sites (a two-value return would have broken the six pre-existing usages).
- `terraform/aws-ecs/main.tf`: adding the new module input left the surrounding assignment group misaligned, so the four neighbouring lines were realigned to `terraform fmt` column style (+4/-3 instead of +1/-0). No semantic change.

## Not Implemented / Follow-ups
- None from the LLD. (Release notes were explicitly out of scope, per the issue.)

## Verification (not executed)
See `testing.md` for the full executable plan. Per skill constraints, the target repo's tests were designed but NOT run in this benchmark pass: no pytest, terraform validate, helm template, or docker compose was executed against the clone. The patch was verified to apply cleanly onto the baseline ref with `git apply --check`.
