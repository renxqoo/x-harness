# Low-Level Design: Honour MCP_CLOUD_PROVIDER override in the UI telemetry-detection endpoint

*Created: 2026-09-29*
*Author: Claude (glm-5.3-flash, x-harness single-agent run)*
*Status: Draft*

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

`GET /api/system/telemetry-detection` (registry/api/system_routes.py) is the display path behind the admin UI's Uptime tooltip row `Deployment -> Cloud`. The endpoint calls the raw detection cascade `_detect_cloud_provider_with_method()` directly. The cascade's first tier (`_detect_cloud_from_env`) returns `aws` whenever `AWS_REGION` or `AWS_DEFAULT_REGION` is set, and `.env.example` ships `AWS_REGION=us-east-1`, so local (on-premises) installs are displayed as `aws (via env)`.

The operator override `MCP_CLOUD_PROVIDER` (allowed: `aws|azure|gcp|on_premises|other`) is honoured only in the telemetry event path (`_resolve_cloud()`), which reports `on_premises (method=explicit)` on override-set installs. The UI therefore contradicts the telemetry events for the same deployment.

### Goals

- The UI display path returns the same resolved `(cloud, cloud_detection_method)` pair the telemetry events report.
- Zero behaviour change when `MCP_CLOUD_PROVIDER` is unset and no operator hint is set (cascade fall-through preserved).
- Minimal diff: reuse the existing resolver; no new modules, no schema change, no frontend change.

### Non-Goals

- Changing the detection cascade itself.
- Changing telemetry event payloads, the collector schema, or the metrics allowlist.
- Changing `UptimeDisplay.tsx` (it renders whatever the endpoint returns).
- Changing `GET /api/registry/banner-state` (already resolved-value-based).
- New configuration parameters or deployment-surface changes.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/api/system_routes.py` (L333-354) | Defines `GET /api/system/telemetry-detection` | THE bug site: calls raw cascade `_detect_cloud_provider_with_method()` |
| `registry/core/telemetry.py` (L217-283) | Detection cascade `_detect_cloud_provider_with_method()` (lru_cache), 5 tiers: env -> dmi -> ecs_meta -> k8s_heuristic -> imds | Raw cascade; stays unchanged |
| `registry/core/telemetry.py` (L286-314) | `_get_operator_cloud_hint()` (60s TTL cache), `_invalidate_hint_cache()` | Hint tier used by the resolver; unchanged |
| `registry/core/telemetry.py` (L317-341) | `_resolve_cloud()` async resolver: explicit override -> operator hint -> cascade | The correct resolver to call from the endpoint |
| `registry/core/telemetry.py` (L44-52) | `_DETECTION_METHOD_*` constants incl. `explicit`, `operator_declared`, `operator_declined` | Method labels the endpoint may now also return |
| `registry/core/config.py` (L784-807) | `mcp_cloud_provider` setting + validator (invalid values -> None with warning) | Override already validated upstream; endpoint needs no re-validation |
| `registry/api/registry_routes.py` (L725-745) | `GET /api/registry/banner-state` already calls `_resolve_cloud()` | Precedent: an API route already consumes the async resolver |
| `frontend/src/components/UptimeDisplay.tsx` (L22-24, L50, L181-186) | Fetches `/api/system/telemetry-detection`, renders `cloud (via cloud_detection_method)` | Frontend consumer; no change needed |
| `tests/unit/test_stats_endpoint.py` (L450-458) | Existing 401 regression guard for this endpoint | Where the new regression tests belong |
| `tests/unit/core/test_telemetry.py` (L241 etc.) | Patches `registry.core.telemetry.settings` and sets `mock_settings.mcp_cloud_provider` | Established mocking pattern to follow |

### Existing Patterns Identified

1. **Async resolver consumed from routes via local import**: `get_banner_state` does `from registry.core.telemetry import _resolve_cloud` inside the handler, then `await _resolve_cloud()`.
   - Files: `registry/api/registry_routes.py:729-734`
   - How a future implementer should follow this: same local-import + await pattern in `system_routes.py`.
2. **Auth dependency declared for side effects**: the endpoint takes `_: Annotated[dict, Depends(nginx_proxied_auth)]`.
   - Files: `registry/api/system_routes.py:333-338`
   - How: keep it as is; 401 behaviour must not change.
3. **Settings patching in unit tests**: tests patch `registry.core.telemetry.settings` and set `mock_settings.mcp_cloud_provider`.
   - Files: `tests/unit/core/test_telemetry.py:241`
   - How: reuse this pattern; also clear the resolver's caches when stubbing tiers.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `_resolve_cloud()` | Uses (async) | Endpoint must `await` it; it is async because the hint tier reads the registry-card repository |
| `settings.mcp_cloud_provider` | Depends on | Validated in config; `None` means "no override" |
| Registry card repository | Indirect via hint tier | Only hit when no override is set; 60s TTL cache; never raises |
| `CLOUD_DETECTION_TOTAL` metric | Side effect | `_resolve_cloud()` increments it (via `_log_detection_result`); label set already includes the new method values |

### Constraints and Limitations Discovered

- `_resolve_cloud()` is `async` (hint tier awaits a repository call), so the endpoint handler must await it. The handler is already `async def`, so this is free.
- The hint tier hits the registry-card repository on cache miss when no override is set. The existing 60s TTL cache keeps this at one read/minute per process; acceptable for a per-page-load admin endpoint.
- The docstring of the endpoint currently claims only cascade methods (`env/dmi/ecs_meta/k8s_heuristic/imds/unknown`); it must be widened to include `explicit/operator_declared/operator_declined`.

## Architecture

### Sequence Diagram

```
UI (UptimeDisplay.tsx)
  | GET /api/system/telemetry-detection
  v
