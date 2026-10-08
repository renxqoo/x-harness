# Testing Plan: Externally Orchestrated Asset Lifecycles

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview
### Scope of Testing
Verify the five deliverables end to end: `scan_complete` webhook (success + failure path), HMAC signing on all outbound events, the `status=` list filter, the `LIFECYCLE_INITIAL_STATUS` mandate, and the `change_asset_status` permission gate - across servers, agents, and skills - plus config/deployment wiring and the consumer contract.

### Prerequisites
- [ ] Registry running locally (`docker compose up` or `uv run uvicorn registry.main:app`) with `.env` configured
- [ ] Admin credentials (session cookie or JWT) for auth-required endpoints
- [ ] A local webhook receiver for observing outbound events (see 1.1)
- [ ] `jq` installed for assertions

### Shared Variables
```bash
export REGISTRY_URL="http://localhost"
export ADMIN_COOKIE=".cookies"            # session cookie jar from admin login
export JWT_TOKEN="<admin JWT>"            # or bearer token
export WEBHOOK_SECRET="test-signing-secret-0123456789abcdef"
export RECEIVE_PORT=6789
```

Webhook receiver with signature verification (copy-pasteable; doubles as the docs example):
```python
# receiver.py
import hashlib, hmac, json
from fastapi import FastAPI, Request

app = FastAPI()
SECRET = b"test-signing-secret-0123456789abcdef"

@app.post("/webhook")
async def handle(request: Request):
    body = await request.body()                      # RAW bytes, before JSON parsing
    sig = request.headers.get("X-Registry-Signature", "")
    expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):       # constant-time compare
        return {"status": "rejected"}
    event = json.loads(body)
    print(event["event_type"], event.get("registration_type"), event["event_id"])
    return {"status": "ok"}
```
Run with: `uvicorn receiver:app --host 0.0.0.0 --port $RECEIVE_PORT`

---

## 1. Functional Tests

### 1.1 scan_complete webhook (server, success path)
Register a server with `REGISTRATION_WEBHOOK_URL=http://localhost:$RECEIVE_PORT/webhook` and scanning enabled; observe the receiver.

```bash
curl -s -X POST "$REGISTRY_URL/api/servers/register" \
  -b "$ADMIN_COOKIE" \
  -F "name=scan-hook-server" -F "path=/scan-hook-server" \
  -F "proxy_pass_url=https://scan-hook.example.com" \
  -F "description=scan webhook test"
# wait for the async scan to finish, then inspect the receiver output
```

**Expected:** receiver logs two events eventually - `registration` then `scan_complete` (order not guaranteed between them, but scan_complete only after its scan ran).
**Assertions on the scan_complete envelope:**
- `event_type == "scan_complete"`, `registration_type == "server"`
- `event_id` present and unique per event
- `scan.path == "/scan-hook-server"`, `scan.is_safe` boolean, `scan.scan_failed == false`
- `scan` has severity counters and `scan_timestamp`; no `raw_output` key anywhere in the payload
- `X-Registry-Signature: sha256=...` header present and verifies against the raw body with the configured secret

### 1.2 scan_complete webhook (failure path)
Point a registration at an unreachable URL so the scanner errors:
```bash
curl -s -X POST "$REGISTRY_URL/api/servers/register" \
  -b "$ADMIN_COOKIE" \
  -F "name=scan-fail-server" -F "path=/scan-fail-server" \
  -F "proxy_pass_url=http://127.0.0.1:1/unreachable"
```
**Expected:** a `scan_complete` event with `scan.scan_failed == true`, `scan.is_safe == false`, `scan.error_message` non-null. The registration itself still returns 201 (scan failures are non-fatal).

### 1.3 scan_complete for agents and skills
Repeat 1.1 via `POST /api/agents/register` (JSON body) and `POST /api/skills` (JSON body).
**Expected:** `registration_type` of `"agent"` / `"skill"` respectively with the same `scan` sub-payload shape.

### 1.4 HMAC signing on every event type
With the secret set, trigger `registration`, `update` (PATCH), and `deletion` (DELETE) for one server.
**Expected:** all three events carry a valid `X-Registry-Signature` header verifying over their exact raw body. Mutate one byte of the body in the receiver before verifying -> verification must fail (negative case proving the signature covers the body).

