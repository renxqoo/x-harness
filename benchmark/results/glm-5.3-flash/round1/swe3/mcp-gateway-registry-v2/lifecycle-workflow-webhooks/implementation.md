# Implementation Summary: Lifecycle Workflow Webhooks

*Created: 2026-09-30*
*Baseline ref: `1.24.7` (commit `dbaa153487a878317ceadae7a63cc18ad3ff1593`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*
*Related Review: `./review.md`*

## What Changed

Implements the externally-orchestrated lifecycle support from issue #1330 across servers, agents, and skills: (1) a `scan_complete` fire-and-forget webhook emitted from all three post-registration scan helpers on both the completed and the failed path; (2) HMAC-SHA256 signing of every outbound webhook body (`X-Webhook-Signature: sha256=<hex>` over the exact transmitted bytes) when `REGISTRATION_WEBHOOK_SIGNING_SECRET` is set, plus a `mcpgw_registry_webhook_delivery_total` OTel counter; (3) a validated `status=` filter on the three list endpoints; (4) `REGISTRATION_MANDATED_INITIAL_STATUS` enforcement at registration (omitted forced, mismatch 400, misconfiguration degrades to no-mandate); and (5) a `modify_service_status` UI permission required additionally when a PUT/PATCH/updates request changes `status`, wired into the admin seed scopes. Consumer-contract documentation (ordering, idempotency, constant-time signature verification) is added to `docs/registration-webhooks.md`, and both new settings are wired through .env.example, all three compose files, Terraform (root + module + task def), and Helm (values + secret template).

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/services/webhook_service.py` | modified | +122 / -37 | Extracted shared `_post_webhook` (serialize, sign, POST, record); added `_serialize_payload`, `_sign_body`, `_record_delivery`, `send_scan_complete_webhook` |
| `registry/core/config.py` | modified | +17 / -0 | `registration_webhook_signing_secret`, `registration_mandated_initial_status` settings |
| `registry/observability/meters.py` | modified | +6 / -0 | `webhook_delivery_total` counter (`mcpgw_registry_webhook_delivery_total`) |
| `registry/api/server_routes.py` | modified | +180 / -4 | `_emit_scan_complete_webhook` + emission in server scan helper (success + exception); shared `_validate_lifecycle_status_or_400`, `_apply_mandated_initial_status`, `_require_status_change_permission`; `status=` filter on list; mandate at `register_service` and `register_service_api` (new-registrations only); status permission on PUT and PATCH |
| `registry/api/agent_routes.py` | modified | +98 / -2 | Same set for agents: scan emission (both paths), local `_emit_scan_complete_webhook`, list filter, mandate in `register_agent`, status permission on PUT and PATCH |
| `registry/api/skill_routes.py` | modified | +98 / -1 | Same set for skills: scan emission (both paths), local `_emit_scan_complete_webhook`, list filter, mandate in `register_skill`, status permission in `update_skill` |
| `registry/schemas/skill_models.py` | modified | +6 / -3 | `SkillRegistrationRequest.status` default changed `"draft"` -> `None` so omission is distinguishable (review finding 2) |
| `registry/services/skill_service.py` | modified | +2 / -1 | `register_skill` coerces `None` status to `"draft"` (backwards compatible) |
| `scripts/mcp-registry-admin.json` | modified | +1 / -0 | `modify_service_status: ["all"]` |
| `scripts/registry-admins.json` | modified | +1 / -0 | `modify_service_status: ["all"]` |
| `.env.example` | modified | +12 / -0 | Both new variables + comments |
| `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` | modified | +3 / -0 each | Env passthrough on the registry service |
| `terraform/aws-ecs/variables.tf`, `modules/mcp-gateway/variables.tf`, `main.tf`, `modules/mcp-gateway/ecs-services.tf` | modified | +39 / -0 | Terraform variables, module threading, registry container env |
| `charts/registry/values.yaml`, `templates/secret.yaml` | modified | +8 / -0 | Helm values + conditional secret entries |
| `docs/registration-webhooks.md` | modified | +108 / -0 | `scan_complete` payload, both new env vars, Consumer Contract section (ordering, idempotency, full `hmac.compare_digest` verification snippet) |
| `docs/scopes.md` | modified | +7 / -0 | `modify_service_status` permission docs |
| `tests/unit/services/test_webhook_service.py` | modified | +181 / -0 | Signing (present/absent), `scan_complete` payload shape (pass + failure path) |
| `tests/unit/api/test_server_routes_patch.py` | modified | +100 / -0 | Status permission: 403 without, 200 with, metadata edits unaffected, no-op echo does not trip the gate |
| `tests/unit/api/test_lifecycle_mandate.py` | added | +67 / -0 | Mandate helper: passthrough, forced, accepted, rejected, misconfiguration degradation |

## How to Apply

```bash
git clone --branch 1.24.7 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` verified clean against a fresh checkout of the pinned baseline commit.

## Deviations from the LLD

- **LLD said `internal_register_service` also enforces the mandate; implementation does not.** The internal endpoint (`/internal/register`, used by the mcpgw-server) takes no `status` parameter at all - there is no caller-supplied status to validate, and adding a form field would widen the endpoint's contract. The mandate simply does not bind where no status can be supplied. Recorded here rather than silently dropping the LLD step.
- **The mandate at `register_service_api` is applied only when the path is not already registered** (matching the LLD's "new registrations only" rule via an explicit `get_server_info` existence check), since that endpoint doubles as an overwrite path.
- **Agent/skill routes define local `_emit_scan_complete_webhook` copies instead of importing the server one.** The three route modules already duplicate this shape for their scan helpers (`_check_agent_permission` mirrors `_check_server_permission`); importing `server_routes` into the other modules at module load also risks import cycles because `agent_routes`/`skill_routes` already import from `.server_routes` lazily inside functions. The payload construction stays identical (same whitelist, same log shape) so consumer behavior is uniform. `_require_status_change_permission` and the two validation helpers ARE shared (defined once in `server_routes.py`, imported by agent/skill routes) per the review.
- **Skill list filter applies in the fallback path only** (post-fetch list comprehension), which is where every other skill field filter already lives; `status` correctly forces the fallback path via `has_field_filters`.

## Not Implemented / Follow-ups

- No webhook event on lifecycle transitions - explicitly out of scope (the orchestrator initiates them).
- No `scan_complete` emission from the manual `/rescan` endpoints (synchronous callers see the result) - per LLD Non-Goals.
- No key-rotation tooling beyond "change both sides" - deferred, noted in docs.
- `X-Webhook-Event-Id` (UUID) for simpler consumer dedupe was left out (Security reviewer marked it non-blocking; timestamp+type+path suffices).

## Verification (not executed)

Per the skill contract the target repo's tests were NOT run. The testing plan lives in `./testing.md`: unit tests were written for signing, `scan_complete` payload shape (both paths), the status permission (4 route-level cases), and the mandate helper (5 cases); functional/E2E/deployment checks are copy-pasteable steps a reviewer can execute. All changed Python files were syntax-validated (`ast.parse`), all modified JSON validated, and `git apply --check` passed against the pinned baseline.
