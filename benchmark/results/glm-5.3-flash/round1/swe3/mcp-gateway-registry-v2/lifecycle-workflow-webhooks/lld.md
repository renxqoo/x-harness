# Low-Level Design: Lifecycle Workflow Webhooks

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (post-review revision 2)*

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
The registry must serve as the system of record for an externally orchestrated asset lifecycle (`draft -> beta -> active -> deprecated`). Two gaps block external orchestration:

1. The async post-registration security scan emits no event; consumers must poll `GET /api/servers/{path}/security-scan`.
2. There is no way to mandate the initial registration status, and no permission separates "register an asset" from "change an asset's lifecycle status" - a PATCH that flips `status` is gated by the same `modify_service` permission as any metadata edit. Outbound webhook events are also unauthenticated payloads; a forged "scan passed" event could trick an orchestrator into promoting an unsafe asset.

### Goals
- Emit a `scan_complete` webhook event on scan completion AND on scan failure for servers, agents, and skills.
- HMAC-SHA256-sign the exact transmitted body of every outbound async webhook event when a signing secret is configured; emit no signature header otherwise.
- Add `status=` filtering to the servers, agents, and skills list endpoints.
- Add `REGISTRATION_MANDATED_INITIAL_STATUS` (default off) that forces an unspecified initial status and rejects a mismatched explicit status with HTTP 400.
- Add a `modify_service_status` UI permission required additionally (on top of existing checks) when a PATCH/update touches `status`.
- Increment a webhook delivery counter and document the consumer contract (ordering, idempotency, signature verification).

