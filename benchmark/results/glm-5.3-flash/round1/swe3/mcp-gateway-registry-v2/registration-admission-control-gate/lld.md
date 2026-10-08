# Low-Level Design: Registration Admission Control Gate

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (revised after expert review)*

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
Any authenticated user with the right permissions can register an agent, server, or skill with no external policy enforcement. Organizations need to apply their own rules (naming conventions, compliance checks, approval workflows) before a registration is persisted. The registry currently has no hook point for that policy.

### Goals
- Consult a configurable external HTTP admission-control webhook before ANY agent, server, or skill registration or update is persisted.
- Fail closed: gate deny, timeout, unreachable gate, or unexpected gate response all block the registration.
- Surface the gate's denial reason to the caller; surface a fixed generic message on gate failure (no internal details leaked).
- Be a strict no-op when `REGISTRATION_GATE_ENABLED=false` (the default), so existing deployments are unaffected.
- Identify which endpoint the call came from in the gate payload so one gate can apply per-route policy.
- Wire the configuration through every deployment surface: `.env.example`, docker-compose, Terraform ECS, Helm chart, and the admin config API.
- Include unit tests for allow, deny, timeout, unreachable gate, unexpected status, disabled no-op, and misconfiguration.

### Non-Goals
- No gate on delete, toggle, rate, health-check, or read paths.
- No reference implementation of the gate service; the registry implements the client side only.
- No retries or circuit breaker on the gate call: one synchronous attempt per registration, fail-closed on error.
- No queue-based or asynchronous admission.
- No frontend UI changes; the new settings surface automatically through the existing config API mechanism.
- No changes to what is persisted: the gate only decides allow or deny.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/api/agent_routes.py` | A2A agent API routes | `register_agent` (line 330) and `update_agent` (line 1194) are two of the seven gate call sites |
| `registry/api/server_routes.py` | MCP server UI/API routes | `register_service` (line 627), `internal_register_service` (line 852), and `edit_server_submit` (line 1451) are three gate call sites |
| `registry/api/skill_routes.py` | Skill API routes (router prefix `/skills`) | `register_skill` (line 618) and `update_skill` (line 661) are the last two gate call sites |
| `registry/services/skill_service.py` | Skill business logic | `register_skill` (line 557) and `update_skill` (line 755) do URL validation and persistence; the gate must run before them, at the route layer |
| `registry/core/config.py` | Pydantic `Settings` (line 27) | Where the five new settings fields are added |
| `registry/api/config_routes.py` | Admin config API, `CONFIG_GROUPS` (line ~130) | Where the new settings are exposed to admins |
| `registry/services/ans_client.py` | Existing outbound-webhook client with httpx | The pattern to follow: `httpx.AsyncClient(timeout=...)` per call, module logger, explicit exception mapping |
| `registry/services/ans_service.py` | ANS integration service | Shows httpx exception mapping conventions (`httpx.TimeoutException`, `httpx.HTTPStatusError`) |
| `docker-compose.yml` | Local deployment surface | Registry service `environment:` block gets the five new vars |
| `terraform/aws-ecs/main.tf`, `variables.tf` | Root ECS module wiring | Root variable + module input pass-through |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf`, `variables.tf` | Container env definition | Container `name/value` env entry |
| `charts/registry/values.yaml`, `templates/secret.yaml` | Helm surface | New `registrationGate:` values block and secret keys, following the `ans:` block pattern |
| `.env.example` | Documented env vars | New documented section following the ANS section format |
| `tests/unit/api/test_agent_routes.py` | Route test conventions | `test_app` fixture with `dependency_overrides`, `patch("registry.api.agent_routes.agent_service")` style |
| `tests/unit/api/test_skill_inline_content.py` | Skill route test conventions | Mock skill service pattern for `/skills` routes |

### Existing Patterns Identified
1. **Pydantic BaseSettings for configuration**: all runtime configuration lives in `registry/core/config.py` `Settings` with `env_file=".env"`, `case_sensitive=False`. Feature flags follow `<feature>_enabled: bool` with a Field description. A future implementer adds five fields there and every surface reads them from `settings`.
   - Files: `registry/core/config.py`
   - How to follow: add a clearly commented settings block; use `Field(default=..., description=...)` for new-style entries (see `ans_integration_enabled` at line 289).