FastAPI route get_telemetry_detection_info  (nginx_proxied_auth: 401 if anon)
  |
  | await _resolve_cloud()                      [registry/core/telemetry.py]
  |    1. settings.mcp_cloud_provider set?  --> (override, "explicit")
  |    2. registry-card hint?
  |         on_premises/other            --> (hint, "operator_declared")
  |         declined                     --> ("unknown", "operator_declined")
  |    3. _detect_cloud_provider_with_method()  (lru_cached cascade)
  |         env -> dmi -> ecs_meta -> k8s_heuristic -> imds
  |    4. ("unknown", "unknown")
  v
{"cloud": <cloud>, "cloud_detection_method": <method>}
  |
  v
Uptime tooltip renders:  <cloud> (via <method>)
```

### Before / After

```
BEFORE: route --> _detect_cloud_provider_with_method()   (raw cascade; ignores override)
AFTER:  route --> _resolve_cloud()                       (override -> hint -> same cascade)
```

## Data Models

No new models. Response shape is unchanged (plain dict, same two keys):

```python
{"cloud": str, "cloud_detection_method": str}
```

`cloud` may additionally take the values `on_premises` / `other` (already valid telemetry labels) and `cloud_detection_method` may additionally be `explicit` / `operator_declared` / `operator_declined`. The collector regex allowlist (`terraform/telemetry-collector/lambda/collector/schemas.py`, `_CLOUD_DETECTION_METHOD_PATTERN`) already includes these values, and the UI renders both fields as free-form strings, so no schema work is required.

## API / CLI Design

### Modified Endpoint

**`GET /api/system/telemetry-detection`** (no new endpoint, no shape change)

**Request / Invocation:**

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" https://<registry>/api/system/telemetry-detection
```

**Expected Response (override set, `MCP_CLOUD_PROVIDER=on_premises`):**

```json
{ "cloud": "on_premises", "cloud_detection_method": "explicit" }
```

**Expected Response (override unset, AWS_REGION set as before):**

```json
{ "cloud": "aws", "cloud_detection_method": "env" }
```

**Error Cases:**

- 401: unauthenticated caller (unchanged).

## Configuration Parameters

No new parameters. The existing `MCP_CLOUD_PROVIDER` (settings field `mcp_cloud_provider`, chart value `registry.app.mcpCloudProvider`) now additionally governs the UI display path. Its documented surfaces (`.env.example`, `docker-compose*.yml`, `charts/registry` reserved names + `configmap-otel.yaml`, `terraform/aws-ecs` task def, `docs/unified-parameter-reference.md`) are unchanged; the parameter's semantics simply extend to "everything that displays or reports the cloud", which is what the docs already claim ("Override cloud auto-detection").

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Rewire the endpoint to the resolver

**File:** `registry/api/system_routes.py`
**Lines:** ~333-354 (function `get_telemetry_detection_info`)

Change the body from:

```python
from ..core.telemetry import _detect_cloud_provider_with_method

cloud, method = _detect_cloud_provider_with_method()
return {"cloud": cloud, "cloud_detection_method": method}
```

