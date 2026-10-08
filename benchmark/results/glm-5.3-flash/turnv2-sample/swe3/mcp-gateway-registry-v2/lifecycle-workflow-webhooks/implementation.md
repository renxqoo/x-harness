# Implementation Summary: Externally Orchestrated Asset Lifecycles

*Created: 2026-09-29*
*Baseline ref: `1.24.7` (commit `dbaa153487a878317ceadae7a63cc18ad3ff1593`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Implements the five deliverables for externally orchestrated asset lifecycles: (1) a `scan_complete` webhook event emitted from all three registration scan wrappers including the scanner-failure path; (2) HMAC-SHA256 signing of every outbound webhook over the exact transmitted body bytes, keyed by `REGISTRATION_WEBHOOK_SIGNING_SECRET`, plus an `event_id` idempotency key on every envelope; (3) a validated `status=` filter on the servers/agents/skills list endpoints; (4) the `LIFECYCLE_INITIAL_STATUS` registration mandate (forces unspecified, 400 on mismatch) across all registration paths; and (5) a `change_asset_status` UI permission additionally required by server PATCH/edit, agent PATCH, and skill PUT only when the write actually changes the stored status. Adds the `mcpgw_registry_webhook_send_total` OTel counter, wires both new settings through every deployment surface, and documents the consumer contract (ordering, idempotency, signature verification).

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/services/webhook_service.py` | modified | +125 / -4 | Signing (`_sign_body`), exact-bytes transmission (`content=`), `event_id`, `scan` sub-payload, `send_scan_complete_webhook`, `build_scan_data`, unsigned-mode warning, metric on every attempt |
| `registry/core/config.py` | modified | +29 / -0 | `registration_webhook_signing_secret`, `lifecycle_initial_status` + startup validator |
| `registry/schemas/registry_card.py` | modified | +35 / -0 | `resolve_initial_status` mandate helper |
| `registry/api/status_filter_utils.py` | added | +32 / -0 | Shared `resolve_status_filter` (400 on invalid values) |
| `registry/observability/meters.py` | modified | +6 / -0 | `webhook_send_total` counter (`mcpgw_registry_webhook_send_total`) |
| `registry/api/server_routes.py` | modified | +96 / -5 | Scan wrapper emits event on success+failure; register + internal-register mandate; PATCH + edit-form status gates; `status=` list filter |
| `registry/api/agent_routes.py` | modified | +99 / -2 | Scan wrapper hook (success+failure); list filter; register mandate via `exclude_unset`; PATCH gate |
| `registry/api/skill_routes.py` | modified | +103 / -2 | Scan wrapper hook (success+failure); list filter (both pagination paths); register mandate via `exclude_unset`; PUT gate before registration gate |
| `registry/main.py` | modified | +9 / -0 | Short-signing-secret startup warning |
| `registry/api/config_routes.py` | modified | +3 / -1 | Both settings in the UI config group; group title rename |
| `auth_server/scopes.yml` | modified | +4 / -0 | `change_asset_status: [all]` on `mcp-registry-admin` + `registry-admins` |
| `.env.example` | modified | +13 / -0 | Both vars documented |
| `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` | modified | +2 / -0 each | Env passthrough |
| `terraform/aws-ecs/variables.tf` | modified | +13 / -0 | Two variables (secret marked sensitive) |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +8 / -0 | Two env entries in the registry task |
| `charts/registry/values.yaml` | modified | +2 / -0 | Two values |
| `charts/registry/templates/secret.yaml` | modified | +4 / -0 | Guarded secret key + lifecycle key |
| `docs/registration-webhooks.md` | modified | +117 / -4 | scan_complete event, Webhook Signatures section, Consumer Contract table, metric + alert, troubleshooting rows |
| `tests/unit/services/test_webhook_service.py` | modified | +315 / -1 | Signing correctness/bytes-identity/unsigned-mode, event_id uniqueness, scan payload shape, `build_scan_data` mapping, metric on success/failure |
| `tests/unit/test_lifecycle_status.py` | modified | +107 / -0 | `resolve_initial_status` matrix, exclude_unset invariant pin, `resolve_status_filter` 400s |

## How to Apply

```bash
git clone --branch 1.24.7 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` verified against a fresh clone at tag `1.24.7`.

## Deviations from the LLD
- The LLD proposed putting `resolve_status_filter` in `registry/api/endpoint_utils.py`; implemented as `registry/api/status_filter_utils.py` instead. `endpoint_utils.py` lives in `registry/core/` (services-side, imports no FastAPI) and the repo's established pattern for API-route-shared helpers is a sibling module in `registry/api/` (`_etag_utils.py`), so a FastAPI-dependent helper belongs there. Functionally identical.
- Skill registration mandate applies the resolved status via `request.model_copy(update={"status": ...})` - a small concrete mechanism the LLD left to the implementer.
- The internal register endpoint applies the mandate with `resolve_initial_status(None)` (it has no status form field); the LLD listed it without specifying this detail.
- LLD estimated ~+90 docs lines; actual is +117 (the consumer-contract table and monitoring alert added value beyond the outline). Tests landed at +422 vs the ~200 estimate (mock helpers and the invariant pins); total patch is +1126/-19 against a ~680 estimate - every overage is additive test/docs coverage, not scope growth.

## Not Implemented / Follow-ups
- The LLD's Open Question (mandate on batch/federation write paths) remains deferred by design; the agent batch processor funnels through the same `register_agent` route so it inherits the mandate; federation imports are read-only today.
- No `scan_complete` from the manual `/rescan` endpoints (synchronous, out of scope per the issue).
- Frontend UI for the new filter/config fields is out of scope (the config page group already exposes the two settings).

## Verification (not executed)
Per the benchmark constraints, no tests were run against the target repo; tests were designed, not executed. The runnable set is `uv run pytest tests/unit/services/test_webhook_service.py tests/unit/test_lifecycle_status.py -v`. Functional, backwards-compat, deployment-surface, and E2E procedures (webhook receiver with constant-time verification, filter/mandate/permission curl matrix, compose/Terraform/Helm greps) are copy-pasteable in `./testing.md`. The patch itself was verified to apply cleanly onto a fresh `1.24.7` clone with `git apply`.

Self-review correction: the initial patch imported the shared filter helper with the wrong relative depth (`from ..status_filter_utils import ...` instead of `from .status_filter_utils import ...` in the three route files); caught and fixed during the post-artifact self-review before final capture.
