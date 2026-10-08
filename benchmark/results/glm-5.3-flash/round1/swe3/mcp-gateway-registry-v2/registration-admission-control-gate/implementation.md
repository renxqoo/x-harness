# Implementation Summary: Registration Admission Control Gate

*Created: 2026-09-30*
*Baseline ref: `v1.0.19` (commit `9d031852c1acc2a095e33021bb8906b0affed4f4`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Added a fail-closed, off-by-default registration admission-control gate. A new client module (`registry/services/registration_gate.py`) POSTs the registration payload plus routing context (asset type, endpoint, action, path, user) to a configurable external webhook; HTTP 200 allows the registration, 403 denies it with the gate's reason surfaced to the caller, and timeouts, connection errors, unexpected statuses, or misconfiguration block the registration with 503 and a fixed message. All seven registration/update paths (agent register/update, server register/internal register/edit, skill register/update) consult the gate before persisting, and the five new settings are wired through `.env.example`, docker-compose, Terraform ECS, the Helm chart, and the admin config API. Credential-bearing payload fields are scrubbed before anything is sent to the external gate.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/services/registration_gate.py` | added | +173 / -0 | Gate client: GateDecision, payload builder with credential scrubbing, check_registration_gate |
| `registry/core/config.py` | modified | +22 / -0 | Five new Settings fields (enabled/url/timeout/auth header/auth token) |
| `registry/api/agent_routes.py` | modified | +36 / -0 | Gate call in register_agent and update_agent |
| `registry/api/server_routes.py` | modified | +68 / -0 | Gate call in register_service, internal_register_service (action=update on overwrite), edit_server_submit |
| `registry/api/skill_routes.py` | modified | +36 / -0 | Gate call in register_skill and update_skill |
| `registry/api/config_routes.py` | modified | +11 / -0 | `registration_gate` CONFIG_GROUP (order 18), auth token marked sensitive |
| `.env.example` | modified | +23 / -0 | Documented gate settings block |
| `docker-compose.yml` | modified | +6 / -0 | Registry service env entries |
| `terraform/aws-ecs/variables.tf` | modified | +35 / -0 | Root variables (token sensitive) |
| `terraform/aws-ecs/main.tf` | modified | +7 / -0 | Module input pass-through |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | modified | +32 / -0 | Module variables |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +20 / -0 | Container env entries |
| `charts/registry/values.yaml` | modified | +10 / -0 | `registrationGate:` values block |
| `charts/registry/templates/secret.yaml` | modified | +8 / -0 | Gate keys rendered into the Secret, token supports existingSecret |
| `tests/unit/services/test_registration_gate.py` | added | +321 / -0 | Verdict matrix, no-op, misconfiguration, payload scrubbing, timeout clamp, auth header |
| `tests/unit/api/test_registration_gate_routes.py` | added | +419 / -0 | Route-level allow/deny/503 tests for all seven wired paths |

Total: +1227 / -0 (16 files).

## How to Apply

```bash
git clone --branch v1.0.19 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

## Deviations from the LLD
- `GATE_UNAVAILABLE_MESSAGE` import is present in route modules for the 503 bodies; the LLD showed this for agent/skill routes and the table for server routes; implemented exactly.
- In `update_skill`, the payload passed to the gate is `{"path": normalized_path, **updates}` per the LLD's "payload includes path" resolution (review finding B4).
- The disabled no-op route test (`test_agent_register_skips_gate_when_disabled`) pins the contract that the gate client (not the route) owns the enabled flag; the LLD describes this behavior but did not prescribe this specific test shape.
- None otherwise - implemented as designed, including all review-driven LLD revisions (structural `failure` flag, credential scrubbing, internal-overwrite-as-update, timeout clamp, reason truncation, URL scheme check).

## Not Implemented / Follow-ups
- Gate allow/deny/error counters exported to the metrics service (LLD Open Question / Non-Goal).
- A shared `_gate_or_raise` route helper to deduplicate the seven wiring blocks (SMTS nice-to-have; explicit blocks kept for reviewability).

## Verification (not executed)
Tests were designed in `testing.md` and unit tests were written under `tests/unit/services/test_registration_gate.py` and `tests/unit/api/test_registration_gate_routes.py`, but per skill constraints they were NOT run: the target repo was read and edited only, never executed (no pytest, ruff, mypy, docker, terraform). `patch.diff` was verified to apply cleanly onto a fresh checkout of `v1.0.19` with `git apply --check`.