### Non-Goals
- No webhook event on lifecycle transitions: the orchestrator initiates those and already knows the outcome.
- No signature over the registration gate (inbound admission control) request.
- No retry/redelivery queue: fire-and-forget delivery is unchanged.
- No `scan_complete` emission from the manual `/rescan` endpoints: the synchronous caller already sees the result.
- No mandate enforcement on federation/internal sync registration paths (see Open Questions).
- No changes to how default statuses are chosen today when no mandate is configured (servers without explicit status remain absent-then-defaulted-at-read).

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/services/webhook_service.py` | Fire-and-forget webhook sender (`send_registration_webhook`) | Extension point: signing, `scan_complete` payload, metric |
| `registry/core/config.py` | Pydantic `Settings`; webhook + gate fields live here (~line 122) | New settings: signing secret, mandated initial status |
| `registry/api/server_routes.py` | Server register (1082), internal register (1401), edit (2085), register API (3491), PUT (5421), PATCH (5586), list (540), scan helper `_perform_security_scan_on_registration` (318) | Emission points for `scan_complete`; status mandate; PATCH status permission; list `status` filter |
| `registry/api/agent_routes.py` | Agent register (669), list (929), scan helper `_perform_agent_security_scan_on_registration` (~line 95-180), PUT (1867), PATCH (2028) | Same set for agents |
| `registry/api/skill_routes.py` | Skill register (885), list (161), scan helper `_perform_skill_security_scan_on_registration` (1240), PUT (update_skill) | Same set for skills; status permission on update |
| `registry/schemas/security.py` / `agent_security.py` / `skill_security.py` | `SecurityScanResult`, `AgentSecurityScanResult`, `SkillSecurityScanResult` (all share `is_safe`, `scan_failed`, `error_message`, severity counts) | Source of `scan_complete` payload fields |
| `registry/schemas/server_update_models.py` | `SERVER_REGISTRANT_ONLY_FIELDS`, `ServerUpdateRequest`, `ServerCardPatch` (both carry `status`) | PATCH touching `status` detection |
| `registry/schemas/agent_models.py` | `AgentRegistrationRequest.status` (default `draft`), `AgentCard.status` (default `active`), `AgentCardPatch.status` | Same for agents |
| `registry/schemas/skill_models.py` | `SkillRegistrationRequest.status` (default `draft`), `SkillCard.status` | Same for skills |
| `registry/schemas/registry_card.py` | `LifecycleStatus` enum + `_validate_lifecycle_status` (returns normalized lowercase) | Single validator reused everywhere |
| `registry/auth/dependencies.py` | `user_has_ui_permission_for_service(permission, service_name, ui_permissions)`; UI permissions are free-form dicts keyed by permission name | New permission string plugs in with no schema change |
| `registry/api/server_routes.py:943` / `agent_routes.py:503` | `_check_server_permission` / `_check_agent_permission` helpers wrapping the above | Called before the new status permission check |
| `registry/observability/meters.py` | OTel counters (`_meter.create_counter`, `unit="1"`, `mcpgw_` prefix) | New `mcpgw_registry_webhook_delivery_total` counter |
| `scripts/mcp-registry-admin.json`, `scripts/registry-admins.json` | Seed scope docs with `ui_permissions` maps | Add `modify_service_status: ["all"]` |
| `docs/registration-webhooks.md` | Existing webhook consumer docs | Consumer-contract section (ordering, idempotency, signatures) |
| `.env.example`, `docker-compose*.yml`, `terraform/aws-ecs/...`, `charts/registry/...` | Deployment surfaces for existing webhook env vars | Mirror the two new variables on every surface |

### Existing Patterns Identified

1. **Fire-and-forget webhook emission**: callers wrap `send_registration_webhook(...)` in `asyncio.create_task` after persisting; the service logs but never raises.
   - Files: `server_routes.py:1380,3912,4298,5555,5723`, `agent_routes.py:903,2177,2273`, `skill_routes.py:932,1084`, `agent_batch_item_processor.py:111`.
   - Follow it: `scan_complete` emission goes through the same service and the same `asyncio.create_task` pattern, never blocking the request.
2. **Scan helper encapsulation**: each asset type has one `_perform_*_security_scan_on_registration` helper owning the whole scan lifecycle including the exception path.
   - Files: `server_routes.py:318`, `agent_routes.py:~95`, `skill_routes.py:1240`.
   - Follow it: emit `scan_complete` inside those helpers so every caller (register, re-register, PUT-with-URL-change, batch) gets the event for free.
3. **Single lifecycle validator**: `_validate_lifecycle_status` normalizes to lowercase and raises `ValueError` for unknown values.
   - File: `registry/schemas/registry_card.py:36`.
   - Follow it: reuse it for the query filter and the mandate; map `ValueError` to HTTP 400.
4. **Dual-path list pagination**: fast path (DB pagination) when no field filters, fallback (full fetch + Python filter + slice) otherwise. `has_field_filters` gates the choice.
   - Files: `server_routes.py:594-616`, `agent_routes.py:996-1014`, `skill_routes.py:184-232`.
   - Follow it: adding `status` to `has_field_filters` routes status-filtered requests down the fallback path; the filter itself applies to the raw card/entry (`.status` on the dict or model) before slicing.
5. **Permission helper check**: `_check_server_permission("modify_service", name, user_context)` raises 403 with a consistent detail.
   - Files: `server_routes.py:943`, `agent_routes.py:503`, `auth/dependencies.py:225`.
   - Follow it: a second, conditional call with `modify_service_status` only when the patch body contains `status`.
6. **OTel metric declaration**: module-scope `_meter.create_counter(name="mcpgw_*_total", unit="1")` in `registry/observability/meters.py`; call sites use `.add(1, attrs)` or the `_CounterAdapter`.
   - Follow it: declare the delivery counter there, call `.add(1, {"event_type": ..., "outcome": ...})` from the webhook service.
7. **Config field + 4 deployment surfaces**: each webhook setting appears in `config.py`, `.env.example`, three docker-compose files, terraform variables + ecs-services.tf, and the Helm values + secret template.
   - Follow it: both new settings get the full surface treatment.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `send_registration_webhook` | Extends | Gains signing, metric, and a `scan_complete`-friendly generic payload path |
| `_perform_*_security_scan_on_registration` (x3) | Uses | Emits `scan_complete` on success, unsafe result, and exception |
| `_build_status_filter` (`search_repository.py:379`) | Distinct from | That helper excludes draft/deprecated for search; the new list filter is a positive equality filter on list endpoints (different semantics, no reuse) |
| PATCH/PUT/update handlers | Depends on | `patch_dict`/`updates` key inspection to decide whether the `modify_service_status` check applies |
| `ui_permissions` scope docs | Extends | New permission key; unknown keys are ignored by old consumers, admins seeds updated |

### Constraints and Limitations Discovered
- The auth layer treats `ui_permissions` as an open dict, so the new permission needs no migration; but users whose scopes lack it will get 403 on status PATCHes the moment the code ships. Mitigation: seed-doc updates plus the compatibility rule "admins and `modify_service: [all]` holders pass" is NOT adopted - the issue explicitly wants separation, so operators must add the permission (documented in rollout). To avoid an unplanned hard cutover the check applies only to the *status* field, leaving all existing metadata flows untouched.
- `settings` is read directly inside the webhook service (module import), so tests patch `registry.services.webhook_service.settings`; signing must read the secret at send time, not import time.
- Webhook payload signing must cover the exact bytes transmitted: `httpx` `json=payload` serializes internally, so the service must serialize first (`json.dumps(..., separators=(",", ":"))` encoded UTF-8) and post `content=` instead of `json=`.
- List endpoints serve both fast and fallback pagination paths; a status filter must force the fallback path so `total_count` reflects the filtered set.
- Server records may lack `status` entirely (defaults applied at read time as "active"/"stable" in various places); the list filter must treat a missing key as non-matching unless the filter equals the documented read default ("active").

## Architecture

### System Context Diagram

```
+----------------------+        register/patch          +-------------------+
| External CI/CD       | -----------------------------> |  MCP Gateway      |
| orchestrator         | <-----(scan_complete webhook)-- |  Registry (API)   |
| (consumer)           | <-----(registration webhook)--- |                   |
+----------------------+                                 |  async YARA scan  |
        ^  verify HMAC-SHA256 over exact body bytes      +-------------------+
        |                                                       |
        +-- GET /api/{servers,agents,skills}?status=draft       v
                                                DocumentDB scan collections