2. **Outbound HTTP via httpx.AsyncClient per call**: `ans_client.py` creates `httpx.AsyncClient(timeout=settings.ans_api_timeout_seconds)` per request, calls `raise_for_status()`, and maps `httpx.TimeoutException` / `httpx.HTTPError` at the service boundary.
   - Files: `registry/services/ans_client.py` (lines ~200-290), `registry/services/ans_service.py` (lines 126-178)
   - How to follow: the gate client uses the same shape but maps every exception to a fail-closed verdict instead of degrading gracefully.
3. **Route-layer orchestration, service-layer persistence**: all seven registration/update endpoints do permission checks in the route, then call a service (`agent_service`, `server_service`, `get_skill_service()`). The gate belongs in the route layer, after permission checks and after the payload is assembled into its final shape, immediately before the first persistence call.
   - Files: the three route modules
4. **CONFIG_GROUPS dict drives the admin config API**: adding `(field, label, sensitive)` tuples to a group automatically surfaces fields in the config UI and all four export formats (env/json/tfvars/yaml).
   - Files: `registry/api/config_routes.py`
5. **Secret env keys land in the Helm secret.yaml**: sensitive values are base64-encoded into a Secret and consumed via `envFrom`, following the `ans.apiKey` / `ans.apiSecret` pattern.
   - Files: `charts/registry/templates/secret.yaml`, `charts/registry/values.yaml`

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `registry/api/agent_routes.py` | Extends | One `await check_registration_gate(...)` call in `register_agent` and `update_agent` |
| `registry/api/server_routes.py` | Extends | One gate call each in `register_service`, `internal_register_service`, `edit_server_submit` |
| `registry/api/skill_routes.py` | Extends | One gate call each in `register_skill` and `update_skill` |
| `registry/core/config.py` | Extends | Five new settings fields |
| `registry/api/config_routes.py` | Extends | New `registration_gate` config group |
| `docker-compose.yml`, Terraform, Helm, `.env.example` | Config | The five env vars on every surface |
| `tests/unit/api/`, `tests/unit/services/` | Tests | New unit tests following existing fixture patterns |

### Constraints and Limitations Discovered
- **`internal_register_service` is form-encoded**, not JSON: the gate payload is built from the parsed form fields (the `server_entry` dict), not from a raw body.
- **`register_service` builds `server_entry` incrementally**: the natural gate point is just before `server_service.register_server(server_entry)` (line 768), where the entry is complete.
- **Credential fields must not be sent to the gate**: `server_entry` can contain `auth_credential` / `auth_credential_encrypted` and the UI edit path can carry `auth_credential`. The payload builder strips them explicitly (review finding, addressed below).
- **`update_skill` and `register_skill` delegate almost everything to `SkillService`**: the gate runs in the route before calling the service, using the request model dump.
- **The security scanners already model "check then block with a reason"**, but they are async post-registration; the gate is a pre-persistence synchronous check and does not reuse that machinery.
- **Feature must be off by default**: `REGISTRATION_GATE_ENABLED=false` keeps every path byte-identical in behavior, including not constructing an httpx client.

## Architecture

### System Context Diagram

```
                    +---------------------+
                    |   Org Policy Gate    |
                    |  (external service)  |
                    |  POST /admit         |
                    +----------^----------+
                               | 200 allow / 403 deny(reason)
                               | timeout / conn error => fail-closed
+----------+        +----------+----------+         +------------+
|  Client   | -----> |  MCP Gateway Registry | ------> |  Storage   |
| (UI/API)  |        |  registration routes  |         | (repo/FAISS|
+----------+        |  +------------------+ |         |  /nginx)   |
                    |  | RegistrationGate | |         +------------+
                    |  | client (httpx)   | |
                    |  +------------------+ |
                    +-----------------------+
```

### Sequence Diagram (deny and failure cases)

