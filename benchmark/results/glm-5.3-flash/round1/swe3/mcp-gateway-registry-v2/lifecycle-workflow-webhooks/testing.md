# Testing Plan: Lifecycle Workflow Webhooks

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies the five delivered behaviours end to end: `scan_complete` webhook emission (success and failure paths), HMAC-SHA256 signing of every outbound event body, `status=` list filtering, mandated initial registration status, and the `modify_service_status` permission gate - across servers, agents, and skills.

### Prerequisites
- [ ] Registry running locally (`docker compose up -d registry` or `make run`)
- [ ] Admin JWT available (`.oauth-tokens/admin.json` or session cookie)
- [ ] `REGISTRATION_WEBHOOK_URL` pointed at a local receiver (e.g. `http://localhost:6789/webhook`)
- [ ] `REGISTRATION_WEBHOOK_SIGNING_SECRET` set on the registry and known to the test harness
- [ ] jq and curl installed

### Shared Variables
```bash
export REGISTRY="http://localhost"
export JWT="Bearer $(jq -r '.access_token' .oauth-tokens/admin.json 2>/dev/null || echo MISSING)"
export WEBHOOK_SECRET="test-signing-secret"
```

## 1. Functional Tests

### 1.1 scan_complete webhook on scan success

```bash
# Register a server against a scanning-enabled endpoint; wait for the async scan.
curl -s -X POST "$REGISTRY/api/servers/register" \
  -H "Authorization: $JWT" -F "name=Scan OK" -F "path=/scan-ok" \
  -F "proxy_pass_url=http://safe-upstream:9000"
sleep 15
# Receiver log must show event_type=scan_complete, scan.is_safe=true, scan.scan_failed=false
tail -5 /tmp/webhook-receiver.log | jq -e 'select(.event_type=="scan_complete") | .scan.is_safe == true'
```

Expected: exactly one `scan_complete` event per registration; `performed_by` is null; payload has a `scan` object (not `card`); no `raw_output` key anywhere in `scan`.

### 1.2 scan_complete on scan failure (scanner error)

Register against an unreachable URL with scanning enabled:

```bash
curl -s -X POST "$REGISTRY/api/servers/register" \
  -H "Authorization: $JWT" -F "name=Scan Fail" -F "path=/scan-fail" \
  -F "proxy_pass_url=http://127.0.0.1:1/"
sleep 15
tail -20 /tmp/webhook-receiver.log | jq -e 'select(.event_type=="scan_complete") | select(.scan.scan_failed==true) | .scan.error_message != null'
```

Expected: a `scan_complete` event with `scan_failed=true`, `is_safe=false`, non-null `error_message`. The registration itself still returned 201.

### 1.3 HMAC signature over exact body

```python
# tools/verify_webhook_sig.py - receiver-side check
import hashlib, hmac, sys
raw = open(sys.argv[1], "rb").read()          # exact bytes received
sig = sys.argv[2]                              # X-Webhook-Signature header
assert sig.startswith("sha256="), "malformed header"
expected = hmac.new(b"test-signing-secret", raw, hashlib.sha256).hexdigest()
assert hmac.compare_digest(sig.removeprefix("sha256="), expected), "signature mismatch"
print("signature OK")
```

For every received event: dump the raw body and the header; the script must pass for `registration`, `update`, `deletion`, and `scan_complete` events.

### 1.4 status= list filter (all three asset types)

```bash
# Unknown value -> 400
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: $JWT" "$REGISTRY/api/servers?status=bogus"   # 400
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: $JWT" "$REGISTRY/api/agents?status=bogus"    # 400
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: $JWT" "$REGISTRY/api/skills?status=bogus"    # 400

# Known value -> only matching items, filtered total_count
curl -s -H "Authorization: $JWT" "$REGISTRY/api/servers?status=draft" | jq '.total_count, ([.servers[].status] | unique)'
curl -s -H "Authorization: $JWT" "$REGISTRY/api/agents?status=beta"  | jq '.total_count, ([.agents[].status] | unique)'
curl -s -H "Authorization: $JWT" "$REGISTRY/api/skills?status=draft" | jq '.total_count, ([.skills[].status] | unique)'
```

Expected: 400 with a detail naming allowed values; filtered pages contain only the requested status; `total_count` equals the filtered count, not the unfiltered count.

### 1.5 Mandated initial status

```bash
# With REGISTRATION_MANDATED_INITIAL_STATUS=draft:
curl -s -X POST "$REGISTRY/api/servers/register" -H "Authorization: $JWT" \
  -F "name=Mandated" -F "path=/mandated" -F "proxy_pass_url=http://u:9000" | jq '.service.status'      # "draft"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$REGISTRY/api/servers/register" -H "Authorization: $JWT" \
  -F "name=Mismatch" -F "path=/mismatch" -F "proxy_pass_url=http://u:9000" -F "status=active"           # 400
# Agent + skill equivalents: omitted status -> stored draft; explicit "active" -> 400.
curl -s -X POST "$REGISTRY/api/agents/register" -H "Authorization: $JWT" -H "Content-Type: application/json" \
  -d '{"name":"m-agent","url":"http://u:8001","description":"d"}' | jq '.status'                        # "draft"
```