```

### Sequence Diagram (scan_complete)

```
Client        Registry API            scan helper            scanner        webhook svc      consumer
  |  POST /servers/register  |                        |                 |                  |        |
  |------------------------->|  create_task(scan)     |                 |                  |        |
  |<------- 201 -------------|                        |                 |                  |        |
  |                          |----------------------->|  scan_server()  |                  |        |
  |                          |                        |---------------->|                  |        |
  |                          |                        |<-- result ------|                  |        |
  |                          |     send_registration_webhook(event_type="scan_complete",   |        |
  |                          |          outcome payload)                 |                  |        |
  |                          |                        |---------------->| sign body(HMAC)  |        |
  |                          |                        |                 |---- POST ------->|  verify sig
  |                          |                        |                 |<----- 2xx -------|  dedupe
```

Failure path: `scan_server` raises OR returns `scan_failed=True` -> helper emits `scan_complete` with `scan_failed: true`, `is_safe: false`, and `error_message`; the request that triggered registration is long since 201.

### Component Diagram

```
webhook_service.send_registration_webhook
  |-- _serialize_and_sign(body_dict) -> (bytes, headers)   [new]
  |-- _build_auth_headers()                                [existing]
  |-- _webhook_metric.add(1, {event_type, outcome})        [new]
  '-- httpx.AsyncClient.post(content=bytes, headers=...)   [changed from json=]

