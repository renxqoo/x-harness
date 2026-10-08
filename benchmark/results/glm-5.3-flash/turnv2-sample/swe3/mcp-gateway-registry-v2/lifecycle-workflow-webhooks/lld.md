# Low-Level Design: Externally Orchestrated Asset Lifecycles (scan_complete webhook, HMAC signing, status filter, mandated initial status, lifecycle-change permission)

*Created: 2026-09-29*
*Author: Claude (glm-5.3-flash run)*
*Status: Draft (revised after expert review, Step 7.5)*

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
An external orchestrator (enterprise CI/CD pipeline + admin review queue) needs the registry to act as the system of record for an asset lifecycle (draft -> beta -> active -> deprecated) that is orchestrated OUTSIDE the registry. Gaps:

1. The async security scan that runs after registration emits no event; consumers must poll `GET /api/servers/{path}/security-scan`. The failure path is invisible to consumers.
2. Outbound webhooks carry no integrity protection: a forged "scan passed" event could trick an orchestrator into promoting an unsafe asset.
3. There is no `status=` list filter, so an admin review queue cannot be pulled directly.
4. There is no way to mandate the initial registration status, and no permission separating "register" from "change lifecycle status" (PATCH gates status changes under `modify_service`).

### Goals
- `scan_complete` webhook event on every registration-triggered scan (servers, agents, skills), including the exception/failure path.
- HMAC-SHA256 signature header over the exact transmitted body on ALL outbound webhook events, keyed by a configurable secret; unsigned when unset.
- `event_id` (UUID) on every webhook envelope for consumer idempotency.
- `status=` filter on GET /servers, /agents, /skills with 400 on invalid values.
- `LIFECYCLE_INITIAL_STATUS` config flag (default off): forces unspecified status, rejects mismatched explicit status with 400.
- `change_asset_status` UI permission, additionally required by server PATCH, agent PATCH, and skill PUT only when the write changes `status`.
- Webhook send counter metric with bounded attributes.
- Consumer-contract docs: ordering, idempotency, signature verification.