to:

```python
from ..core.telemetry import _resolve_cloud

cloud, method = await _resolve_cloud()
return {"cloud": cloud, "cloud_detection_method": method}
```

and update the docstring so the returned method list includes the override/hint methods:

```
- cloud: aws/gcp/azure/on_premises/other/unknown
- cloud_detection_method: explicit/operator_declared/operator_declined/env/dmi/ecs_meta/k8s_heuristic/imds/unknown
```

That is the entire production change.

### Error Handling

- `_resolve_cloud()` never raises out of the route: the explicit tier is a dict lookup on validated settings; the hint tier swallows repository errors and returns `None`; the cascade tier is `lru_cache`d and internally guards its probes. No new try/except at the call site.

### Logging

- `_log_detection_result()` inside `_resolve_cloud()`/cascade already emits the `[telemetry] cloud_detection:` info line and bumps `CLOUD_DETECTION_TOTAL`. The endpoint gains that side effect for free; no additional logging at the route.

## Observability

- The `CLOUD_DETECTION_TOTAL{cloud,method}` counter now also reflects UI-triggered resolutions. Because the override tier short-circuits, an override-set install converges on `cloud=on_premises,method=explicit` in both telemetry and UI paths, which is precisely the consistency this fix restores.
- No new metrics, spans, or log lines are introduced.

## Scaling Considerations

- Worst case added latency per UI page load: one registry-card repository read per 60s per process (existing TTL cache), plus the cached cascade. Negligible for an admin-facing endpoint.
- The cascade remains `lru_cache(maxsize=1)`; concurrency safety characteristics are unchanged (comment on the function already documents thread-safety after first completion).

## File Changes

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/api/system_routes.py` | ~333-354 | Call `await _resolve_cloud()` instead of raw cascade; widen docstring method list |

### New Test Coverage

| File Path | Description |
|-----------|-------------|
| `tests/unit/test_stats_endpoint.py` | New class `TestTelemetryDetectionEndpoint` with regression tests: override-set returns `(override, explicit)` even when the cascade would say `aws`; override-unset falls through to cascade (cascade stub returns a sentinel pair, hint stub returns None); both authenticated |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| Modified production code | ~6 |
| New tests | ~110 |
| **Total** | **~116** |

## Testing Strategy

Full plan in `testing.md`. Core: two regression tests hitting the route through `TestClient` with `nginx_proxied_auth` overridden, patching `registry.core.telemetry.settings.mcp_cloud_provider` (`"on_premises"` vs `None`), plus the existing 401 guard retained.

## Alternatives Considered

### Alternative 1: Apply the override inline in the endpoint

Read `settings.mcp_cloud_provider` in `system_routes.py`, return early if set, else call the cascade.

- Pros: no await needed, endpoint never touches the repository.
- Cons: duplicates the resolver's priority logic; drifts the moment `_resolve_cloud()` gains a tier (it already outgrew a naive version by adding the hint and declined tiers); the hint tier exists precisely so the UI agrees with telemetry for hint-set installs too.
- Why Rejected: two resolvers that must never disagree is a bug factory; reuse the one resolver.

### Alternative 2: Cache the resolved value in the endpoint

Add a second cache for the endpoint's response.

- Pros: fewer repository reads.
- Cons: a second staleness window beyond the existing 60s hint cache and the process-lifetime cascade cache; complexity for no measurable gain.
- Why Rejected: existing caches already bound cost.

### Comparison Matrix

| Criteria | Chosen (reuse `_resolve_cloud`) | Alt 1 (inline override) | Alt 2 (endpoint cache) |
|----------|--------------------------------|-------------------------|------------------------|
| Consistency with telemetry | Guaranteed (same function) | By re-implementation | Same as chosen |
| Complexity | Low | Low-Med | Med |
| Diff size | ~6 lines | ~12 lines | ~25 lines |
| Drift risk | None | Real | None |

## Rollout Plan

- Phase 1: Implementation (this patch).
- Phase 2: Verification per `testing.md` (not executed by this skill).
- Phase 3: Ships with the next release; no migration, no deploy-surface change, revert = apply reverse patch.

## Open Questions

- None.

## References

- Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1306
- Override introduction: issue #1120; `docs/unified-parameter-reference.md` row for `MCP_CLOUD_PROVIDER`.
- Resolver: `registry/core/telemetry.py` `_resolve_cloud()`; cascade: `_detect_cloud_provider_with_method()`.