Expected: omitted status forced to `draft`; mismatched explicit status rejected 400 with detail naming the mandated value; without the env var set, all of the above behave as before (explicit `active` accepted, omitted gets each type's prior default).

### 1.6 modify_service_status permission

```bash
# User with modify_service but NOT modify_service_status:
PATCH /api/servers/{path}  {"description": "x"}        -> 200 (metadata edit unaffected)
PATCH /api/servers/{path}  {"status": "beta"}          -> 403, detail names modify_service_status
PATCH /api/servers/{path}  {"status": "<current>"}     -> 200 (no-op echo does not trip the gate)
PATCH /api/agents/{path}   {"status": "beta"}          -> 403 same detail
PUT  /api/skills/{path}    body without status         -> 200
PUT  /api/skills/{path}    body with status="beta"     -> 403
# Same requests from an admin (seed docs grant modify_service_status: ["all"]) -> 200.
```

## 2. Backwards Compatibility Tests

- [ ] With `REGISTRATION_WEBHOOK_SIGNING_SECRET` unset: no `X-Webhook-Signature` header on any event; bodies otherwise identical to pre-change events (diff a captured `registration` event before/after upgrade).
- [ ] List endpoints without `status=` return byte-identical envelopes to pre-change (same fixture data).
- [ ] Existing clients that PATCH metadata without `status` are unaffected (no new permission required) - covered in 1.6 line 1.
- [ ] Skill registration requests that omit `status` still store `"draft"` with no mandate configured (the `status=None -> "draft"` coercion in `skill_service.register_skill`).
- [ ] Consumers that ignore unknown `event_type` values are unaffected by `scan_complete` events (per contract they skip unknown types).
- [ ] Old receivers without signature verification keep working while the secret is unset; with the secret set, events carry the header and unsigned-only receivers are unaffected (they ignore extra headers).

## 3. UX Tests

- [ ] Review-queue workflow via UI: filter the servers list client-side remains functional; server/agent/skill cards still render lifecycle `status` (no response shape change).
- [ ] 400 detail strings from the status filter render readably in API error surfaces (allowed values listed, no stack traces).
- [ ] CLI check (if applicable): `cli/service_mgmt.sh list` continues to work unfiltered.

## 4. Deployment Surface Tests

### 4.1 Docker wiring

```bash
grep -n "REGISTRATION_WEBHOOK_SIGNING_SECRET\|REGISTRATION_MANDATED_INITIAL_STATUS" \
  docker-compose.yml docker-compose.podman.yml docker-compose.prebuilt.yml .env.example
# 3 compose files: 2 env lines each under the registry service; .env.example: commented block + 2 assignments
docker compose config | grep -c "REGISTRATION_WEBHOOK_SIGNING_SECRET"   # >= 1
```

### 4.2 Terraform / ECS wiring

```bash
grep -n "registration_webhook_signing_secret\|registration_mandated_initial_status" \
  terraform/aws-ecs/variables.tf terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf
# variables.tf: 2 variable blocks; ecs-services.tf: 2 env entries in the registry container
terraform -chdir=terraform/aws-ecs validate   # plan/validate only, no apply
```

### 4.3 Helm / EKS wiring

```bash
grep -n "registrationWebhookSigningSecret\|registrationMandatedInitialStatus" \
  charts/registry/values.yaml charts/registry/templates/secret.yaml
# values.yaml: 2 keys under app:; secret.yaml: conditional entries (rendered only when non-empty)
helm template test charts/registry | grep -c "REGISTRATION_WEBHOOK_SIGNING_SECRET"
```

### 4.4 Deploy and verify

After a compose up with both vars set: registry logs show no config errors; a test registration produces a signed event; `?status=` works.

### 4.5 Rollback verification

Unset both vars and redeploy: no signature headers emitted; no mandate enforcement; permission check remains (code-level), which is the intended asymmetric rollback.

## 5. End-to-End API Tests

**Scenario: full externally-orchestrated lifecycle**

```bash
# 1. Mandate on. Register (no status) -> draft.
curl -s -X POST "$REGISTRY/api/servers/register" -H "Authorization: $JWT" \
  -F "name=E2E" -F "path=/e2e" -F "proxy_pass_url=http://u:9000" | jq '.service.status'    # draft
# 2. scan_complete arrives signed; orchestrator verifies + dedupes.
# 3. Orchestrator (admin creds) promotes: PATCH status draft->beta->active, each 200.
for s in beta active; do
  curl -s -o /dev/null -w "%{http_code} " -X PATCH "$REGISTRY/api/servers//e2e" \
    -H "Authorization: $JWT" -H "Content-Type: application/json" -d "{\"status\": \"$s\"}"
done   # 200 200
# 4. Review queue shrinks: ?status=draft no longer lists the path.
curl -s -H "Authorization: $JWT" "$REGISTRY/api/servers?status=draft" | jq -e '[.servers[].path] | index("/e2e") | not'
# 5. No lifecycle-transition webhook was emitted (receiver saw only scan_complete + the initial registration).
```

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/services/` (webhook signing, scan_complete payload, metric outcomes)
- [ ] Route tests added under `tests/unit/api/` (status filter, mandate, status permission)
- [ ] `uv run pytest tests/unit/services/test_webhook_service.py tests/unit/api/test_server_routes_patch.py tests/unit/test_lifecycle_status.py` passes with no regressions