```
Client            Registry route              Gate client         External gate
  |  POST /agents/register   |                    |                    |
  |------------------------->|                    |                    |
  |                          | permission checks  |                    |
  |                          | build agent_card   |                    |
  |                          |--- check_gate ---->|                    |
  |                          |                    |--- POST payload -->|
  |                          |                    |<--- 403 reason ----|
  |<--- 403 {reason} --------|<-- GateDenied -----|                    |
  |
  |  POST /agents/register (gate down)
  |------------------------->|--- check_gate ---->|--- POST (failed) ->|
  |                          |                    |<-- x exception ----|
  |<--- 503 fixed message ---|<-- GateFailure ----|                    |
```

### Component Diagram

```
registry/services/registration_gate.py
  +-- GateDecision (dataclass: allowed, reason)
  +-- check_registration_gate(asset_type, endpoint, action, payload, username) -> GateDecision
        reads settings.registration_gate_* 
        disabled  => allowed immediately (no HTTP)
        builds RegistrationGateRequest model, strips credential fields
        POST settings.registration_gate_url with auth header + timeout
        200        => allowed
        403        => denied (gate reason extracted)
        other/err  => denied (fixed reason)
```

## Data Models

### New Models (in `registry/services/registration_gate.py`)

```python
from dataclasses import dataclass

@dataclass
class GateDecision:
    """Result of an admission-control gate check.

    failure=True means the gate itself failed (timeout, unreachable,
    unexpected status, misconfiguration): routes return 503 with the
    fixed message. failure=False with allowed=False is a policy deny:
    routes return 403 with the gate's reason.
    """
    allowed: bool
    reason: str
    failure: bool = False
```

The outbound request body is a plain JSON dict (matches the gate being an external generic webhook; avoids a new public Pydantic schema in `registry/schemas/`):

```python
{
    "asset_type": "agent" | "server" | "skill",
    "path": "/agents/my-agent" | "/servers/foo" | "my-skill",
    "overwrite": true | false,   # internal register only: whether an existing server is replaced
    "endpoint": "/agents/register" | "/agents/{path}" | "/register"
              | "/internal/register" | "/edit/{service_path}"
              | "/skills" | "/skills/{name}"   # skill update sends the normalized /skills/{name} path
    "action": "register" | "update",
    "user": "<username>",
    "payload": { ...registration payload with credential-bearing fields stripped... },
}
```

`payload` scrubbing is defense-in-depth: a fixed deny-list (`auth_credential`, `auth_credential_encrypted`, `credential`, `secret`, `api_key`) plus a case-insensitive name check that drops any key containing `credential`, `password`, `secret`, or `token` (review findings B1/S1).

### Model Changes
None to existing Pydantic models. Five new fields on `Settings` (see Configuration Parameters).

## API / CLI Design

### New Endpoints / Commands
None. This change adds an outbound call inside seven existing endpoints. No new registry endpoints, no CLI changes.

### Outbound Gate Request

**Invocation (from registry):**
```
POST {REGISTRATION_GATE_URL}
Content-Type: application/json
{REGISTRATION_GATE_AUTH_HEADER}: {REGISTRATION_GATE_AUTH_TOKEN}   # only if token non-empty
```

**Expected responses:**
- `200` (any JSON body): allow. The registry proceeds with registration.
- `403` with JSON body `{"reason": "<human-readable message>"}`: deny. The registry returns HTTP 403 to its caller with `detail` containing the gate reason. A 403 body that is not JSON or lacks `reason` yields the fallback message `Registration denied by registration gate policy`.

**Error Cases (registry to its caller):**
- `503 Service Unavailable` with fixed detail `Registration gate unavailable, registration blocked (fail-closed)`: gate timeout, connection error, or a non-200/non-403 status. The same message is logged with the underlying error; it is NOT returned to the caller.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `REGISTRATION_GATE_ENABLED` | bool | `false` | No | Enable the admission-control gate on all registration/update paths |
| `REGISTRATION_GATE_URL` | str | `""` | When enabled | Full URL of the external gate webhook |
| `REGISTRATION_GATE_TIMEOUT_SECONDS` | float | `5.0` | No | Per-call HTTP timeout in seconds |
| `REGISTRATION_GATE_AUTH_HEADER` | str | `Authorization` | No | Header name used to authenticate to the gate |
| `REGISTRATION_GATE_AUTH_TOKEN` | str | `""` | No | Header value; empty string sends no auth header |

