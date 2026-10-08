# Low-Level Design: Configurable MCP Proxy Upstream Timeout (MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS)

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
The auth-server's `/mcp-proxy` hop opens its upstream connection with a hardcoded 30 second timeout (`httpx.AsyncClient(timeout=30.0)` at `auth_server/server.py:4585`). Upstream MCP tool calls that legitimately run longer than 30 seconds are killed and the hop returns `504 Upstream MCP server timed out` even though the upstream is healthy and still working. Fan-out coordinator agents hit this constantly: lightweight calls (`initialize`, `tools/list`) succeed while heavy delegations fail at exactly 30s. Operators cannot raise the value without rebuilding the image.

### Goals
- Make the proxy-hop upstream timeout configurable via the settings model and an `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` environment variable.
- Mirror the established `MCP_PROXY_MAX_BODY_BYTES` pattern end to end: settings field, clamping reader helper, admin config surface, `.env.example`, docker-compose, Helm chart, Terraform, unified parameter docs.
- Keep the default at 30 seconds so existing deployments see zero behaviour change.
- Enforce a minimum floor (1 second) so the timeout can never be effectively disabled.
- Add unit tests for the default, an override, and the validation floor.

### Non-Goals
- Per-server or per-request timeout overrides.
- Granular httpx connect/read/write/pool timeouts; the client keeps receiving a single scalar float.
- nginx / ingress / ALB idle-timeout changes; operators raising this value past their edge proxy's idle timeout must raise those separately (documented, not code).
- Streaming SSE keep-alive renegotiation; the timeout semantics are identical to today's 30s, only the value changes.
- Any other hop's timeouts.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `auth_server/server.py` | FastAPI auth-server: `/validate` token mint, `/mcp-proxy` hop, tool filtering | Contains the hardcoded `timeout=30.0` (line 4585) and the reader-helper pattern to copy (`_read_mcp_proxy_max_body_bytes`, line 234) |
| `registry/core/config.py` | Pydantic `Settings` model (pydantic-settings, `case_sensitive=False`, `extra="ignore"`) | Where the new `mcp_proxy_upstream_timeout_seconds` field goes, next to `mcp_proxy_max_body_bytes` (line 876) |
| `registry/api/config_routes.py` | Admin config surface (`CONFIG_SECTIONS` field registry) | Where the knob is exposed to admins; body-bytes entry at line 87 |
| `.env.example` | Docker compose env template | `MCP_PROXY_MAX_BODY_BYTES=2097152` documented at line 1281; new knob goes directly below it |
| `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml` | Compose surfaces, auth-server service env | Each passes `MCP_PROXY_MAX_BODY_BYTES=${MCP_PROXY_MAX_BODY_BYTES:-2097152}` |
| `charts/auth-server/values.yaml` | Helm values | `mcpProxyMaxBodyBytes: "2097152"` at line 70 under `.app` |
| `charts/auth-server/templates/secret.yaml` | Helm secret template | Renders `MCP_PROXY_MAX_BODY_BYTES: {{ .Values.app.mcpProxyMaxBodyBytes | b64enc | quote }}` at line 222 |
| `charts/auth-server/reserved-env-names.txt` | Reserved env names list | `MCP_PROXY_MAX_BODY_BYTES` at line 44 |
| `terraform/aws-ecs/variables.tf` | Root Terraform variables | `mcp_proxy_max_body_bytes` variable with `>= 1024` validation at line 1249 |
| `terraform/aws-ecs/main.tf` | Root module wiring | Passes `mcp_proxy_max_body_bytes = var.mcp_proxy_max_body_bytes` into the mcp-gateway module (line 285) |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | Module variables | Module-side copy, line 1229 |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ECS task-definition env | Emits `MCP_PROXY_MAX_BODY_BYTES` at line 423 |
| `terraform/aws-ecs/terraform.tfvars.example` | Example tfvars | Commented `# mcp_proxy_max_body_bytes = 2097152` at line 674 |
| `docs/unified-parameter-reference.md` | Parameter reference table | Body-bytes row at line 380 |
| `tests/auth_server/unit/test_server.py` | auth-server unit tests | `TestMcpProxyEndpointHeaderPassthrough` shows the `TestClient` + `_patch_httpx_async_client` + `_mcp_proxy_token_headers` conventions to reuse |