### 1.5 Unsigned mode (secret unset)
Restart the registry with `REGISTRATION_WEBHOOK_SIGNING_SECRET=` (empty) and trigger a registration.
**Expected:** no `X-Registry-Signature` header; payload otherwise unchanged; a WARNING ("Outbound webhooks are UNSIGNED...") appears once in registry logs.

### 1.6 status= list filter
```bash
# seed: register three servers with distinct statuses (flag off)
curl -s -b "$ADMIN_COOKIE" "$REGISTRY_URL/api/servers?status=draft"   | jq '.total_count, ([.servers[].status] | unique)'
curl -s -b "$ADMIN_COOKIE" "$REGISTRY_URL/api/servers?status=ACTIVE"  | jq '.total_count'   # case-insensitive
curl -s -b "$ADMIN_COOKIE" "$REGISTRY_URL/api/servers?status=bogus"   -o /dev/null -w '%{http_code}\n'
```
**Expected:** first call returns only `draft` servers with correct `total_count` and working `limit`/`offset`; second call returns `active` entries (normalized); third returns **400** with `Invalid status 'bogus'. Allowed values: ...`.
Repeat the three calls against `/api/agents` and `/api/skills`.

### 1.7 LIFECYCLE_INITIAL_STATUS mandate
Restart with `LIFECYCLE_INITIAL_STATUS=draft`:
```bash
# a) omitted status -> forced to draft
curl -s -X POST "$REGISTRY_URL/api/servers/register" -b "$ADMIN_COOKIE" \
  -F "name=mandated-1" -F "path=/mandated-1" -F "proxy_pass_url=https://x.example.com" \
  | jq '.service.status'                       # -> "draft"
# b) mismatched explicit status -> 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$REGISTRY_URL/api/servers/register" \
  -b "$ADMIN_COOKIE" -F "name=mandated-2" -F "path=/mandated-2" \
  -F "proxy_pass_url=https://x.example.com" -F "status=active"    # -> 400
curl -s ... -F "status=active" | jq '.detail'   # -> "status must be 'draft' when LIFECYCLE_INITIAL_STATUS is set (got 'active')"
# c) matching explicit status -> accepted, stays draft
```
Repeat a/b for agents (`POST /api/agents/register`, JSON: omit `status` then `"status": "active"`) and skills (`POST /api/skills`).
**Negative-control:** restart with the flag unset and re-run b -> registration succeeds with `status=active` (unchanged behavior).

### 1.8 change_asset_status permission gate
Seed a scope that grants `modify_service`/`register_service` but NOT `change_asset_status` for a test user (via the auth server scopes config), then:
```bash
# PATCH touching status, value differs -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$REGISTRY_URL/api/servers/mandated-1" \
  -H "Authorization: Bearer $LIMITED_JWT" -H "Content-Type: application/json" \
  -d '{"status": "active"}'                                    # -> 403
# PATCH touching status, value identical to stored -> allowed (no gate)
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$REGISTRY_URL/api/servers/mandated-1" \
  -H "Authorization: Bearer $LIMITED_JWT" -H "Content-Type: application/json" \
  -d '{"status": "draft"}'                                     # -> 200
# PATCH not touching status -> allowed
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$REGISTRY_URL/api/servers/mandated-1" \
  -H "Authorization: Bearer $LIMITED_JWT" -H "Content-Type: application/json" \
  -d '{"description": "metadata edit"}'                        # -> 200
# admin PATCH changing status -> allowed (admin bypass)
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$REGISTRY_URL/api/servers/mandated-1" \
  -b "$ADMIN_COOKIE" -H "Content-Type: application/json" \
  -d '{"status": "beta"}'                                      # -> 200
```
**Expected exactly as annotated.** Repeat the 403/no-gate pair for `PATCH /api/agents/{path}` and `PUT /api/skills/{path}` (skill: PUT whose body changes `status` vs one that leaves it equal).

### 1.9 Webhook send metric
```bash
curl -s "$REGISTRY_URL:9464/metrics" | grep mcpgw_registry_webhook_send_total
```
**Expected:** series exists with `event_type` and `outcome` labels; a successful send increments `outcome="sent"`, an unreachable receiver increments `outcome="failed"`.