### Settings / Config Class Updates

```python
# Registration admission control gate (external policy webhook)
registration_gate_enabled: bool = Field(
    default=False,
    description="Enable external admission-control gate for registrations and updates",
)
registration_gate_url: str = Field(
    default="",
    description="URL of the external registration gate webhook",
)
registration_gate_timeout_seconds: float = Field(
    default=5.0,
    description="Timeout in seconds for registration gate HTTP calls",
)
registration_gate_auth_header: str = Field(
    default="Authorization",
    description="HTTP header name used to authenticate to the registration gate",
)
registration_gate_auth_token: str = Field(
    default="",
    description="HTTP header value used to authenticate to the registration gate",
)
```

### Deployment Surface Checklist

- [ ] `registry/core/config.py` - five Settings fields
- [ ] `.env.example` - documented block with defaults
- [ ] `docker-compose.yml` - registry service `environment:` entries
- [ ] `terraform/aws-ecs/variables.tf` - root variables
- [ ] `terraform/aws-ecs/main.tf` - module input pass-through
- [ ] `terraform/aws-ecs/modules/mcp-gateway/variables.tf` - module variables
- [ ] `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` - container env entries
- [ ] `charts/registry/values.yaml` - `registrationGate:` values block
- [ ] `charts/registry/templates/secret.yaml` - gate keys in the rendered Secret (auth token sensitive)
- [ ] `registry/api/config_routes.py` - `registration_gate` CONFIG_GROUP

## New Dependencies

This change uses only existing dependencies (`httpx` is already a runtime dependency).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Settings
**File:** `registry/core/config.py`
Add the five fields from the Configuration Parameters section, placed after the ANS block.

#### Step 2: Gate client module
**File:** `registry/services/registration_gate.py` (new)