### Existing Patterns Identified
1. **Clamping reader helper** (`_read_mcp_proxy_max_body_bytes`, `auth_server/server.py:234`):
   - Order: `settings.<field>` (if not None) → `os.getenv(MCP_PROXY_...)` → default; `max(candidate, minimum)` clamp; non-numeric env value logs a warning and returns the default.
   - Re-read on every request, so tests and operators can change values without restart ordering hazards.
   - A future implementer should copy this structure exactly, changing only field name, env var, default, floor, and types (int → float).
2. **Settings field with `ge=` floor** (`registry/core/config.py:876`): `mcp_proxy_max_body_bytes: int = Field(default=..., ge=1024, description=...)`. The new field follows with `ge=1.0`.
3. **Deployment surface fan-out**: every operator knob appears on all of `.env.example`, three compose files, Helm (values + secret + reserved names), Terraform (root vars with validation + module vars + `ecs-services.tf` + tfvars example), and the unified parameter reference. The new knob must appear on the same set.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `mcp_proxy` request handler | Extends | Reads the new timeout via the helper and passes it to `httpx.AsyncClient(timeout=...)` |
| `Settings` (registry.core.config) | Extends | New float field with `ge=1.0` |
| Admin config API | Extends | New entry in the `auth` section of `CONFIG_SECTIONS` |
| Deployment surfaces | Configuration | Compose / Helm / Terraform / docs rows as listed above |

### Constraints and Limitations Discovered
- `httpx.TimeoutException` handling at line 4606 already maps timeouts to 504; no error-path change needed.
- The Helm registry chart does not carry `mcpProxyMaxBodyBytes` (it is auth-server-only), so the new knob is also auth-server-only in Helm.
- The `settings` object is a module-level singleton imported by `server.py`; the existing reader reads it via `getattr(settings, ...)` so monkeypatching the attribute in tests works without re-instantiation.
- Terraform root variable validation (`>= 1024` for bytes) is the established place for the IaC-side floor; mirror with `>= 1`.
- `terraform.tfvars.example` keeps the knob commented out; mirror that.

## Architecture

### System Context Diagram

```
 MCP client (IDE / coordinator agent)
        |
        | POST /mcp-proxy/{server}/mcp
        v
    [ nginx ]  --/validate--> [ auth-server /validate ] (unchanged)
        |
        v
    [ auth-server /mcp-proxy handler ]
        |  timeout = _read_mcp_proxy_upstream_timeout_seconds()
        |            settings.mcp_proxy_upstream_timeout_seconds (ge=1.0)
        |              -> env MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS
        |              -> default 30.0
        v
    [ httpx.AsyncClient(timeout=<value>) ]  --> upstream MCP server
        |                                     (long tool calls no longer
        |                                      killed at exactly 30s)
        v
    504 Upstream MCP server timed out   (only if the configured timeout elapses)
```

### Sequence Diagram

```
Client   nginx   auth-server /mcp-proxy        httpx            upstream
  |--POST-->|        |                            |                 |
  |         |------->| verify token (unchanged)   |                 |
  |         |        | timeout = helper()         |                 |
  |         |        |--POST(timeout=T)---------->|--------------->|
  |         |        |                            |   ... tool runs ...
  |         |        |                            |<---------------|
  |         |        |<---streamed response-------|                |
  |<--------|--------| 200 (or 504 only if T elapses)              |
```

### Component Diagram

```
registry/core/config.py Settings
  mcp_proxy_upstream_timeout_seconds: float = Field(default=30.0, ge=1.0)
        ^
        | getattr
auth_server/server.py
  _read_mcp_proxy_upstream_timeout_seconds() -> float
        ^                            ^ fallback
        |                            |
  mcp_proxy() handler         os.getenv("MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS")
        |
  httpx.AsyncClient(timeout=<float>)

Surfaces (config only): config_routes.py, .env.example, docker-compose*.yml (x3),
charts/auth-server (values.yaml, secret.yaml, reserved-env-names.txt),
terraform/aws-ecs (variables.tf, main.tf, module variables.tf, ecs-services.tf,
terraform.tfvars.example), docs/unified-parameter-reference.md
```

## Data Models

### New Models
None.