### Non-Goals
- No webhook event on lifecycle transitions themselves (orchestrator already knows).
- No automatic status transitions driven by scan results.
- No webhook retries / guaranteed delivery / DLQ (fire-and-forget unchanged).
- No signature rotation (single secret).
- No `scan_complete` from the synchronous manual `/rescan` endpoints.
- No frontend changes.
- No migration of stored card status values.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/services/webhook_service.py` | Fire-and-forget outbound webhook sender | Core file: add HMAC signing, `event_id`, `scan_complete` sender, metric |
| `registry/api/server_routes.py` | Server registration/PATCH/list/scan endpoints (~5830 lines) | Scan-wrapper webhook hook, PATCH permission gate, `status=` filter, initial-status enforcement |
| `registry/api/agent_routes.py` | Agent registration/PATCH/list/scan endpoints | Same changes for agents |
| `registry/api/skill_routes.py` | Skill registration/PUT/list/scan endpoints | Same changes for skills |
| `registry/core/config.py` | Pydantic Settings | Add 2 new settings |
| `registry/schemas/registry_card.py` | `LifecycleStatus` enum + `_validate_lifecycle_status` helper | Reuse for filter validation and initial-status policy |
| `registry/schemas/server_update_models.py` | `ServerCardPatch` (RFC 7396 body) | Detect `status` in patch for permission gate |
| `registry/schemas/agent_models.py` | `AgentCard`, `AgentCardPatch`, `AgentRegistrationRequest` | Status detection for agent PATCH; request defaults `status="draft"` |
| `registry/schemas/agent_security.py` / `skill_security.py` | Scan result models (`scan_failed`, `error_message`) | Source of scan outcome fields |
| `registry/observability/meters.py` | OTel counter declarations | Add webhook send counter |
| `auth_server/scopes.yml` | Seed scope/permission config | Add `change_asset_status` to admin scopes |
| `docs/registration-webhooks.md` | Webhook consumer docs | Extend with signing + scan_complete + contract section |
| Deployment surfaces: `.env.example`, `docker-compose*.yml`, `terraform/aws-ecs/`, `charts/registry/` | Config plumbing | Wire the 2 new settings everywhere |

### Existing Patterns Identified
1. **Fire-and-forget webhooks**: `send_registration_webhook(event_type, registration_type, card_data, performed_by)` invoked via `asyncio.create_task(...)` after persistence. Never raises. Call sites in all three route files.
2. **Registration scan wrappers**: `_perform_security_scan_on_registration` (server_routes.py:318), `_perform_agent_security_scan_on_registration` (agent_routes.py:87), `_perform_skill_security_scan_on_registration` (skill_routes.py:1240) - all swallow exceptions, non-fatal.
3. **Dual-path list pagination**: unrestricted users without field filters take a DB-level fast path; any field filter (`query`, `enabled_only`, `visibility`, `tag`...) forces the full-fetch + Python-filter fallback. A `status` filter must join `has_field_filters`.
4. **UI permission checks**: `user_has_ui_permission_for_service(permission, name, ui_permissions)` from `registry/auth/dependencies.py`; wrappers `_check_server_permission` (server_routes.py:943) and `_check_agent_permission` (agent_routes.py:503).
5. **Settings**: pydantic-settings `Settings` in `registry/core/config.py`, env-driven by field name; UI config page groups in `config_routes.py`; deployment wiring in compose/Terraform/Helm.
6. **OTel metrics**: instruments declared at module scope in `registry/observability/meters.py`; invoked via `counter.add(1, attrs)` with bounded attribute values.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `webhook_service.send_registration_webhook` | Extends | Add signing + `event_id` + metric inside the single send path |
| Scan wrappers (3 route files) | Extends | Emit `scan_complete` in success AND exception paths |
| `server_routes.patch_server_endpoint` | Extends | Extra permission check when `patch_dict` contains `status` and it differs |
| `agent_routes.patch_agent` | Extends | Same, comparing `patch_dict["status"]` vs stored |
| `skill_routes.update_skill` | Extends | Same, comparing updates vs stored |
| Server/agent/skill registration handlers | Extends | Apply `LIFECYCLE_INITIAL_STATUS` policy after body validation |
| List endpoints (3) | Extends | New `status` query param + filter in fallback path |
| `auth_server/scopes.yml` | Extends | New permission key on admin scopes |

### Constraints and Limitations Discovered
- `ServerCardPatch` has `extra="forbid"`; `status` is already patchable (server_update_models.py:233), so only the handler gate is new.
- Agent/skill registration request models default `status` to `"draft"`; the server form field `service_status` defaults to `None`. "Unspecified" therefore means `exclude_unset` presence detection per asset type.
- The skill list endpoint fast path builds `SkillInfo` from DB cards; the filter must run on the card's `status` in both paths.
- `_validate_lifecycle_status` normalizes to lowercase and raises `ValueError` on unknown values - reuse for 400s.
- The webhook body is currently produced by `httpx` via `json=payload`; for an exact-bytes signature we must serialize ourselves and post `content=` with the same bytes.

## Architecture

### System Context Diagram
```
                    (orchestrates OUTSIDE the registry)
  CI/CD pipeline  ---- PATCH status (needs change_asset_status) ---> Registry
  Admin queue     ---- GET /api/{servers,agents,skills}?status= ---> Registry
        ^                                                              |
        | scan_complete webhook (HMAC-signed)                          | async scan
        | registration/deletion/update webhooks (HMAC-signed)          v
  External webhook consumer  <------------------------------------ Registry
```

### Sequence Diagram
```
Client        Registry API                Scanner            Webhook consumer
  |--POST /servers/register---->|
  |                             |-- enforce LIFECYCLE_INITIAL_STATUS
  |                             |-- persist card
  |<--201-----------------------|
  |                             |-- create_task(scan wrapper)
  |                             |      |-- scan_server() -->|
  |                             |      |<--- result/fail----|
  |                             |      |-- send_registration_webhook(
  |                             |      |      event_type="scan_complete",
  |                             |      |      scan_data={...})
  |                             |      |      * serialize payload bytes
  |                             |      |      * HMAC-SHA256(body, secret)
  |                             |      |      * POST content=body
  |                             |      |        X-Registry-Signature
  |                             |      |      * counter.add(outcome) ------>|