scan helpers (server/agent/skill)  --call-->  send_registration_webhook(event_type="scan_complete")
```

## Data Models

### New webhook payload (`scan_complete`)

Top-level envelope is unchanged; `card` is replaced by a `scan` object so consumers never mistake it for a full card:

```json
{
  "event_type": "scan_complete",
  "registration_type": "server",
  "timestamp": "2026-09-30T12:00:00.000000+00:00",
  "performed_by": null,
  "scan": {
    "path": "/my-server",
    "scan_timestamp": "2026-09-30T12:01:23.000000+00:00",
    "is_safe": false,
    "scan_failed": false,
    "error_message": null,
    "critical_issues": 1,
    "high_severity": 0,
    "medium_severity": 2,
    "low_severity": 0,
    "analyzers_used": ["yara"]
  }
}
```

For the failure path (`exception` or `scan_failed=True` result): `is_safe: false`, `scan_failed: true`, `error_message: "<exception text>"`, severity counts 0. `performed_by` is null: scans are system-initiated.

### New models

```python
class SecurityScanWebhookPayload(BaseModel):
    """Sanitized scan outcome transmitted in scan_complete webhooks."""

    path: str = Field(..., description="Registry path of the scanned asset")
    scan_timestamp: str = Field(..., description="ISO timestamp of the scan")
    is_safe: bool = Field(..., description="Overall safety assessment")
    scan_failed: bool = Field(default=False, description="True when the scan did not complete")
    error_message: str | None = Field(None, description="Error text when scan_failed is true")
    critical_issues: int = Field(default=0, ge=0)
    high_severity: int = Field(default=0, ge=0)
    medium_severity: int = Field(default=0, ge=0)
    low_severity: int = Field(default=0, ge=0)
    analyzers_used: list[str] = Field(default_factory=list)
```

Model changes: none to stored schemas. `status` fields already exist on cards, requests, and patches.

## API / CLI Design

### Modified: `GET /api/servers`, `GET /api/agents`, `GET /api/skills`

**Description:** Optional `status` query parameter filters the page to one lifecycle status.

**Invocation:**
```bash
curl -s -H "Authorization: Bearer $JWT" "http://localhost/api/servers?status=draft&limit=50"
```

**Expected Response:** unchanged envelope (`servers|agents|skills`, `total_count`, `limit`, `offset`, `has_next`), with only matching items and a filtered `total_count`.

**Error Cases:**
- 400: `status` not one of `active, beta, deprecated, draft` (validated case-insensitively; normalized to lowercase).

### Modified: `POST /api/servers/register` (+ internal + edit + register API), agent register, skill register

**Description:** When `REGISTRATION_MANDATED_INITIAL_STATUS` is set:
- request omits `status` -> stored status is the mandated value;
- request supplies `status` equal (case-insensitive) to the mandated value -> accepted;
- request supplies any other `status` -> HTTP 400, detail: `status must be 'draft' for new registrations (mandated by registry policy)`.

**Error Cases:** 400 on mismatch; 403 paths unchanged.

### Modified: `PATCH /api/servers/{path}`, `PATCH /api/agents/{path}`, `PUT /api/skills/{path}`

**Description:** When the request body sets `status` to a value different from the stored one (or sets `status` at all on a record without one), the handler additionally requires the `modify_service_status` UI permission. Ordinary metadata edits are unaffected. PUT `/api/servers/{path}` applies the same rule.

**Error Cases:** 403 with detail naming `modify_service_status`; unchanged behavior when `status` absent or equal to stored.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `REGISTRATION_WEBHOOK_SIGNING_SECRET` | string | `""` | No | HMAC-SHA256 secret for the `X-Webhook-Signature` header. Empty disables signing (no header emitted). |
| `REGISTRATION_MANDATED_INITIAL_STATUS` | string | `""` | No | When set to one of `active|beta|deprecated|draft`, mandates the initial status of every new registration. Empty disables the mandate. |

### Settings / Config Class Updates

```python
# registry/core/config.py (after registration_webhook_timeout_seconds)
registration_webhook_signing_secret: str = Field(
    default="",
    description="HMAC-SHA256 secret used to sign outbound webhook bodies (X-Webhook-Signature). Empty disables signing.",
)
registration_mandated_initial_status: str = Field(
    default="",
    description="When set (active|beta|deprecated|draft), every new registration is forced to this status; a mismatched explicit status is rejected with 400. Empty disables the mandate.",
)
```

### Deployment Surface Checklist

- [ ] `.env.example` (commented block + both variables)
- [ ] `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` (registry service env)
- [ ] `terraform/aws-ecs/variables.tf` + `terraform/aws-ecs/modules/mcp-gateway/variables.tf` + `modules/mcp-gateway/ecs-services.tf` (registry env block)
- [ ] `charts/registry/values.yaml` + `charts/registry/templates/secret.yaml` (secretKeyRef style, secret not logged)
- [ ] `docs/configuration.md` table (if present) and `docs/registration-webhooks.md`

## New Dependencies

This change uses only existing dependencies (`hmac`/`hashlib` stdlib, `httpx`, `opentelemetry`).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Config fields
**File:** `registry/core/config.py` (~line 135, after webhook timeout field). Add the two fields shown above.

#### Step 2: Webhook service: signing, metric, scan_complete
**File:** `registry/services/webhook_service.py`

```python
import hashlib
import hmac
import json