### Model Changes
`registry/core/config.py`, `Settings` class, immediately after `mcp_proxy_max_body_bytes`:

```python
mcp_proxy_upstream_timeout_seconds: float = Field(
    default=30.0,
    ge=1.0,
    description=(
        "Timeout (seconds) for the auth-server /mcp-proxy hop's upstream "
        "request. Raise for MCP servers with long-running tool calls; the "
        "hop returns 504 when the timeout elapses."
    ),
)
```

`pydantic-settings` resolves `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` from the environment automatically (`case_sensitive=False`), matching how `mcp_proxy_max_body_bytes` is populated. Invalid env values make Settings construction fall back per the existing reader helper (warning + default), so startup never crashes on a bad value.

## API / CLI Design

### New Endpoints / Commands
None. The parameter appears in the existing admin config API payload (`GET/PUT /api/config`) as a new field in the `auth` section, rendered by the existing generic field machinery in `registry/api/config_routes.py`. No new route, no new CLI command.

**Error Cases:**
- Unchanged: 504 `Upstream MCP server timed out` when the configured timeout elapses; 502 on upstream HTTP errors.
- A value below 1.0 is clamped to 1.0 (helper) and rejected by validation on the Terraform surface.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` | float (seconds) | `30` | No | Upstream request timeout for the auth-server `/mcp-proxy` hop. Values below 1 are clamped to 1. Non-numeric values warn and fall back to 30. |

### Settings / Config Class Updates
See [Data Models](#data-models).

### Deployment Surface Checklist

| Surface | File | Entry |
|---------|------|-------|
| `.env.example` | `.env.example` (~line 1281) | `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=30` with comment block |
| docker-compose | `docker-compose.yml` (~line 550) | `- MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=${MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS:-30}` |
| docker-compose prebuilt | `docker-compose.prebuilt.yml` (~line 410) | same |
| docker-compose podman | `docker-compose.podman.yml` (~line 409) | same |
| Helm values | `charts/auth-server/values.yaml` (~line 70) | `mcpProxyUpstreamTimeoutSeconds: "30"` |
| Helm secret | `charts/auth-server/templates/secret.yaml` (~line 222) | `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS: {{ .Values.app.mcpProxyUpstreamTimeoutSeconds | toString | b64enc | quote }}` |
| Helm reserved names | `charts/auth-server/reserved-env-names.txt` (~line 44) | `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` (alphabetical placement) |
| Terraform root vars | `terraform/aws-ecs/variables.tf` (~line 1249) | `mcp_proxy_upstream_timeout_seconds` number, default 30, validation `>= 1` |
| Terraform root wiring | `terraform/aws-ecs/main.tf` (~line 285) | `mcp_proxy_upstream_timeout_seconds = var.mcp_proxy_upstream_timeout_seconds` |
| Terraform module vars | `terraform/aws-ecs/modules/mcp-gateway/variables.tf` (~line 1229) | same variable, no validation (module convention) |
| ECS task def | `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` (~line 423) | `{ name = "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS", value = tostring(var.mcp_proxy_upstream_timeout_seconds) }` |
| tfvars example | `terraform/aws-ecs/terraform.tfvars.example` (~line 674) | commented `# mcp_proxy_upstream_timeout_seconds = 30` |
| Admin config | `registry/api/config_routes.py` (~line 87) | `("mcp_proxy_upstream_timeout_seconds", "MCP Proxy Upstream Timeout (seconds)", False)` |
| Docs | `docs/unified-parameter-reference.md` (~line 380) | New row after the body-bytes row |

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Settings field
**File:** `registry/core/config.py`
**Lines:** ~884 (immediately after `mcp_proxy_max_body_bytes`)

```python
mcp_proxy_upstream_timeout_seconds: float = Field(
    default=30.0,
    ge=1.0,
    description=(
        "Timeout (seconds) for the auth-server /mcp-proxy hop's upstream "
        "request. Raise for MCP servers with long-running tool calls; the "
        "hop returns 504 when the timeout elapses."
    ),
)
```

#### Step 2: Reader helper
**File:** `auth_server/server.py`
**Lines:** ~253 (directly after `_read_mcp_proxy_max_body_bytes`)