```

### Component Diagram
```
webhook_service.py
  +-- send_registration_webhook(event_type, registration_type, card_data, performed_by, scan_data=None)
        +-- _build_payload()      (adds event_id, scan_data when present)
        +-- _serialize_body()     (json.dumps -> bytes; exact bytes signed AND sent)
        +-- _sign_body()          (hmac-sha256, "sha256=<hex>")
        +-- _build_auth_headers()
        +-- httpx POST (fire-and-forget, unchanged failure semantics)
        +-- webhook_send_total.add(1, {event_type, outcome})
```

## Data Models

### Webhook Envelope (existing fields kept, new fields added)
```python
payload = {
    "event_id": str(uuid4()),          # NEW - consumer idempotency key
    "event_type": "registration" | "deletion" | "update" | "scan_complete",
    "registration_type": "server" | "agent" | "skill",
    "timestamp": datetime.now(UTC).isoformat(),
    "performed_by": performed_by,       # None for scan_complete
    "card": sanitize_payload(card_data),
    "scan": scan_data,                  # NEW - present only for scan_complete
}
```

### scan_data sub-payload
```python
scan_data = {
    "path": str,                 # asset path (e.g. /my-server)
    "name": str | None,          # display name if available
    "is_safe": bool,             # False on the failure path
    "scan_failed": bool,         # True when the scanner itself errored/timed out
    "error_message": str | None,
    "critical_issues": int,
    "high_severity": int,
    "medium_severity": int,
    "low_severity": int,
    "scan_timestamp": str,       # ISO 8601
    "analyzers_used": list[str],
}
```
Deliberately excludes `raw_output` (large) to keep the payload bounded.

### Signature header
```
X-Registry-Signature: sha256=<hexdigest>
```
Computed as `hmac.new(secret.encode(), body_bytes, hashlib.sha256).hexdigest()` where `body_bytes` is the exact request body. No header when `registration_webhook_signing_secret` is empty/unset.

### Model Changes
No persisted-card schema changes. `ServerCardPatch.status` / `AgentCardPatch.status` / skill PUT `status` already exist; handlers read the `exclude_unset` output to detect status-touching writes.

## API / CLI Design

### Modified Endpoints

**GET /api/servers?status=draft** (also /api/agents, /api/skills)

**Query parameter:**
- `status: str | None` - optional lifecycle filter. Validated case-insensitively against `{active, beta, draft, deprecated}` via `_validate_lifecycle_status`; 400 with `Invalid status '...'. Allowed values: active, beta, deprecated, draft` on mismatch.

**Response:** unchanged shape; filtered result set; `total_count` reflects the filtered set. `status` counts as a field filter (forces the fallback pagination path) so `total_count` stays accurate.

**Error cases:**
- 400: unknown `status` value.

**PATCH /api/servers/{path}** (and PATCH /api/agents/{path}, PUT /api/skills/{path})
- New behavior: if the write touches `status` AND the new value differs from the stored value, the caller must additionally hold the `change_asset_status` UI permission (admins bypass), else 403:
  `"Changing the lifecycle status requires the 'change_asset_status' permission"`.
- Writes that omit `status`, or that send an identical value, are unchanged (no new permission).

**POST /api/servers/register, /api/agents/register, /api/skills, /api/internal/register**
- When `LIFECYCLE_INITIAL_STATUS` is set (non-empty):
  - no explicit status supplied -> forced to the configured value;
  - explicit status != configured value (case-insensitive) -> 400 `"status must be '<configured>' when LIFECYCLE_INITIAL_STATUS is set (got '<supplied>')"`.
- Unset -> behavior identical to today.
- Scope note: the mandate applies to REGISTRATION only. The server edit-form path (`edit_server_submit`) is an edit, not a registration - it gets the `change_asset_status` permission gate but NOT `resolve_initial_status`.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `REGISTRATION_WEBHOOK_SIGNING_SECRET` | string | `""` | No | HMAC-SHA256 secret for the `X-Registry-Signature` header. Empty = unsigned (today's behavior). Recommend 32+ random bytes; a WARNING logs at startup below 16 characters. |
| `LIFECYCLE_INITIAL_STATUS` | string | `""` | No | When set to one of `active|beta|draft|deprecated`, every registration is forced to this initial status; explicit mismatched statuses are rejected with 400. Empty = off. |

### Settings / Config Class Updates
```python
registration_webhook_signing_secret: str = Field(
    default="",
    description="HMAC-SHA256 secret used to sign outbound webhook bodies (X-Registry-Signature header). Empty disables signing.",
)
lifecycle_initial_status: str = Field(
    default="",
    description="Mandated initial lifecycle status for registrations (active|beta|draft|deprecated). Empty disables the mandate.",
)