def _sign_body(body: bytes, secret: str) -> str:
    """Hex HMAC-SHA256 over the exact transmitted body bytes."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def _serialize_payload(payload: dict) -> bytes:
    """Stable JSON serialization; this exact byte string is what gets signed and sent."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
```

Inside `send_registration_webhook`, replace `json=payload` with:

```python
body_bytes = _serialize_payload(payload)
headers["Content-Type"] = "application/json"
secret = settings.registration_webhook_signing_secret
if secret:
    headers["X-Webhook-Signature"] = f"sha256={_sign_body(body_bytes, secret)}"
```

and post `content=body_bytes`. Add a new public function:

```python
async def send_scan_complete_webhook(
    registration_type: str,
    scan_payload: dict,
) -> None:
    """Fire-and-forget scan_complete event.

    PAYLOAD INVARIANT (security): scan_payload must be built field-by-field
    from the whitelisted keys below. NEVER pass the scan result model dump:
    raw_output and credential-derived headers must be structurally excluded,
    not stripped after the fact.
    """
    payload = {
        "event_type": "scan_complete",
        "registration_type": registration_type,
        "timestamp": datetime.now(UTC).isoformat(),
        "performed_by": None,  # scans are system-initiated
        "scan": scan_payload,
    }
    await _post_webhook(payload)
```

Refactor the shared post-and-log body into one `_post_webhook(payload: dict) -> None` helper (MANDATORY, not optional): it is the only code that touches httpx, the signing header, and the metric. Both public functions reduce to payload construction plus a call to it. Metric attribute contract (normative, single source of truth): `event_type` in {`registration`, `update`, `deletion`, `scan_complete`}, `outcome` in {`sent` (2xx response), `failed` (non-2xx or exception)}. A disabled webhook (URL unset) returns before the counter is touched, so no other outcome value exists.

#### Step 3: Metric declaration
**File:** `registry/observability/meters.py` (Path-2 section, after `health_check_total`):

```python
webhook_delivery_total = _meter.create_counter(
    name="mcpgw_registry_webhook_delivery_total",
    description="Outbound registration/scan_complete webhook deliveries",
    unit="1",
)
```

Attribute values (normative): `event_type` in {`registration`, `update`, `deletion`, `scan_complete`}, `outcome` in {`sent`, `failed`}. No other label values are defined; a disabled webhook never increments the counter.

#### Step 4: Server scan helper emits scan_complete
**File:** `registry/api/server_routes.py`, `_perform_security_scan_on_registration` (line 318). Capture `scan_failed`/`error` state through the existing branches:

```python
from ..services.webhook_service import send_scan_complete_webhook
from ..schemas.security import SecurityScanResult  # already imported types reused

async def _emit_scan_complete(registration_type, path, result=None, failed=False, error=None):
    if failed or (result is not None and result.scan_failed):
        scan_payload = {"path": path, "scan_timestamp": datetime.now(UTC).isoformat(),
                        "is_safe": False, "scan_failed": True,
                        "error_message": error or (result.error_message if result else None)}
    else:
        scan_payload = {"path": path, "scan_timestamp": result.scan_timestamp,
                        "is_safe": result.is_safe, "scan_failed": False, "error_message": None,
                        "critical_issues": result.critical_issues, "high_severity": result.high_severity,
                        "medium_severity": result.medium_severity, "low_severity": result.low_severity,
                        "analyzers_used": result.analyzers_used}
    await send_scan_complete_webhook(registration_type, scan_payload)