```python
"""Registration admission control gate client.

Calls an external policy webhook before any agent, server, or skill
registration or update is persisted. Fail-closed: any gate error,
timeout, or unexpected response blocks the registration.
"""

import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from registry.core.config import settings

logger = logging.getLogger(__name__)

GATE_UNAVAILABLE_MESSAGE = "Registration gate unavailable, registration blocked (fail-closed)"
GATE_DENIED_FALLBACK_MESSAGE = "Registration denied by registration gate policy"

# Fields that must never leave the registry
_STRIPPED_PAYLOAD_KEYS = (
    "auth_credential",
    "auth_credential_encrypted",
    "credential",
    "secret",
    "api_key",
)


@dataclass
class GateDecision:
    allowed: bool
    reason: str
    failure: bool = False


def _build_gate_payload(
    asset_type: str,
    endpoint: str,
    action: str,
    payload: dict[str, Any],
    username: str | None,
    path: str | None = None,
    overwrite: bool | None = None,
) -> dict[str, Any]:
    """Build the JSON body sent to the gate, scrubbing credential fields."""
    safe_payload = _scrub_value(payload)
    body: dict[str, Any] = {
        "asset_type": asset_type,
        "endpoint": endpoint,
        "action": action,
        "user": username,
        "path": path,
        "payload": safe_payload,
    }
    if overwrite is not None:
        body["overwrite"] = overwrite
    return body


MAX_GATE_TIMEOUT_SECONDS = 30.0
MAX_REASON_LENGTH = 300


def _effective_timeout() -> float:
    """Clamp the configured timeout to a sane maximum (review finding S3)."""
    return min(settings.registration_gate_timeout_seconds, MAX_GATE_TIMEOUT_SECONDS)


def _scrub_value(value: Any) -> Any:
    """Recursively drop credential-bearing keys from dicts and lists."""
    if isinstance(value, dict):
        cleaned = {}
        for k, v in value.items():
            k_l = str(k).lower()
            if k in _STRIPPED_PAYLOAD_KEYS or any(
                marker in k_l for marker in ("credential", "password", "secret", "token")
            ):
                continue
            cleaned[k] = _scrub_value(v)
        return cleaned
    if isinstance(value, list):
        return [_scrub_value(item) for item in value]
    return value


async def check_registration_gate(
    asset_type: str,
    endpoint: str,
    action: str,
    payload: dict[str, Any],
    username: str | None = None,
    path: str | None = None,
    overwrite: bool | None = None,
) -> GateDecision:
    """Consult the external admission-control gate.

    Returns GateDecision; never raises.
    Disabled gate => allow. Failure or policy deny => deny, distinguished
    by the structural `failure` flag (review findings B2/S2).
    """
    if not settings.registration_gate_enabled:
        return GateDecision(allowed=True, reason="gate disabled")

    gate_url = settings.registration_gate_url
    if not gate_url:
        logger.error("Registration gate enabled but REGISTRATION_GATE_URL is not set")
        return GateDecision(allowed=False, reason=GATE_UNAVAILABLE_MESSAGE, failure=True)
    if not gate_url.lower().startswith(("http://", "https://")):
        logger.error(f"Registration gate URL must be http(s), got scheme from '{gate_url}'")
        return GateDecision(allowed=False, reason=GATE_UNAVAILABLE_MESSAGE, failure=True)

    body = _build_gate_payload(asset_type, endpoint, action, payload, username,
                               path=path, overwrite=overwrite)

    headers = {"Content-Type": "application/json"}
    if settings.registration_gate_auth_token:
        headers[settings.registration_gate_auth_header] = settings.registration_gate_auth_token

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_effective_timeout()) as client:
            response = await client.post(gate_url, json=body, headers=headers)
    except httpx.TimeoutException:
        logger.error(
            f"Registration gate timed out after {_effective_timeout()}s "
            f"for {asset_type} {action} from {endpoint} (gate={urlsplit(gate_url).netloc})"
        )
        return GateDecision(allowed=False, reason=GATE_UNAVAILABLE_MESSAGE, failure=True)
    except httpx.HTTPError as e:
        logger.error(
            f"Registration gate unreachable for {asset_type} {action} from {endpoint} "
            f"(gate={urlsplit(gate_url).netloc}): {e}"
        )
        return GateDecision(allowed=False, reason=GATE_UNAVAILABLE_MESSAGE, failure=True)
    duration_ms = int((time.monotonic() - started) * 1000)

    if response.status_code == 200:
        logger.info(
            f"Registration gate allowed {asset_type} {action} from {endpoint} "
            f"(user={username}, {duration_ms}ms)"
        )
        return GateDecision(allowed=True, reason="allowed")

    if response.status_code == 403:
        reason = GATE_DENIED_FALLBACK_MESSAGE
        try:
            reason = response.json().get("reason") or reason
        except Exception:
            pass
        reason = reason[:MAX_REASON_LENGTH]
        logger.warning(
            f"Registration gate denied {asset_type} {action} from {endpoint} "
            f"(user={username}, {duration_ms}ms): {reason}"
        )
        return GateDecision(allowed=False, reason=reason, failure=False)

    logger.error(
        f"Registration gate returned unexpected status {response.status_code} "
        f"for {asset_type} {action} from {endpoint} (gate={urlsplit(gate_url).netloc})"
    )
    return GateDecision(allowed=False, reason=GATE_UNAVAILABLE_MESSAGE, failure=True)
```

#### Step 3: Wire the seven call sites

Each call site uses the shared, exception-free pattern below. The deny-vs-failure distinction is structural (`decision.failure`), never a string comparison (review findings B2/S2):

```python
decision = await check_registration_gate(
    asset_type="agent",
    endpoint="/agents/register",
    action="register",
    payload=agent_card.model_dump(mode="json"),
    username=user_context["username"],
    path=path,
)
if not decision.allowed:
    if decision.failure:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=GATE_UNAVAILABLE_MESSAGE,
        )
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=decision.reason)
```

