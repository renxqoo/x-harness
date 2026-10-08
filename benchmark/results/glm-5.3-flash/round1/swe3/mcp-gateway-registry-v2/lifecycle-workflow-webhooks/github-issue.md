# GitHub Issue: Lifecycle Workflow Webhooks for Externally Orchestrated Registrations

## Title
Emit `scan_complete` webhooks, HMAC-sign all outbound events, add list `status=` filter, mandated initial registration status, and a distinct lifecycle-status permission

## Labels
- enhancement
- security
- api
- integration
- lifecycle

## Description

### Problem Statement
The registry needs to act as the system of record for a server registration lifecycle (`draft -> beta -> active -> deprecated`) that is orchestrated OUTSIDE the registry (enterprise CI/CD pipeline plus an admin review queue). Two gaps block that today:

1. **No scan-completion event.** The asynchronous YARA security scan that runs after registration emits no event, so an external CI/CD consumer has to poll `GET /api/servers/{path}/security-scan` to learn the outcome. There is no push notification on either the pass or the failure path.
2. **No lifecycle separation.** There is no way to mandate the initial status of a registration, and no permission separating "may register an asset" from "may change an asset's lifecycle status". The PATCH endpoint gates a status change under the same `modify_service` permission as any other metadata edit, so a scope cannot express "register yes, promote no".

Because outbound webhooks are unauthenticated payloads that can trigger promotion decisions, a forged "scan passed" event could trick an orchestrator into promoting an unsafe asset; the events also carry no integrity guarantee today.

### Proposed Solution
1. Add a `scan_complete` async webhook event carrying the scan outcome, including the failure path (scanner error, timeout, unsafe result).
2. HMAC-SHA256-sign the exact transmitted body of ALL outbound async webhook events (`registration`, `update`, `deletion`, `scan_complete`) under a `X-Webhook-Signature: sha256=<hex>` header, keyed by a configurable signing secret. Signing is off by default (empty secret preserves current behaviour).
3. Add a `status=` filter to the `GET /api/servers`, `GET /api/agents`, and `GET /api/skills` list endpoints so an admin can pull a review queue (e.g. `?status=draft`).
4. Add a config flag (`REGISTRATION_MANDATED_INITIAL_STATUS`, default off) that mandates the initial registration status: an unspecified status is forced to the mandated value, and a mismatched explicit status is rejected with a clear 4xx.
5. Add a distinct `modify_service_status` UI permission that the PATCH endpoints (servers, agents) and the skill update endpoint additionally require when the request touches `status`, leaving ordinary metadata edits where they are.
6. Add a webhook delivery counter metric and consumer-contract documentation covering event ordering, idempotency, and signature verification.

### User Stories
- As a CI/CD pipeline operator, I want a signed `scan_complete` webhook when a registration's security scan finishes so that I can advance the asset through the lifecycle without polling.
- As a registry admin, I want to filter the list endpoints by lifecycle status so that I can work a review queue of `draft` assets.
- As a security administrator, I want to mandate that every new registration starts as `draft` so that no asset bypasses the review queue.
- As an identity administrator, I want a scope that grants registration without granting lifecycle promotion so that registrants cannot self-promote.
- As a webhook consumer, I want every event body HMAC-signed so that I can reject forged "scan passed" events.

### Acceptance Criteria
- [ ] A `scan_complete` webhook event is emitted when the post-registration security scan finishes for servers, agents, and skills, on both the completed and the failed/exception path (with `scan_failed: true` and an error message).
- [ ] When `REGISTRATION_WEBHOOK_SIGNING_SECRET` is set, every outbound webhook POST carries `X-Webhook-Signature: sha256=<hexdigest>` computed by HMAC-SHA256 over the exact transmitted request body bytes.
- [ ] When the secret is unset, no signature header is emitted and behaviour is byte-identical to today (backwards compatible).
- [ ] `GET /api/servers?status=`, `GET /api/agents?status=`, and `GET /api/skills?status=` filter the page by lifecycle status; an unknown value returns 400.
- [ ] When `REGISTRATION_MANDATED_INITIAL_STATUS` is set (e.g. `draft`): a registration that omits `status` is stored with the mandated value, and a registration with a different explicit `status` is rejected with HTTP 400 naming the mandated value. When unset, behaviour is unchanged.
- [ ] Patching `status` on a server or agent (and updating `status` on a skill) additionally requires the `modify_service_status` UI permission; metadata-only patches do not.
- [ ] Admin scope seed documents (`scripts/mcp-registry-admin.json`, `scripts/registry-admins.json`) include `modify_service_status: ["all"]` so existing admins keep working.
- [ ] A `mcpgw_registry_webhook_delivery_total` counter is incremented per webhook attempt with `event_type` and `outcome` attributes.
- [ ] `docs/registration-webhooks.md` documents the consumer contract: delivery order is not guaranteed, consumers must deduplicate on `(event_type, registration_type, asset path, timestamp)`, and signature verification with `hmac.compare_digest`.
- [ ] No lifecycle-transition webhook is emitted when an orchestrator PATCHes a status change (explicitly out of scope).

### Out of Scope
- A webhook event on lifecycle transitions: the orchestrator initiates those and already knows the outcome.
- Signed webhooks for the registration gate (admission control) request path.
- Retry/redelivery queues for webhook events (fire-and-forget model is unchanged).
- Emitting `scan_complete` from the manual `/rescan` endpoints (the caller is synchronous and sees the result).
- Mandating initial status on federation/internal sync registration paths.

### Dependencies
- None new. HMAC uses the standard library `hmac`/`hashlib`; delivery uses the existing `httpx` client; the metric uses the existing OTel meter.

### Related Issues
- #742 (registration notification webhooks)
- #809 (registration gate, admission control)
- #1330 (this issue)