```python
def _read_mcp_proxy_upstream_timeout_seconds() -> float:
    """Resolve the /mcp-proxy hop's upstream timeout.

    Same cascade as _read_mcp_proxy_max_body_bytes: settings first, then
    the MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS env var, then the 30s default
    that predates this knob. Clamped to a 1s floor so the timeout can
    never be effectively disabled. Non-finite values (nan/inf) are
    treated as misconfiguration: the timeout must always be a bounded,
    finite cap.
    """
    default_seconds = 30.0
    minimum_seconds = 1.0
    try:
        value = getattr(settings, "mcp_proxy_upstream_timeout_seconds", None)
        if value is not None:
            candidate = float(value)
            if math.isfinite(candidate):
                return max(candidate, minimum_seconds)
            # nan/inf in settings: treat as a parse failure and fall
            # through to the env branch.
    except (TypeError, ValueError) as e:
        logger.debug(
            f"settings.mcp_proxy_upstream_timeout_seconds parse failed, "
            f"falling back to env: {e}"
        )
    raw = os.getenv("MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS")
    if not raw:
        return default_seconds
    try:
        candidate = float(raw)
    except ValueError:
        logging.warning(
            f"Invalid MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS={raw!r}; using default {default_seconds}"
        )
        return default_seconds
    if not math.isfinite(candidate):
        logging.warning(
            f"Non-finite MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS={raw!r}; using default {default_seconds}"
        )
        return default_seconds
    return max(candidate, minimum_seconds)
```

Review-driven additions vs a verbatim copy of the int reader: `math.isfinite` guards in both branches. The int reader could never see `nan`/`inf`, but a float knob can (`float("nan")` parses cleanly and `max(nan, 1.0)` propagates NaN in Python, poisoning every upstream call). Non-finite values are rejected outright -- `inf` would mean "no timeout", and an unbounded upstream cap is exactly the resource-exhaustion footgun the 1s floor exists to prevent. The returned timeout is therefore always a finite float >= 1.0. `import math` is added to the imports at the top of `auth_server/server.py` (stdlib, verify it is not already imported before adding).

#### Step 3: Use it in the proxy handler
**File:** `auth_server/server.py`
**Lines:** ~4576-4585

```python
    filter_enabled = _read_mcp_filter_enabled()
    max_body_bytes = _read_mcp_proxy_max_body_bytes()
    upstream_timeout_seconds = _read_mcp_proxy_upstream_timeout_seconds()
    forward_headers = _forward_headers(dict(request.headers))

    logger.info(
        f"mcp_proxy: server={server_name} method={incoming_method} filter_enabled={filter_enabled}"
    )

    try:
        async with httpx.AsyncClient(timeout=upstream_timeout_seconds) as client:
```

#### Step 4: Admin config surface
**File:** `registry/api/config_routes.py`
**Lines:** ~87

```python
            ("mcp_proxy_upstream_timeout_seconds", "MCP Proxy Upstream Timeout (seconds)", False),
```

placed directly after the `mcp_proxy_max_body_bytes` entry.

#### Step 5: `.env.example`
**File:** `.env.example`
**Lines:** ~1282 (after the body-bytes block)

```
# Timeout (in seconds) for the auth-server /mcp-proxy hop's upstream
# request. Raise this if upstream MCP servers run long-running tool calls
# that are killed at 30s with HTTP 504. Values below 1 are clamped to 1.
# Default: 30
MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=30
```

#### Step 6: docker-compose (three files)
**Files:** `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml`

```yaml
      - MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=${MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS:-30}
```

immediately after the `MCP_PROXY_MAX_BODY_BYTES` line in the auth-server service env.

#### Step 7: Helm chart
**Files:**
- `charts/auth-server/values.yaml` (~line 70): `mcpProxyUpstreamTimeoutSeconds: "30"   # /mcp-proxy upstream request timeout (seconds, min 1); raise for long-running tool calls`
- `charts/auth-server/templates/secret.yaml` (~line 222): `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS: {{ .Values.app.mcpProxyUpstreamTimeoutSeconds | toString | b64enc | quote }}`
- `charts/auth-server/reserved-env-names.txt`: add `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` in alphabetical position relative to neighbouring entries.

#### Step 8: Terraform
**Files:**
- `terraform/aws-ecs/variables.tf` (~line 1257, after the body-bytes variable):