Per-route error shapes (preserve each route family's existing convention, review finding G1):

| Route family | Policy deny | Gate failure |
|--------------|-------------|--------------|
| Agent routes (register, update) | `HTTPException(403, reason)` | `HTTPException(503, GATE_UNAVAILABLE_MESSAGE)` |
| `POST /register` | `JSONResponse(403, {"error": "Registration denied", "detail": reason})` | `JSONResponse(503, {"error": "Service registration blocked", "detail": GATE_UNAVAILABLE_MESSAGE})` |
| `POST /internal/register` | `JSONResponse(403, {"error": "Registration denied", "reason": reason})` | `JSONResponse(503, {"error": "Service registration blocked", "reason": GATE_UNAVAILABLE_MESSAGE})` |
| `POST /edit/{service_path}` | JSON error body regardless of Accept header (never a redirect): `JSONResponse(403, {"error": ..., "detail": reason})` | `JSONResponse(503, ...)` same shape |
| Skill routes (register, update) | `HTTPException(403, reason)` | `HTTPException(503, GATE_UNAVAILABLE_MESSAGE)` |

Exact placement per route (all BEFORE the first persistence call, AFTER permission checks):

1. `agent_routes.register_agent` (after `agent_card` is built and validated, before `agent_service.register_agent`): payload `agent_card.model_dump(mode="json")`, endpoint `/agents/register`, action `register`, path `path`.
2. `agent_routes.update_agent` (after `updated_agent` is built and validated, before `agent_service.update_agent`): payload `updated_agent.model_dump(mode="json")`, endpoint `f"/agents/{path}"`, action `update`, path `path`.
3. `server_routes.register_service` (after `server_entry` is fully assembled, before `server_service.register_server`): payload `server_entry`, endpoint `/register`, action `register`, path `path`.
4. `server_routes.internal_register_service` (after `server_entry` assembly, before the persistence block): payload `server_entry`, endpoint `/internal/register`, path `path`; action is `"update"` when overwriting an existing server (`existing_server and overwrite`) and `"register"` otherwise, with `overwrite=overwrite` passed through (review finding B3).
5. `server_routes.edit_server_submit` (after `updated_server_entry` is assembled, before `server_service.update_server`): payload `updated_server_entry`, endpoint `f"/edit/{service_path}"`, action `update`, path `service_path`.
6. `skill_routes.register_skill` (after audit action, before `service.register_skill`): payload `request.model_dump(mode="json")` plus `owner`, endpoint `/skills`, action `register`, path `request.name`.
7. `skill_routes.update_skill` (after ownership check, before `service.update_skill`): payload `{"path": normalized_path, **updates}`, endpoint `normalized_path` (the canonical `/skills/{name}` form), action `update`, path `normalized_path`.

Return-shape per route family (superseded by the table above; agent/skill raise HTTPException, server routes return JSONResponse):
- Agent routes: `raise HTTPException(...)` (they already use HTTPException for 4xx).
- Server routes (`/register`, `/edit`): `JSONResponse(status_code=..., content={"error": ..., "detail": reason})` on deny; `JSONResponse(status_code=503, ...)` on failure; `internal/register` uses `content={"error": ..., "reason": reason}` matching its existing error shape.
- Skill routes: `raise HTTPException(...)`.

#### Step 4: Deployment surfaces
Apply the Deployment Surface Checklist: `.env.example` block, docker-compose registry env entries, Terraform variables/pass-through/container env, Helm values + secret keys, config API group.

#### Step 5: Tests
Two new test modules (see Testing Strategy), following existing fixture conventions.

### Error Handling
- The gate client never raises: every failure mode collapses into a deny `GateDecision`.
- Route call sites do a single `if not decision.allowed:` block; no try/except needed there.
- Misconfiguration (enabled but no URL) is fail-closed and logged at error level.

### Logging
- Allow: `info` with asset type, endpoint, action, user, and call duration.
- Deny: `warning` with the truncated gate reason (max 300 chars) and duration.
- Timeout / unreachable / unexpected status: `error` with asset type, endpoint, action, gate URL host, and exception detail (message stays internal; caller gets the fixed message). The auth token is never logged.
- Misconfiguration (missing or non-http gate URL): `error`.

## Observability
### Tracing / Metrics / Logging Points
- Structured log events at the four points above are the primary observability surface, consistent with how ANS integration logs.
- A future change could add counters (gate_allowed_total / gate_denied_total / gate_error_total); out of scope here.

## Scaling Considerations
- The gate adds one synchronous HTTP round-trip (bounded by the timeout, default 5s) to each registration. Registrations are low-frequency admin operations; this does not affect read or inference traffic paths.
- The httpx client is created per call (matches `ans_client.py`); connection pooling could be revisited if gate QPS ever matters.
- A slow or down gate blocks registrations (by design, fail-closed); operators should deploy the gate with HA and keep the timeout small.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `registry/services/registration_gate.py` | Gate client: GateDecision, payload builder, check_registration_gate |
| `tests/unit/services/test_registration_gate.py` | Unit tests for the gate client (allow/deny/timeout/unreachable/unexpected/disabled/misconfig/payload-strip) |
| `tests/unit/api/test_registration_gate_routes.py` | Route-level tests for the seven wired paths |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~330 | Five new settings fields |
| `registry/api/agent_routes.py` | ~505, ~1325 | Gate call in register_agent and update_agent |
| `registry/api/server_routes.py` | ~765, ~1040, ~1595 | Gate call in register_service, internal_register_service, edit_server_submit |
| `registry/api/skill_routes.py` | ~630, ~700 | Gate call in register_skill and update_skill |
| `registry/api/config_routes.py` | ~260 | `registration_gate` CONFIG_GROUP |
| `.env.example` | ~615 | Documented gate settings block |
| `docker-compose.yml` | ~180 | Registry env entries |
| `terraform/aws-ecs/variables.tf` | ~395 | Root variables |
| `terraform/aws-ecs/main.tf` | ~127 | Module pass-through |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | ~385 | Module variables |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ~700 | Container env entries |
| `charts/registry/values.yaml` | ~86 | `registrationGate:` block |
| `charts/registry/templates/secret.yaml` | ~168 | Gate keys rendering |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (gate client) | ~120 |
| Route wiring | ~120 |
| Config + surfaces | ~90 |
| New tests | ~450 |
| **Total** | **~780** |

## Testing Strategy
Full executable plan lives in `testing.md`. Summary: unit tests for the gate client covering all verdict paths and payload stripping; route-level tests for allow/deny/timeout on representative paths (agent register, agent update, server register, internal register, server edit, skill register, skill update); disabled-flag no-op tests; config-surface greps.

## Alternatives Considered

### Alternative 1: Per-asset gate flags and URLs
**Description:** Separate enable flag and URL per asset type (agent/server/skill).
**Pros / Cons:** Finer-grained rollout; more configuration surface and more ways to misconfigure fail-closed behavior.
**Why Rejected:** The requirement is a single org-level policy checkpoint; one payload field (`endpoint`) already lets one gate distinguish routes.

### Alternative 2: Middleware-level enforcement
**Description:** Implement as FastAPI middleware matching registration paths.
**Pros / Cons:** One wiring point; but payloads are not yet parsed/assembled in middleware, form vs JSON differs per route, and bypass risk is higher (a route path typo silently escapes the gate).
**Why Rejected:** Explicit in-route calls make the seven enforcement points auditable and put the gate after payload assembly.

### Alternative 3: Synchronous in-process policy plugins
**Description:** Load org policy as an in-process Python plugin instead of an HTTP webhook.
**Pros / Cons:** No network hop; couples org policy to the registry release cycle, exactly what the requirement wants to avoid.
**Why Rejected:** The requirement is explicitly an external HTTP endpoint.

### Comparison Matrix

| Criteria | Chosen (single webhook, in-route) | Alt 1 (per-asset flags) | Alt 2 (middleware) | Alt 3 (plugin) |
|----------|-----------------------------------|-------------------------|--------------------|----------------|
| Complexity | Low | Med | Med | High |
| Bypass resistance | High (explicit call sites) | High | Medium | High |
| Config surface | Small | Large | Small | Large |
| Matches requirement | Yes | Partial | Partial | No |

## Rollout Plan
- Phase 1: Implementation (this change; feature off by default).
- Phase 2: Testing (unit + route tests in CI; staging deployment with gate enabled against a stub gate).
- Phase 3: Deployment (operators set `REGISTRATION_GATE_ENABLED=true` + URL after their gate is available; rollback is flipping the flag to false).

## Open Questions
- Should gate allow/deny counters be exported to the metrics service? Deferred (Non-Goal for this change).

## References
- `registry/services/ans_client.py` - existing outbound webhook client pattern
- `registry/api/config_routes.py` - CONFIG_GROUPS mechanism
- Requirement: external admission-control webhook consulted before every registration/update (issue #809)