@field_validator("lifecycle_initial_status")
@classmethod
def _validate_lifecycle_initial_status(cls, v: str) -> str:
    if not v:
        return v
    return _validate_lifecycle_status(v)   # raises ValueError -> startup validation error
```

### Deployment Surface Checklist
- [ ] `.env.example` - both variables with comments
- [ ] `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` - registry service env
- [ ] `terraform/aws-ecs/variables.tf` - two new variables
- [ ] `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` - two container env entries (registry task)
- [ ] `charts/registry/values.yaml` - `registrationWebhookSigningSecret`, `lifecycleInitialStatus`
- [ ] `charts/registry/templates/secret.yaml` - both env keys, following the same guarded `{{- if }}` pattern used for `REGISTRATION_WEBHOOK_AUTH_TOKEN` (the signing secret is as sensitive as the auth token)
- [ ] Terraform docs note: source the signing secret from AWS Secrets Manager, not plaintext tfvars (same guidance as the existing auth token)
- [ ] `registry/api/config_routes.py` - add both fields to the `registration_webhook` UI config group (secret masked `True`); group title becomes "Registration Webhook (Notifications & Signing)"

## New Dependencies

This change uses only existing dependencies (`hmac`, `hashlib`, `uuid` are stdlib; `httpx` and OpenTelemetry are already imported).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Config settings
**File:** `registry/core/config.py`
Add the two fields + the `lifecycle_initial_status` validator (import `_validate_lifecycle_status` from `registry.schemas.registry_card`; import inside the validator to avoid import cycles).

#### Step 2: Webhook service - signing, event_id, scan_complete, metric
**File:** `registry/services/webhook_service.py`

```python
import hashlib
import hmac
import json
from uuid import uuid4

SIGNATURE_HEADER = "X-Registry-Signature"

def _serialize_body(payload: dict) -> bytes:
    return json.dumps(payload, default=str).encode("utf-8")

def _sign_body(body: bytes) -> str | None:
    secret = settings.registration_webhook_signing_secret
    if not secret:
        return None
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"
```

Rewrite the send path so the exact bytes that are signed are the bytes transmitted:
```python
payload = {..., "event_id": str(uuid4())}
if scan_data is not None:
    payload["scan"] = scan_data
body = _serialize_body(payload)
headers = _build_auth_headers()
headers["Content-Type"] = "application/json"
signature = _sign_body(body)
if signature:
    headers[SIGNATURE_HEADER] = signature
response = await client.post(webhook_url, content=body, headers=headers)
```
Increment the metric on every attempt (success and failure) with `{"event_type": event_type, "outcome": "sent" | "failed"}` (declare `webhook_send_total` in `registry/observability/meters.py` as `mcpgw_registry_webhook_send_total`).

Add two small public helpers so the three route files stay one-line changes:
```python
async def send_scan_complete_webhook(registration_type: str, card_data: dict, scan_data: dict) -> None:
    await send_registration_webhook(
        event_type="scan_complete",
        registration_type=registration_type,
        card_data=card_data,
        performed_by=None,
        scan_data=scan_data,
    )

