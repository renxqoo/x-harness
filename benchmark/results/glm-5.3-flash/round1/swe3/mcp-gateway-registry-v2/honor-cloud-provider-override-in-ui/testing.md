# Testing Plan: Honour MCP_CLOUD_PROVIDER override in the UI telemetry-detection endpoint

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing

Verify that `GET /api/system/telemetry-detection` returns the resolved cloud value (override -> hint -> cascade) instead of the raw cascade, with unchanged behaviour when no override/hint applies, unchanged auth (401 anonymous), and an unchanged response shape.

### Prerequisites

- [ ] Registry dev stack running (`./scripts/service_mgmt.sh start`), or a unit-test environment with `uv` available
- [ ] An access token for an authenticated user (for the curl-based checks) or the unit-test auth override

### Shared Variables

```bash
export REGISTRY_URL="http://localhost:7860"
# Unit tests use the app.dependency_overrides[nginx_proxied_auth] pattern from
# tests/unit/test_stats_endpoint.py, so no real token is needed there.
export ACCESS_TOKEN="<paste-token-for-curl-checks>"
```

## 1. Functional Tests

### 1.1 HTTP / curl Tests

#### 1.1.1 Override set: endpoint reports the override, not the cascade

Setup: run the registry with `MCP_CLOUD_PROVIDER=on_premises` **and** `AWS_REGION=us-east-1` in the environment (the combination that reproduces the bug).

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$REGISTRY_URL/api/system/telemetry-detection" | jq .
```

Expected status: `200`

Expected response:

```json
{ "cloud": "on_premises", "cloud_detection_method": "explicit" }
```

Assertions:
- `cloud == "on_premises"` (override wins even though `AWS_REGION` would auto-detect `aws`)
- `cloud_detection_method == "explicit"`

Negative case: with `MCP_CLOUD_PROVIDER=definitely-not-valid`, the settings validator coerces it to `None`, so the response must fall back to the cascade tier (e.g. `aws/env` when `AWS_REGION` is set), never error.

#### 1.1.2 Override value variants

For each valid value `v` in `aws azure gcp on_premises other`:

```bash
MCP_CLOUD_PROVIDER=$v curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$REGISTRY_URL/api/system/telemetry-detection" | jq -e '.cloud == "'$v'" and .cloud_detection_method == "explicit"'
```

Expected: assertion passes for every value.

#### 1.1.3 Response shape unchanged

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$REGISTRY_URL/api/system/telemetry-detection" | jq 'keys | sort'
```

Expected: exactly `["cloud", "cloud_detection_method"]`.

### 1.2 Unit Tests (the required regression tests)

File: `tests/unit/test_stats_endpoint.py`, new class `TestTelemetryDetectionEndpoint`. Both tests use the established pattern from that file: `TestClient(registry.main.app)` with `app.dependency_overrides[nginx_proxied_auth]`, and patch resolver inputs together (`registry.core.telemetry.settings.mcp_cloud_provider`, hint tier, cascade).

#### 1.2.1 Override-set regression test

Patch `settings.mcp_cloud_provider = "on_premises"`, patch the cascade to return the trap value `("aws", "env")`, patch the hint tier to return `None`.

Call `GET /api/system/telemetry-detection`.

Expected: `200`; `.cloud == "on_premises"`; `.cloud_detection_method == "explicit"`. The trap value proves the cascade was never consulted when the override applies.

#### 1.2.2 Override-unset backwards-compatibility regression test

Patch `settings.mcp_cloud_provider = None`, patch the hint tier to return `None`, patch the cascade to return a sentinel pair `("gcp", "dmi")`.

Call `GET /api/system/telemetry-detection`.

Expected: `200`; `.cloud == "gcp"`; `.cloud_detection_method == "dmi"`. Proves the fall-through to the identical pre-change cascade result.

#### 1.2.3 Auth guard (already exists, keep green)

`tests/unit/test_stats_endpoint.py::...::test_telemetry_detection_rejects_unauthenticated_callers` must continue to pass: anonymous `GET` returns `401`.

Run:

```bash
uv run pytest tests/unit/test_stats_endpoint.py -k telemetry -q
```

Expected: all telemetry-detection tests pass.

## 2. Backwards Compatibility Tests

- **No override, no hint:** with `MCP_CLOUD_PROVIDER` unset, the endpoint must return exactly what the pre-change build returned. Covered by unit test 1.2.2 (cascade fall-through) and by the curl check on an unmodified local install: `AWS_REGION` set -> `{"cloud": "aws", "cloud_detection_method": "env"}`.
- **Invalid override:** `MCP_CLOUD_PROVIDER=bogus` is coerced to `None` by the existing validator (warning logged); endpoint must behave as if unset (covered by the negative case of 1.1.1).
- **Operator hint only (no env override):** set the hint via `POST /api/registry/cloud-provider-hint` as admin with `{"hint": "on_premises"}`; endpoint must report `{"cloud": "on_premises", "cloud_detection_method": "operator_declared"}` after the 60s hint cache expiry or a registry restart. Pre-change behaviour for hint-set installs was raw-cascade; the new behaviour is the intended, telemetry-consistent one and matches `_resolve_cloud()` consumers (`banner-state`).
- **Schema and auth:** 1.1.3 (shape) and 1.2.3 (401) are the compatibility guards.

## 3. UX Tests

- **Uptime tooltip:** with `MCP_CLOUD_PROVIDER=on_premises` and `AWS_REGION=us-east-1`, load the admin UI in a browser; hover the uptime widget. The `Deployment -> Cloud` row must show `on_premises (via explicit)`, not `aws (via env)`.
- **Override removed:** unset the override, restart the registry, hard-reload the UI. The row reverts to cascade output (e.g. `aws (via env)` on a local install).
- **Long values:** the row uses `truncate`; `on_premises (via operator_declared)` must not break the tooltip layout (string fits; verify visually).

## 4. Deployment Surface Tests

**Not Applicable** - no configuration parameter, Compose key, Helm value, or Terraform variable is added or changed; `MCP_CLOUD_PROVIDER` already exists on every surface (`.env.example`, `docker-compose*.yml`, `charts/registry`, `terraform/aws-ecs`). Rollback verification is simply applying the reverse patch; no infra state to restore.

## 5. End-to-End API Tests

Scenario "operator corrects a misclassified local install":

1. Start the registry with `AWS_REGION=us-east-1` and no override.
   `GET /api/system/telemetry-detection` -> `aws/env` (reproduces the complaint).
2. Set `MCP_CLOUD_PROVIDER=on_premises`, restart.
3. `GET /api/system/telemetry-detection` -> `on_premises/explicit`.
4. Load the UI; the tooltip shows `on_premises (via explicit)`.
5. Emit a telemetry event (startup or heartbeat) and inspect the outgoing payload/log: it reports `cloud=on_premises`, `detection_method=explicit`.
6. Assert UI display == telemetry event cloud == endpoint response. That three-way agreement is the acceptance condition of the fix.

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes, including both unit regression tests
- [ ] Section 2 (Backwards Compat) verified
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) marked Not Applicable
- [ ] Section 5 (E2E) verified
- [ ] Unit tests added under `tests/unit/test_stats_endpoint.py`
- [ ] `uv run pytest tests/unit/test_stats_endpoint.py -q` passes with no regressions

> Note (skill constraint): the tests above are specified, not executed by this benchmark run. `patch.diff` contains the two regression unit tests; a human or CI applies the patch and runs `uv run pytest tests/unit/test_stats_endpoint.py -k telemetry -q`.