## 2. Backwards Compatibility Tests
- **Unsigned mode** = today's behavior: 1.5 covers payload + no new header.
- **Flag unset**: registrations behave exactly as before, including explicit statuses (1.7 negative-control).
- **PATCH without status**: identical response and permission requirements as before (1.8 third case).
- **Existing events**: `registration`/`deletion`/`update` payload keys unchanged; new keys (`event_id`, optional `scan`) are additive - assert existing consumers' key set is a subset of the new payload.
- **List endpoints without `status`**: `GET /api/servers` etc. return identical results to before (run a before/after diff on a seeded registry).

## 3. UX Tests
**Web UI - Not Applicable** - no frontend changes in this design.
**CLI output** - covered by 1.6/1.7 error `detail` strings (clear, actionable: allowed values / mandated value named).

## 4. Deployment Surface Tests
### 4.1 Docker wiring
```bash
grep -n "REGISTRATION_WEBHOOK_SIGNING_SECRET\|LIFECYCLE_INITIAL_STATUS" docker-compose.yml docker-compose.podman.yml docker-compose.prebuilt.yml
```
**Expected:** both vars passed to the `mcp-gateway-registry` service in all three files. Then: `REGISTRATION_WEBHOOK_SIGNING_SECRET=$WEBHOOK_SECRET docker compose up registry` and confirm the secret reaches the process (`docker compose exec registry printenv | grep SIGNING`).

### 4.2 Terraform / ECS wiring
```bash
grep -n "registration_webhook_signing_secret\|lifecycle_initial_status" terraform/aws-ecs/variables.tf terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf
```
**Expected:** variable declarations + container env entries inside the registry task definition. `terraform validate` passes.

### 4.3 Helm / EKS wiring
```bash
grep -n "registrationWebhookSigningSecret\|lifecycleInitialStatus" charts/registry/values.yaml charts/registry/templates/secret.yaml
```
**Expected:** values + guarded secret keys. `helm template` renders both env vars into the secret manifest.

### 4.4 Config UI
Load the registry config page -> the Registration Webhook group shows "Signing Secret" (masked) and "Initial Status"; group title reads "Registration Webhook (Notifications & Signing)".

### 4.5 Rollback verification
Unset both env vars and restart -> unsigned events resume; registrations accept any status; no 403s beyond the pre-change permission model. No data migration to undo.

## 5. End-to-End API Tests
**Orchestrator journey (the acceptance workflow):**
1. Operator sets `LIFECYCLE_INITIAL_STATUS=draft` + signing secret; consumer starts the verifying receiver.
2. Developer registers an asset -> forced `draft`; `registration` + `scan_complete` events arrive signed; `scan.is_safe == true`.
3. Admin pulls the review queue: `GET /api/servers?status=draft` -> asset listed.
4. Admin PATCHes status to `active` (has `change_asset_status`) -> 200; `update` event carries the new status.
5. Developer (lacking `change_asset_status`) attempts to PATCH status -> 403.
**Pass criteria:** every step behaves as annotated; the consumer never polled the registry.

## 6. Unit Tests (runnable)
```bash
uv run pytest tests/unit/services/test_webhook_service.py tests/unit/test_lifecycle_status.py -v
```
- Webhook service: signature format + correctness against a known vector; same bytes signed and sent; `event_id` presence/uniqueness; `scan` sub-payload included only for `scan_complete`; unsigned mode emits no header; metric increments on success and failure; `build_scan_data` maps all three scan-result models and tolerates missing fields.
- Lifecycle helper: mandate off (default `active`, supplied value honored); mandate on (forces unspecified, rejects mismatch with the exact message, accepts matching); invalid mandate value rejected; **exclude_unset invariant test** - `AgentRegistrationRequest(**minimal)` without `status` must yield an unset `status` field set.
- Filter helper: valid values normalized, invalid raises 400-mapped ValueError.

## 7. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified
- [ ] Section 5 (E2E) passes
- [ ] Unit tests added under `tests/unit/services/test_webhook_service.py` and `tests/unit/test_lifecycle_status.py`
- [ ] `uv run pytest tests/unit/` passes with no regressions