def build_scan_data(result, path: str, name: str | None = None) -> dict:
    """Normalize a scan result into the scan sub-payload.

    Accepts any of registry.schemas.security.SecurityScanResult,
    registry.schemas.agent_security.AgentSecurityScanResult, or
    registry.schemas.skill_security.SkillSecurityScanResult - the three
    models share field names, so getattr-with-defaults covers all of them
    (and a partially-built failure object). Never raises.
    """
```

#### Step 3: Emit scan_complete from the three scan wrappers
**Files:** `registry/api/server_routes.py`, `registry/api/agent_routes.py`, `registry/api/skill_routes.py`

Each wrapper gains, in BOTH the success path and the exception path (after the existing handling, never raising):
```python
from ..services.webhook_service import send_scan_complete_webhook, build_scan_data
asyncio.create_task(
    send_scan_complete_webhook(
        registration_type="server",             # or agent / skill
        card_data=server_entry,                 # or agent_card_dict / skill.model_dump(mode="json")
        scan_data=build_scan_data(scan_result, path, name),
    )
)
```
On the exception paths (where no result object exists) build the dict inline:
`{"path": path, "name": <name-or-None>, "is_safe": False, "scan_failed": True, "error_message": str(e), "critical_issues": 0, ..., "scan_timestamp": <now iso>, "analyzers_used": []}`.

#### Step 4: status= filter on the three list endpoints
**Files:** the three route files.

Common helper in `registry/api/endpoint_utils.py` (the shared API-helpers module that already provides `get_endpoint_url`; keeps route files from importing each other):
```python
def resolve_status_filter(status: str | None) -> str | None:
    if status is None:
        return None
    try:
        return _validate_lifecycle_status(status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

- **servers** (`get_servers_json`): add `status` query param; `has_field_filters = bool(query or status)`; in the card loop `if status_filter and (server_info.get("status") or "active") != status_filter: continue`. (Stored status defaults to `active` when absent - consistent with the list response field at server_routes.py:723.)
- **agents** (`list_agents`): add param; `has_field_filters` gains `bool(status)`; loop filter `agent_status = getattr(agent, "status", None) or "active"`.
- **skills** (`list_skills`): add param; `has_field_filters` gains `bool(status)`; filter the fast path on `s.status` before building `SkillInfo`, and filter the fallback list after `list_skills_for_user` and before the pagination slice.

#### Step 5: LIFECYCLE_INITIAL_STATUS enforcement at registration
**File:** helper in `registry/schemas/registry_card.py` next to the enum:
```python
def resolve_initial_status(supplied: str | None) -> str:
    """Apply the LIFECYCLE_INITIAL_STATUS mandate. Returns the status to store.

    Raises ValueError on an explicit mismatch (routes turn it into a 400).
    """
    from ..core.config import settings   # lazy: avoid config->schemas cycle at import time

    mandated = (settings.lifecycle_initial_status or "").strip().lower()
    if not mandated:
        return _validate_lifecycle_status(supplied) if supplied and supplied.strip() else "active"
    if supplied is None or not str(supplied).strip():
        return mandated
    normalized = _validate_lifecycle_status(supplied)
    if normalized != mandated:
        raise ValueError(
            f"status must be '{mandated}' when LIFECYCLE_INITIAL_STATUS is set (got '{normalized}')"
        )
    return normalized
```

**Implementation invariant (from expert review - do not skip):** `AgentRegistrationRequest` and `SkillRegistrationRequest` both default `status` to `"draft"`. The mandate MUST detect supplied-vs-defaulted via `request.model_dump(exclude_unset=True)` (or `"status" in request.model_fields_set`) and NOT via the parsed attribute. Reading `request.status` would feed the default `"draft"` into the mandate and silently break any mandate value other than `draft`. A unit test must pin this (construct the request without `status`, assert the supplied set is empty).

Route integration:
- **servers** (`register_server`, ~line 1295): replace the `if service_status: server_entry["status"] = service_status` block with `server_entry["status"] = resolve_initial_status(service_status)` inside try/except ValueError -> 400. Same in `internal_register_service`.
- **agents** (`register_agent`): per the invariant above - pass `None` when `status` was omitted (so the mandate forces it), the supplied value otherwise. try/except ValueError -> 400.
- **skills** (`register_skill`): same exclude-unset detection on `SkillRegistrationRequest`; apply on the updates/request dict before `register_skill(...)`.

#### Step 6: change_asset_status permission gate
**Files:** the three route files (+ `auth_server/scopes.yml`).

Gate logic (server PATCH example, inserted right after the existing `_check_server_permission("modify_service", ...)` call):
```python
patched_status = patch_dict.get("status")
if patched_status is not None:
    old_status = str(existing.get("status") or "active").lower()
    if str(patched_status).lower() != old_status and not user_context.get("is_admin"):
        from ..auth.dependencies import user_has_ui_permission_for_service
        if not user_has_ui_permission_for_service(
            "change_asset_status",
            existing.get("server_name", path),
            user_context.get("ui_permissions", {}),
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Changing the lifecycle status requires the 'change_asset_status' permission",
            )
```
- Agent PATCH: same check using `patch_body.model_dump(exclude_unset=True, by_alias=False)` and `existing_agent.status or "active"`, permission keyed on `existing_agent.name`.
- Skill PUT: `updates = request.model_dump(exclude_unset=True, mode="json")` is already computed; compare `updates.get("status")` vs `existing.status or "active"`; permission keyed on the skill name; admins bypass (consistent with `_user_can_modify_skill`). **Gate ordering:** the permission check runs BEFORE `check_registration_gate` so a forbidden caller fails fast locally instead of triggering an outbound gate call.
- Legacy-row consistency (security review): all three gates fall back the stored status to `"active"` when absent (`or "active"`), matching the list-endpoint convention (server_routes.py:723, agent_routes.py:1070, skill_routes.py:339). Skipping the gate when the new value equals the effective stored value keeps legacy assets from raising a spurious 403 on a no-op edit.
- Server edit form path (`edit_server_submit`, `service_status` Form field): apply the same differ-only gate for parity. The initial-status mandate is NOT applied here (registration-only, see Step 5 scope note).

**`auth_server/scopes.yml`:** add
```yaml
    change_asset_status:
    - all
```
under both `mcp-registry-admin` and `registry-admins` (keeps admins unlocked; other scopes are operator-defined).

#### Step 7: Metric declaration
**File:** `registry/observability/meters.py`
```python
webhook_send_total = _meter.create_counter(
    name="mcpgw_registry_webhook_send_total",
    description="Outbound registration webhook send attempts by event type and outcome",
    unit="1",
)
```

#### Step 8: Consumer-contract docs
**File:** `docs/registration-webhooks.md`. Add sections:
- `scan_complete` event: trigger, payload field table, failure-path example.
- Signature verification: header format; a Python receiver example that reads the RAW body bytes first (`await request.body()`), computes HMAC-SHA256, and compares with `hmac.compare_digest` (constant-time - the example must be exemplary since downstream users copy-paste it); explicit rule that verification happens on the exact transmitted bytes BEFORE any JSON re-serialization; note the signature covers the `json.dumps(..., default=str)` rendering; "header absent when no secret configured"; one sentence that the signature complements, not replaces, HTTPS.
- Contract: ordering NOT guaranteed (fire-and-forget, concurrent tasks); at-most-once, no retries; idempotency via `event_id` (dedupe window recommended; key on `event_id`, NOT on `(asset, event_type)` pairs); unknown `event_type` values must be skipped without failing; explicit interleave example: because `scan_complete` is emitted via `asyncio.create_task`, it may arrive AFTER a subsequent `update` event for the same asset.
- Reconciliation note: `update` events carry the full post-merge card including the new `status`, so orchestrators can reconcile lifecycle state from them.
- Monitoring: alert snippet `rate(mcpgw_registry_webhook_send_total{outcome="failed"}[5m]) > 0` sustained (consumer-outage signal, since delivery is at-most-once).
- Troubleshooting table row: "Signature verification fails -> secret mismatch, or a proxy re-serialized the body before hashing (verify against the raw received bytes)".
- Secret guidance: recommend 32+ random bytes for `REGISTRATION_WEBHOOK_SIGNING_SECRET` (a WARNING logs at startup below 16 chars).

### Error Handling
- Webhook failures: unchanged (logged WARNING, never raised); metric `outcome="failed"`.
- Payload serialization errors: log ERROR and skip the send rather than transmit unsigned (practically impossible: payloads are JSON-safe dicts).
- `resolve_initial_status` ValueError -> HTTP 400 with the exception message.
- `status=` filter ValueError -> HTTP 400.
- Permission gate: 403 with the message above; the audit action is already set by the handler.

### Logging
- INFO on successful send, appending `signed=true|false` to the existing log line.
- WARNING on the first unsigned send when a webhook URL is configured: operator visibility into the forged-event risk.
- WARNING at startup when `REGISTRATION_WEBHOOK_SIGNING_SECRET` is set but shorter than 16 characters (weak-secret signal; not enforcement).
- Existing scan/wrapper logging unchanged.

## Observability
### Metrics
- `mcpgw_registry_webhook_send_total{event_type, outcome}` - every outbound attempt. Bounded attributes (4 event types x 2 outcomes).

### Log Events
- `Registration webhook sent: event=..., signed=true/false, status=...`
- `Outbound webhooks are UNSIGNED: set REGISTRATION_WEBHOOK_SIGNING_SECRET to enable HMAC signing` (once per process)
- `Webhook signing secret is shorter than 16 characters; consider a longer random secret` (startup, warning)

## Scaling Considerations
- Signing adds one HMAC per event (microseconds); serialization cost moves from httpx into the service - same order of magnitude.
- `status=` forces the fallback list path for unrestricted admins; the cost equals the existing `query=` filter path.
- Metric attribute set is bounded; no cardinality risk.

## File Changes

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~+18 | 2 new settings + validator |
| `registry/services/webhook_service.py` | ~+85 | signing, event_id, scan_data, metric, `send_scan_complete_webhook`, `build_scan_data` |
| `registry/schemas/registry_card.py` | ~+28 | `resolve_initial_status` helper |
| `registry/observability/meters.py` | ~+7 | `webhook_send_total` counter |
| `registry/api/server_routes.py` | ~+70 | scan wrapper emits event (2 paths), PATCH + edit gates, register + internal-register gates, `status=` filter |
| `registry/api/agent_routes.py` | ~+60 | same for agents |
| `registry/api/skill_routes.py` | ~+60 | same for skills |
| `registry/api/endpoint_utils.py` | ~+10 | `resolve_status_filter` shared helper |
| `auth_server/scopes.yml` | ~+6 | `change_asset_status` on both admin scopes |
| `registry/api/config_routes.py` | ~+3 | expose the 2 new settings in the webhook config group; group title rename |
| `.env.example` | ~+10 | document + set both vars |
| `docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` | ~+6 | env passthrough |
| `terraform/aws-ecs/variables.tf` | ~+14 | 2 variables |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ~+8 | 2 env entries |
| `charts/registry/values.yaml` | ~+3 | 2 values |
| `charts/registry/templates/secret.yaml` | ~+4 | 2 secret keys (guarded pattern) |
| `docs/registration-webhooks.md` | ~+90 | scan_complete + signing + contract docs |
| `tests/unit/services/test_webhook_service.py` | ~+130 | signing/event_id/scan payload/metric tests |
| `tests/unit/test_lifecycle_status.py` | ~+70 | `resolve_initial_status` + exclude_unset invariant tests |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (service + config + schema helpers) | ~150 |
| Route integration (3 files) | ~190 |
| Deployment + docs | ~140 |
| Tests | ~200 |
| **Total** | **~680** |

## Testing Strategy
See `testing.md` - functional (filter + initial-status + permission + webhook payloads), backwards-compat (unsigned mode, unset flag, no-status patches), deployment-surface checks, and unit tests runnable with `uv run pytest tests/unit/services/test_webhook_service.py tests/unit/test_lifecycle_status.py`.

## Alternatives Considered

### Alternative 1: Asymmetric signing (Ed25519, like GitHub's RSA scheme)
**Pros:** consumers verify with only a public key; supports rotation.
**Cons:** new dependency or hand-rolled crypto, heavier key management, mismatched with the single-secret config model.
**Why Rejected:** HMAC-SHA256 with a shared secret matches the requirement verbatim and keeps the config surface to one variable.

### Alternative 2: DB-level status filter (push matching into repositories)
**Pros:** fast path stays DB-paginated.
**Cons:** touches three repository backends (file + documentdb variants) per asset type; the fallback path already exists and is correct.
**Why Rejected:** follow the established `has_field_filters` pattern, consistent with `query`/`visibility`.

### Alternative 3: Emit `scan_complete` from inside the scanner services
**Pros:** single emission point covers rescan too.
**Cons:** scanner services lack registration context (display name, registration type); rescan is synchronous and out of scope; the wrappers already own the failure path.
**Why Rejected:** wrappers are the integration point that knows the asset and the registration flow.

### Comparison Matrix

| Criteria | Chosen (wrapper + HMAC + list filter) | Alt 1 (asymmetric) | Alt 2 (DB filter) | Alt 3 (service-level event) |
|----------|---------------------------------------|--------------------|-------------------|------------------------------|
| Complexity | Low | High | Medium | Medium |
| New deps | None | Yes | None | None |
| Failure-path coverage | Yes | n/a | n/a | Partial |
| Matches existing patterns | Yes | No | Partially | No |

## Rollout Plan
- Phase 1: Implementation (this change).
- Phase 2: Unit tests (webhook service, lifecycle helper) - designed in testing.md.
- Phase 3: Deployment: set `REGISTRATION_WEBHOOK_SIGNING_SECRET` on the registry service first (consumers must hold the secret before unsigned events stop), then optionally set `LIFECYCLE_INITIAL_STATUS=draft` once the review workflow is live. Rollback = unset the vars (both default off).

## Open Questions
- Should the batch/federation write paths also enforce the initial-status mandate? Deferred: the agent batch item processor funnels through the same registration route; federation imports are read-only today. Revisit if a write-path federation mode lands.

## Post-Review Revision Record (Step 7.5)
All critical and should-fix findings from `review.md` are resolved in this revision:
- Byte's critical (exclude_unset invariant): pinned as an explicit implementation invariant with a required unit test (Step 5).
- Cipher's critical (constant-time verify): the docs example now mandates `hmac.compare_digest` over raw body bytes (Step 8).
- Byte should-fixes: `resolve_status_filter` moved to `endpoint_utils.py`; skill PUT gate ordered before `check_registration_gate`; signed-rendering note added; update-event reconciliation documented.
- Circuit should-fixes: Helm secret guard pattern + Secrets Manager guidance on the deployment checklist; troubleshooting row and failed-send alert snippet in docs.
- Cipher should-fixes: secret-length guidance + startup warning (Logging section); legacy-status fallback consistency noted on the gates; explicit registration-only scope for the mandate.
- Pixel/Sage should-fixes and nice-to-haves: interleave + idempotency-key guidance in the contract docs; config group label rename; `build_scan_data` docstring names accepted types.

Status: the revised design carries no unresolved critical or should-fix findings; proceeding to testing.md and implementation.

## References
- `docs/registration-webhooks.md` (existing webhook docs)
- `registry/schemas/registry_card.py` (`LifecycleStatus`, `_validate_lifecycle_status`)
- GitHub issue #1330