```

Call it (a) after a successful `scan_server` return (with the result), and (b) in the `except Exception as e` branch with `failed=True, error=str(e)`. Emission is wrapped in `try/except` and never raises. Note the payload intentionally omits `raw_output` and credential-bearing fields.

#### Step 5: Agent and skill scan helpers
**Files:** `registry/api/agent_routes.py` (`_perform_agent_security_scan_on_registration`, both the result branch and the `except` at the end), `registry/api/skill_routes.py` (`_perform_skill_security_scan_on_registration`, result branch and its `except` at line ~1296). Same two-call pattern; agent/skill result models carry the same fields used above (`agent_security.py:39`, `skill_security.py:28`). The skill helper's `performed_by` stays null.

#### Step 6: status= filter on list endpoints
**Files:** `server_routes.py:get_servers_json` (540), `agent_routes.py:list_agents` (929), `skill_routes.py:list_skills` (161).

Add `status: str | None = Query(None, description="Filter by lifecycle status (active, beta, deprecated, draft)")`. Normalize+validate once at the top:

```python
if status is not None:
    try:
        status = _validate_lifecycle_status(status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

Set `has_field_filters = bool(query or status)` (servers; agents adds it to the existing `or`; skills `bool(tag or not include_disabled or status)`), forcing the fallback path. In the fallback loop, skip non-matching items: servers `server_info.get("status")` compared with missing-key treated as `"active"` (documented list default at `server_routes.py:723`); agents `agent.status`; skills `s.status` before the SkillInfo projection (the service already passes `status` through; filter on the raw `SkillCard`/dict from `list_skills_for_user`). Fast path stays untouched because a status filter always sets `has_field_filters`.

#### Step 7: Mandated initial status
**File:** `registry/api/server_routes.py` and `agent_routes.py`, `skill_routes.py` (register paths only).

```python
def _apply_mandated_initial_status(status: str | None) -> str:
    """Enforce REGISTRATION_MANDATED_INITIAL_STATUS; raises 400 on mismatch."""
    mandated = (settings.registration_mandated_initial_status or "").strip().lower()
    if not mandated:
        return status or ""
    try:
        mandated = _validate_lifecycle_status(mandated)
    except ValueError:
        logger.error(f"Invalid REGISTRATION_MANDATED_INITIAL_STATUS: {mandated!r}; mandate ignored")
        return status or ""
    if status is None or not status.strip():
        return mandated
    try:
        normalized = _validate_lifecycle_status(status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if normalized != mandated:
        raise HTTPException(
            status_code=400,
            detail=f"status must be '{mandated}' for new registrations (mandated by registry policy)",
        )
    return normalized
```

Place the call immediately before the handler builds its entry/model:
- servers: all four register paths (`register_service` 1082 before `if service_status:` at 1296, `internal_register_service` 1401, `edit_server_submit` 2085 before 2291, `register_service_api` 3491 which has `status: Form()`). The mandate applies to NEW registrations only: `edit_server_submit` and `register_service_api` overwrite an existing entry - apply the check only when the path is NOT already registered (overwrite=false/new path); simplest correct rule: enforce when creating, skip when `overwrite` path detected via `server_service.get_server_info(path)` already being loaded. Where the existing record is already fetched (edit), compare against the old status instead.
- agents: `register_agent` (669) before `AgentCard(status=request.status...)` at 790.
- skills: `register_skill` (885) before `service.register_skill`. **Model change (review finding 2):** `SkillRegistrationRequest.status` becomes `status: str | None = None` so "omitted" is distinguishable from "explicit draft". `skill_service.register_skill` (line ~1231 `status=request.status`) is changed to `status=request.status or "draft"`, which preserves today's stored value and every existing client's behaviour byte-for-byte. The handler then calls `_apply_mandated_initial_status(request.status)` exactly like the other asset types: omitted -> forced to the mandate; explicit mismatch -> 400.

#### Step 8: modify_service_status permission
**Files:** `server_routes.py` (PATCH 5586 + PUT 5421), `agent_routes.py` (PATCH 2028; PUT 1867 uses full-card replace - apply when `request.status != existing_agent.status`), `skill_routes.py` (`update_skill`, when `updates.get("status") != existing.status`).

```python
def _require_status_change_permission(asset_name: str, user_context: dict) -> None:
    from ..auth.dependencies import user_has_ui_permission_for_service
    if not user_has_ui_permission_for_service(
        "modify_service_status", asset_name, user_context.get("ui_permissions", {})
    ):
        raise HTTPException(
            status_code=403,
            detail=f"You do not have permission to change lifecycle status for {asset_name} "
                   f"(requires modify_service_status)",
        )
```

- servers PATCH: after `_check_server_permission("modify_service", ...)` and after `patch_dict` is built: `if "status" in patch_dict and patch_dict["status"] != existing.get("status"): _require_status_change_permission(existing.get("server_name", path), user_context)`. Same pattern in PUT with the request body.
- agents PATCH: `patch_dict` is available after merge start; check `"status" in patch_dict and patch_dict["status"] != existing_agent.status`.
- skills update: `updates = request.model_dump(exclude_unset=True, ...)`; check `"status" in updates and updates["status"] != existing.status`. `exclude_unset` makes omitted-status PUTs pass without the permission.

#### Step 8.5: Consumer-contract docs content (security normative)
**File:** `docs/registration-webhooks.md`. The verification section MUST include this complete snippet (review finding 3):

```python
import hashlib, hmac

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    if not header.startswith("sha256="):
        return False  # malformed: reject before comparing
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header.removeprefix("sha256="), expected)
```

Raw body bytes as received (not re-serialized JSON) must be hashed. Rollout posture: consumers verify-if-present while the registry fleet rolls, then require the header once the cut-over completes; events failing verification are dropped, never acted on.

#### Step 9: Seed scope docs

`_require_status_change_permission` is defined ONCE (in `server_routes.py`, next to `_check_server_permission`) and imported by agent and skill routes, so the 403 detail string cannot drift across the three surfaces (review finding from SMTS).

**Files:** `scripts/mcp-registry-admin.json`, `scripts/registry-admins.json`: add `"modify_service_status": ["all"]` next to `modify_service`.

#### Step 10: Docs
**File:** `docs/registration-webhooks.md`: extend the events table with `scan_complete` + payload sample; new "Consumer Contract" section (ordering, idempotency, signature verification snippet with `hmac.compare_digest`); document both new env vars; note the retry posture. Also add the new permission to `docs/scopes.md` UI scope example.

### Error Handling
- Webhook failures (signing included) never propagate: same WARNING-log discipline as today; metric records `failed`.
- Mandate misconfiguration (invalid mandated value) logs an ERROR once per request path and degrades to no-mandate rather than blocking all registrations.
- Status filter with unknown value -> 400 before any data fetch.

### Logging
- `scan_complete` emission: INFO `Scan complete webhook queued: type=server, path=/x, is_safe=true, failed=false`.
- Signing active: DEBUG `Signing webhook body (event=registration)`.
- Mandate enforcement: INFO on forced status, WARNING on rejected mismatch.

## Observability
### Tracing / Metrics / Logging Points
- `mcpgw_registry_webhook_delivery_total{event_type,outcome}` per attempt (see Step 3).
- Existing INFO logs in `send_registration_webhook` preserved and reused by `send_scan_complete_webhook` via the shared `_post_webhook` helper.

## Scaling Considerations
- No new synchronous work on the request path; both new emissions are inside existing fire-and-forget tasks.
- Signing cost is O(body) SHA-256 per event, negligible at registry event rates.
- The status filter forces the fallback (full-scan) list path; acceptable because the other field filters already do, and review queues are small. Fast path remains for unfiltered dashboard traffic.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| none | All changes extend existing modules per repo conventions |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~135 | 2 new settings fields |
| `registry/services/webhook_service.py` | whole file | signing helper, `_serialize_payload`, shared `_post_webhook`, `send_scan_complete_webhook`, metric increments |
| `registry/observability/meters.py` | ~180 | `webhook_delivery_total` counter |
| `registry/api/server_routes.py` | 318-405, 540+, 1296, 2291, 3491+, 5421+, 5586+ | scan helper emission; list filter; mandate at 4 register paths; status permission on PUT/PATCH |
| `registry/api/agent_routes.py` | 95-180, 929+, 669+, 1867+, 2028+ | scan helper emission; list filter; mandate; status permission |
| `registry/api/skill_routes.py` | 1240-1306, 161+, 885+, update_skill | scan helper emission; list filter; mandate; status permission |
| `scripts/mcp-registry-admin.json` | ui_permissions | `modify_service_status: ["all"]` |
| `scripts/registry-admins.json` | ui_permissions | `modify_service_status: ["all"]` |
| `.env.example` | ~221 | 2 new variables + comments |
| `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` | registry env | 2 new env passthroughs |
| `terraform/aws-ecs/variables.tf` + `modules/mcp-gateway/{variables.tf,ecs-services.tf}` | vars + env | 2 new variables + registry env entries |
| `charts/registry/values.yaml` + `templates/secret.yaml` | values + secret | 2 new keys + env wiring |
| `docs/registration-webhooks.md` | new section | scan_complete payload, consumer contract, signing |
| `docs/scopes.md` | ~82 | permission example line |
| `tests/unit/services/test_webhook_service.py` | new tests | signing + scan_complete + metric |
| `tests/unit/api/test_server_routes_patch.py` | new tests | status permission 403/allow |
| `tests/unit/test_lifecycle_status.py` | new tests | mandate helper |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~260 |
| New tests | ~180 |
| Modified code | ~90 |
| Config/docs | ~120 |
| **Total** | **~650** |

## Testing Strategy
See `./testing.md` for the full executable plan (functional curl, backwards-compat, UX, deployment surfaces, E2E lifecycle).

## Alternatives Considered

### Alternative 1: Reuse `_build_status_filter` (draft/deprecated exclusion) for the list filter
**Description:** Express `?status=` as include/exclude booleans over the existing search filter builder.
**Pros / Cons:** Reuses code; but semantics differ (positive single-status equality vs exclusion flags), and list endpoints do not currently route through the search repository filter.
**Why Rejected:** Wrong shape; a dedicated equality filter is clearer and keeps the search path untouched.

### Alternative 2: Sign with a timestamped signature (`sha256=<hex>, t=<ts>`) including an anti-replay window
**Description:** GitHub-style signed+timestamped header.
**Pros / Cons:** Replay protection; requires clock-skew handling and more consumer code.
**Why Rejected:** Consumers already deduplicate by event id/timestamp; replay of an old scan outcome is idempotent for the orchestrator. Complexity not justified now; the header format leaves room to add `t=` later without breaking the first version.

### Alternative 3: Emit scan_complete via the existing `card` field with `event_type: "scan_complete"`
**Description:** Same envelope, scan result stuffed into `card`.
**Pros / Cons:** Zero envelope change; consumers may blindly treat `card` as a full asset card and corrupt their mirror.
**Why Rejected:** A distinct `scan` object makes the contract unambiguous.

### Comparison Matrix

| Criteria | Chosen | Alt 1 | Alt 2 | Alt 3 |
|----------|--------|-------|-------|-------|
| Complexity | Low | Med | High | Low |
| Consumer safety | High | Med | High | Low |
| Replay resistance | Basic | Basic | Strong | Basic |
| Diff size | Small | Med | Med | Smallest |

## Rollout Plan
- Phase 1: Implementation (this patch).
- Phase 2: Testing per `testing.md` (unit + route-level; no execution in this skill run).
- Phase 3: Deployment - set `REGISTRATION_WEBHOOK_SIGNING_SECRET` on the registry service and the consumer together (rotation = change both, events during the window fail verification and are dropped by consumers, which is safe: consumers must not fail closed on missing/invalid signatures for non-scan_complete events if they prefer availability). Grant `modify_service_status` to admin scopes via the updated seed docs, then optionally set `REGISTRATION_MANDATED_INITIAL_STATUS=draft`.

## Open Questions
- Should the mandate also apply to federation peer-sync registration? Deferred: peer sync is bulk and status comes from the source registry (Non-Goal for this issue).
- Should `scan_complete` also fire from `/rescan`? Deferred to keep the event strictly "registration pipeline outcome".

## References
- `docs/registration-webhooks.md` (existing webhook contract, issue #742)
- `registry/schemas/registry_card.py` `LifecycleStatus`
- GitHub webhook signature scheme (`X-Hub-Signature-256`) as prior art
