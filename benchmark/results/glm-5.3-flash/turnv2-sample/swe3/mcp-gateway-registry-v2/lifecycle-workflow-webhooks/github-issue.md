# GitHub Issue: External lifecycle orchestration support (scan_complete webhook, HMAC signing, status filter, mandated initial status, lifecycle-change permission)

## Title
Support externally orchestrated asset lifecycles: scan_complete webhook, HMAC-signed outbound events, status list filter, mandated initial status, and a distinct lifecycle-status-change permission

## Labels
- enhancement
- integrations
- security
- api

## Description

### Problem Statement
The registry needs to act as the system of record for a server/agent/skill registration lifecycle (draft -> beta -> active -> deprecated) that is orchestrated OUTSIDE the registry (CI/CD pipeline + admin review queue). Two gaps block that today:

1. **No scan outcome event.** The asynchronous security scan that runs after registration emits no webhook event, so an external orchestrator must poll `GET /api/servers/{path}/security-scan` to learn the outcome. The failure path (scanner timeout / crash) is invisible to consumers entirely.
2. **No lifecycle admission control.** There is no way to mandate the initial status of a registration, and no permission separating "may register an asset" from "may change an asset's lifecycle status" - the PATCH endpoints gate a status change under the same `modify_service` permission as any other metadata edit, so a scope cannot express "register yes, promote no".

Additionally, all outbound webhook events are unauthenticated payloads that can be spoofed by anyone who knows the webhook URL: a forged "scan passed" event could trick an orchestrator into promoting an unsafe asset. And an admin cannot pull a review queue (all assets currently in `draft`) without fetching and filtering the full list client-side.

### Proposed Solution
1. Emit a new `scan_complete` async webhook event when a registration-triggered security scan finishes, carrying the scan outcome INCLUDING the failure path (`scan_failed=true`, `is_safe=false`, `error_message` populated).
2. Sign ALL outbound async webhook events with an HMAC-SHA256 signature header computed over the exact transmitted body, keyed by a configurable signing secret. No header is sent when the secret is unset (backwards compatible). Add a unique `event_id` to every envelope for consumer-side idempotency.
3. Add a `status=` filter to the server, agent, and skill list endpoints so an admin can pull a review queue with `GET /api/servers?status=draft`.
4. Add a config flag (`LIFECYCLE_INITIAL_STATUS`, default off/empty) that mandates the initial registration status across servers, agents, and skills: an unspecified status is forced to the mandated value, and an explicit mismatched status is rejected with a clear 4xx.
5. Add a distinct `change_asset_status` UI permission. The server PATCH and agent PATCH endpoints (and skill PUT when its stored status changes) additionally require it when (and only when) the request touches `status`. Ordinary metadata edits stay where they are. Admin scopes gain the permission by default.
6. Add a webhook send metric (`mcpgw_registry_webhook_send_total`) with bounded attributes, and consumer-contract documentation covering ordering, idempotency, and signature verification.

### User Stories
- As a CI/CD pipeline operator, I want a `scan_complete` webhook when a registration scan finishes so that my pipeline reacts to the outcome without polling the registry.
- As a security engineer, I want every outbound webhook HMAC-signed so a forged "scan passed" event cannot promote an unsafe asset.
- As a registry admin, I want `GET /api/servers?status=draft` so I can work my approval queue directly.
- As a registry operator, I want to mandate `status=draft` at registration so no asset goes live without review.
- As a platform admin, I want a `change_asset_status` permission so I can grant contractors "register yes, promote no".

### Acceptance Criteria
- [ ] A `scan_complete` webhook event is emitted after every registration-triggered security scan for servers, agents, and skills, including the scan-failure path (scanner error/timeout produces `scan_failed=true`, `is_safe=false`, `error_message` populated).
- [ ] The `scan_complete` payload carries asset identity (path, name), `is_safe`, `scan_failed`, severity counts, `scan_timestamp`, `analyzers_used`, and `error_message` - and does NOT carry the full `raw_output`.
- [ ] When `REGISTRATION_WEBHOOK_SIGNING_SECRET` is set, every outbound webhook (registration, deletion, update, scan_complete) carries `X-Registry-Signature: sha256=<hex>` computed as HMAC-SHA256 over the exact transmitted body bytes.
- [ ] When the secret is unset, no signature header is emitted and behavior is unchanged (backwards compatible).
- [ ] Every webhook envelope carries a unique `event_id` (UUID) usable as a consumer idempotency key.
- [ ] `GET /api/servers?status=`, `GET /api/agents?status=`, and `GET /api/skills?status=` filter to exactly the requested lifecycle status, paginate correctly, and return 400 for an invalid status value.
- [ ] When `LIFECYCLE_INITIAL_STATUS` is set to a valid value: registering without a status forces that status; registering with a different explicit status returns 400 with a clear message; the flag value is validated at startup.
- [ ] When `LIFECYCLE_INITIAL_STATUS` is unset, registration behavior is unchanged.
- [ ] Server PATCH and agent PATCH with a `status` field, and skill PUT where the stored status changes, additionally require the `change_asset_status` UI permission (403 without it). Requests that do not change `status` are unaffected.
- [ ] `change_asset_status: [all]` is present in the default admin scopes (`mcp-registry-admin`, `registry-admins`) so administrators are not locked out.
- [ ] A `mcpgw_registry_webhook_send_total` counter is incremented on every webhook attempt with attributes `event_type` and `outcome` (sent|failed).
- [ ] Consumer-contract documentation covers event ordering (none guaranteed), idempotency (`event_id`), and signature verification with a copy-pasteable receiver example.
- [ ] New settings appear on every deployment surface: `.env.example`, all three docker-compose files, Terraform variables + ECS task definition, and Helm values + secret.

### Out of Scope
- A webhook event on lifecycle transitions (draft -> beta -> active -> deprecated): the orchestrator initiates those via PATCH and already knows the outcome.
- Automatic status transitions driven by scan results (the orchestrator decides, the registry records).
- Emitting `scan_complete` from the manual `POST .../rescan` endpoints (synchronous; the caller gets the result in the response).
- Any frontend/UI change for status filtering or lifecycle management.
- Webhook delivery retries, dead-letter queues, or per-event-type endpoint routing (fire-and-forget model is retained).
- Signature rotation with multiple concurrent keys (single configured secret).
- Migration of stored cards (existing assets keep their current status values).

### Dependencies
- None new. HMAC uses stdlib `hmac`/`hashlib`; webhook transport remains `httpx`; metrics use the existing OpenTelemetry meter in `registry/observability/meters.py`.

### Related Issues
- #1330 (this issue)
- Builds on: #742 (registration webhooks), #809 (registration gate), #1033 (agent scan tag persistence)