```hcl
variable "mcp_proxy_upstream_timeout_seconds" {
  description = "Timeout (seconds) for the auth-server /mcp-proxy hop's upstream request. Raise for MCP servers with long-running tool calls that otherwise fail at 30s with HTTP 504. Default 30; minimum 1."
  type        = number
  default     = 30

  validation {
    condition     = var.mcp_proxy_upstream_timeout_seconds >= 1
    error_message = "mcp_proxy_upstream_timeout_seconds must be at least 1"
  }
}
```

- `terraform/aws-ecs/main.tf` (~line 285): `mcp_proxy_upstream_timeout_seconds = var.mcp_proxy_upstream_timeout_seconds`
- `terraform/aws-ecs/modules/mcp-gateway/variables.tf` (~line 1241): same variable without the validation block (module convention).

```hcl
variable "mcp_proxy_upstream_timeout_seconds" {
  description = "Timeout (seconds) for the auth-server /mcp-proxy hop's upstream request. Default 30."
  type        = number
  default     = 30
}
```

- `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` (~line 425): `{ name = "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS", value = tostring(var.mcp_proxy_upstream_timeout_seconds) }`
- `terraform/aws-ecs/terraform.tfvars.example` (~line 674): `# mcp_proxy_upstream_timeout_seconds = 30`

#### Step 9: Docs
**File:** `docs/unified-parameter-reference.md` (~line 380, new table row after the body-bytes row):

```
| MCP proxy upstream timeout | `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` | `mcp_proxy_upstream_timeout_seconds` | `auth-server.app.mcpProxyUpstreamTimeoutSeconds` | Timeout (seconds) for the auth-server `/mcp-proxy` hop's upstream request. Raise for MCP servers with long-running tool calls that fail at 30s with HTTP 504; note edge proxies (ALB idle timeout, nginx) may need matching raises. Minimum 1; default `30`. |
```

#### Step 10: Unit tests
**File:** `tests/auth_server/unit/test_server.py` (new test class near the other `/mcp-proxy` tests)

Tests mirroring the file's existing conventions:

1. **Default:** with neither settings attribute nor env var set, a driven `/mcp-proxy` request constructs `httpx.AsyncClient(timeout=30.0)`. The helper `_patch_httpx_async_client` is extended to keep a reference to the mock class so tests can read `call_args.kwargs["timeout"]`.
2. **Override:** `patch.dict(os.environ, {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "120"})` (settings attribute absent), assert `timeout == 120.0`.
3. **Floor:** `patch.dict(os.environ, {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "0.25"})`, assert `timeout == 1.0` (clamped, not passed through).
4. **Junk:** `patch.dict(os.environ, {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "banana"})`, assert `timeout == 30.0` and no exception.
5. **Non-finite (review follow-up):** `patch.dict(os.environ, {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "inf"})` (and `"nan"`), assert `timeout == 30.0` -- non-finite values are rejected, never forwarded.

Implementation note for the tests: extend `_patch_httpx_async_client` to capture constructor kwargs (attach the mock class object so tests can read `call_args.kwargs["timeout"]`) instead of duplicating the mock scaffolding per test. The settings attribute path is covered indirectly: `getattr(settings, ..., None)` returns None when the attribute is absent, and the tests patch the attribute to None where the env path is exercised (or rely on the attribute not existing in the test settings fixture, as the existing body-bytes tests do).

### Error Handling
- Unchanged error paths: `httpx.TimeoutException` → 504, `httpx.HTTPError` → 502.
- New failure inputs are configuration values; all are handled in the reader (clamp / warn+default), never by crashing startup or the request.

### Logging
- `logger.debug` when the settings attribute fails to parse (mirrors body-bytes reader).
- `logging.warning` on a non-numeric env value, naming the variable and the default used (mirrors body-bytes reader).
- The existing per-request `logger.info(f"mcp_proxy: server=...")` line is intentionally left unchanged to keep the diff minimal; the timeout in effect is observable via the config API and docs instead.

## Observability
### Tracing / Metrics / Logging Points
- No new metrics. The 504 path already logs `mcp_proxy: upstream timeout for {upstream_url}` at ERROR with the httpx exception detail.
- Operators verify the effective value via the admin config surface or by observing that calls previously killed at exactly 30s now complete.

## Scaling Considerations
- Raising the timeout increases the number of concurrently open upstream connections and pending requests in the auth-server; at high fan-out rates size upstream capacity and gateway limits accordingly.
- No new caching or state; the helper is a pure read per request (same cost profile as the body-bytes reader).
- The bottleneck risk is upstream capacity, not the gateway: a longer timeout holds client connections longer, so nginx `proxy_read_timeout` and ALB idle timeout may need matching raises (documented).

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| (none) | All changes are additions to existing files |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~884 | New `mcp_proxy_upstream_timeout_seconds` field |
| `auth_server/server.py` | ~253, ~4577, ~4585 | New reader helper; read it per request; pass to `httpx.AsyncClient(timeout=...)` |
| `registry/api/config_routes.py` | ~87 | Admin config entry |
| `.env.example` | ~1282 | Documented env knob |
| `docker-compose.yml` | ~550 | env passthrough |
| `docker-compose.prebuilt.yml` | ~410 | env passthrough |
| `docker-compose.podman.yml` | ~409 | env passthrough |
| `charts/auth-server/values.yaml` | ~70 | `mcpProxyUpstreamTimeoutSeconds` |
| `charts/auth-server/templates/secret.yaml` | ~222 | render env var |
| `charts/auth-server/reserved-env-names.txt` | ~44 | reserve name |
| `terraform/aws-ecs/variables.tf` | ~1257 | root variable + validation |
| `terraform/aws-ecs/main.tf` | ~285 | module wiring |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | ~1241 | module variable |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ~425 | task-def env |
| `terraform/aws-ecs/terraform.tfvars.example` | ~674 | commented example |
| `docs/unified-parameter-reference.md` | ~380 | parameter row |
| `tests/auth_server/unit/test_server.py` | ~2418, new class | extend mock helper to capture kwargs; default/override/floor/junk tests |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (Python) | ~45 |
| New tests | ~70 |
| Modified config/deploy/docs lines | ~30 |
| **Total** | **~145** |

## Testing Strategy
See `testing.md` for the full executable plan. Unit tests land in `tests/auth_server/unit/test_server.py` following the existing `_patch_httpx_async_client` conventions; per skill constraints they are designed, not executed, here.

## Alternatives Considered

### Alternative 1: Separate httpx connect/read/write/pool timeouts
**Description:** Expose four granular knobs via `httpx.Timeout(...)`.
**Pros / Cons:** More control; four new surfaces entries, more operator confusion, no demonstrated need.
**Why Rejected:** The failure mode is a single wall-clock cap; one scalar matches the current code and the issue request.

### Alternative 2: Per-server timeout from the server registration record
**Description:** Store an optional per-registry-server timeout and use it in the hop.
**Pros / Cons:** Right long-term shape; requires schema/storage/API/admin-UI changes far beyond the issue.
**Why Rejected:** Out of scope; the global knob solves the stated operator pain with a config-only change.

### Alternative 3: Remove the timeout entirely when the knob is set to 0
**Description:** Treat 0 as "no timeout".
**Pros / Cons:** Convenient; a stuck upstream then holds connections indefinitely (resource exhaustion, hung nginx workers).
**Why Rejected:** Unsafe default surface; the 1s floor keeps a bounded cap mandatory.

### Comparison Matrix

| Criteria | Chosen (single float knob) | Alt 1 (granular) | Alt 2 (per-server) | Alt 3 (0 = none) |
|----------|---------------------------|------------------|--------------------|------------------|
| Complexity | Low | Medium | High | Low |
| Matches existing pattern | Yes | No | No | Partially |
| Operator safety | High | High | High | Low |
| Scope fit | Exact | Over-broad | Over-broad | Over-broad |

## Rollout Plan
- Phase 1: Implementation (this patch).
- Phase 2: Testing per `testing.md` (unit tests designed here; execution out of scope for the benchmark run).
- Phase 3: Deployment - default 30 keeps behaviour identical; operators opt in by setting the env var/Helm/Terraform value on the auth-server surface only.

## Open Questions
- None. (Edge-proxy idle timeouts are called out in docs as operator action, not code.)

## References
- Issue #1320.
- Pattern source: `_read_mcp_proxy_max_body_bytes` (`auth_server/server.py:234`) and its full deployment fan-out.
