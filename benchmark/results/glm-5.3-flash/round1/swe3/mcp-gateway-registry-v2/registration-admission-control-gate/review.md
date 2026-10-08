# Expert Review: Registration Admission Control Gate

*Created: 2026-09-30*

Review of `github-issue.md` and `lld.md` for the registration admission-control gate.

## Frontend Engineer (Pixel)

**Focus:** UI/UX, components, state, API integration.

**Strengths**
- Deny reasons flow through existing error channels (`HTTPException.detail`, JSONResponse error bodies), so the React SPA renders them with no frontend changes.
- The admin config API integration uses the existing CONFIG_GROUPS mechanism; the new settings appear in the existing config UI and all export formats automatically.

**Concerns**
1. (Should fix) The server UI edit route (`/edit/{service_path}`) does content negotiation (`Accept: application/json` vs redirect). A deny must not return a redirect; the LLD says JSONResponse error for both cases, which is correct, but the review wants it explicit: on deny, return the JSON error body regardless of `Accept`, because the form submit path expects a redirect only on success. The LLD was ambiguous.
2. (Nice to have) Browser form submissions to `/edit` that get a 403/503 JSON body will show raw JSON to a human on a non-JS fallback path. Acceptable for this change; the SPA path is the primary consumer.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** None; reusing existing error rendering is right.

**Recommendations:** Make the edit-route error behavior explicit in the LLD (done, see Resolution for finding F1).

**Questions for author:** None.

**Verdict:** APPROVED WITH CHANGES

---

## Backend Engineer (Byte)

**Focus:** API design, data models, business logic, performance.

**Strengths**
- Client-side design is clean: a single function, `GateDecision` result object, never raises, fail-closed on every error mode. This makes route wiring trivial and auditable.
- Gate payload identifies the origin (`endpoint`, `action`) and includes the full registration payload, satisfying the "distinguish which endpoint the call came from" requirement.
- Placing the gate after permission checks but before persistence preserves existing authz semantics and guarantees nothing is written on deny.

**Concerns**
1. (Must fix) **Credential leakage to an external service.** `server_entry` can contain `auth_credential` (pre-encryption, at the gate point in `/register` and `/internal/register`) and `auth_credential_encrypted`; the edit path carries `auth_credential` too. The LLD mentions stripping but the original key list was incomplete and the mechanism should be defense-in-depth: strip a fixed deny-list AND any key whose name contains `credential`, `password`, `secret`, or `token`. The registry must not transmit secrets to an external endpoint.
2. (Must fix) **Deny-vs-failure status mapping by string comparison is fragile.** Mapping `decision.reason == GATE_UNAVAILABLE_MESSAGE` to 503 breaks silently if a gate returns that exact phrase as a denial reason. `GateDecision` should carry the distinction structurally: add a `failure: bool` field (failure vs policy-deny), and routes map `failure` to 503 and policy-deny to 403.
3. (Should fix) `internal_register_service` with `overwrite=True` is an UPDATE of an existing server, but the design sends `action="register"`. The gate payload should reflect reality: `action="update"` when overwriting an existing server, `"register"` when new. The endpoint field still identifies the route.
4. (Should fix) In `update_skill`, the `updates` dict is a partial update; sending it is fine, but the payload should also include the existing card's identity (path), which the design does via the endpoint field. Confirm the payload includes `path` key explicitly so per-path policy is implementable. (Design sends endpoint `/skills/{path}`; acceptable, but add `path` to the payload top level for all seven call sites for uniformity.)
5. (Nice to have) One synchronous hop adds up to the timeout to every registration; consider recording the gate duration in the log line. Cheap and useful.

**New libraries / infra dependencies required:** None (httpx already present).

**Better alternatives considered:** FastAPI middleware (rejected: payload not assembled, bypass-prone); per-route gate flags (rejected: unnecessary config surface).

**Recommendations:** Add `failure` field to `GateDecision`; harden payload stripping; set `action="update"` on internal overwrite; add top-level `path` to gate payload; include gate latency in error logs.

**Questions for author:** None blocking after resolutions.

**Verdict:** APPROVED WITH CHANGES

---

## SRE / DevOps Engineer (Circuit)

**Focus:** Deployment, monitoring, scaling, infrastructure.

**Strengths**
- Off by default with a documented kill switch (flip `REGISTRATION_GATE_ENABLED=false`); rollback is trivial and does not require a redeploy of the gate.
- Deployment surface checklist covers all four real surfaces (env example, compose, Terraform ECS, Helm) plus the admin config API.
- Per-call httpx client matches the existing ANS pattern; no long-lived connection state to manage in containers.

**Concerns**
1. (Should fix) A down gate blocks ALL registrations (by design). The LLD should state the operational expectation explicitly and recommend the timeout stay small (default 5s is reasonable) and the gate be deployed with HA. Documented in Rollout Plan now.
2. (Should fix) Helm: the auth token must land in the Secret (it is sensitive), following the `ans.apiKey` / `ans.apiKeyExistingSecret` pattern. The LLD now explicitly lists secret.yaml rendering; implementer should also support an `existingSecret`-style reference only if trivial, otherwise plain b64 secret keys are acceptable for parity with the rest of the chart.
3. (Nice to have) Log lines for gate errors should include the gate URL host to speed up incident triage (not the token). Added to implementation notes.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Health-check sidecar probing the gate (rejected: out of scope, operators own the gate's availability).

**Recommendations:** Keep default timeout at 5s; render gate config through secret.yaml in Helm; keep allow/deny logging at info/warning so deny storms are visible without debug.

**Questions for author:** None.

**Verdict:** APPROVED WITH CHANGES

---

## Security Engineer (Cipher)

**Focus:** AuthN/AuthZ, validation, OWASP, data protection.

**Strengths**
- Fail-closed on every failure mode (timeout, unreachable, unexpected status, misconfiguration) is exactly right for an admission control.
- Gate auth via configurable header keeps the webhook from being open on the network; empty token sends no header (no junk credentials).
- Deny surfaces only the gate's reason; gate failure surfaces a fixed generic message, so internal details do not leak to end users.

**Concerns**
1. (Critical) **SSRF / credential exfiltration risk profile.** The gate URL is operator-configured, which is acceptable, but the registry sends registration payload data to it. Two controls are mandatory and both are now in the design: (a) strip credential fields from the payload (Byte's finding 1, hardened deny-list plus name-based matching); (b) never log the auth token. The LLD's original `_STRIPPED_PAYLOAD_KEYS` missed `auth_header_name` (not a secret) but more importantly relied on an exact key list; the name-substring fallback closes the gap for fields added later.
2. (Must fix) **Structural deny/failure distinction** (same as Byte's finding 2): returning 503 with a fixed message on failure and 403 with the gate reason on deny must not depend on string equality. Otherwise a malicious/compromised gate could return `reason` equal to the fixed failure message and cause clients to mislabel a policy denial as an outage (confusion, wrong alerting). Structural `failure` flag resolves it.
3. (Should fix) The gate client should impose a sane maximum timeout regardless of configuration (cap at 30s) so a misconfigured `REGISTRATION_GATE_TIMEOUT_SECONDS=600` cannot pin route workers for ten minutes. Clamp in the client.
4. (Should fix) Log the denial reason verbatim but bound its length (truncate to ~300 chars) so a gate cannot flood logs with a multi-MB reason string.
5. (Nice to have) Consider validating that `REGISTRATION_GATE_URL` is http(s) at startup when enabled. A warning-level validation in the client (non-http scheme => fail-closed deny with error log) is sufficient here.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** mTLS to the gate (rejected for this change: header-based auth matches the stated requirement and existing patterns; operators can terminate TLS at a sidecar).

**Recommendations:** Implement the hardened stripping, structural failure flag, timeout clamp, reason truncation, and URL scheme check.

**Questions for author:** None.

**Verdict:** APPROVED WITH CHANGES

---

## SMTS (Sage)

**Focus:** Architecture, code quality, maintainability.

**Strengths**
- Right layering: one small client module, explicit call sites at the seven routes, no framework magic. An entry-level developer can trace the entire enforcement story by grepping `check_registration_gate`.
- The `endpoint` + `action` + `asset_type` + `path` fields in the payload give the gate first-class routing context without the registry embedding any policy.
- Honest non-goals: no retries, no async admission, no delete-path coverage. Scope is tight and matches the issue.

**Concerns**
1. (Should fix) Consistency of error shapes across routes: agent/skill use HTTPException, server routes use JSONResponse with `error`/`detail` or `error`/`reason` keys. The design preserves each route family's existing convention, which is correct for this codebase; add a table in the LLD so the implementer does not "normalize" them (done).
2. (Should fix) The two-message constants (`GATE_UNAVAILABLE_MESSAGE`, `GATE_DENIED_FALLBACK_MESSAGE`) must be importable by tests and call sites from the single module to avoid drift. Stated in the design; fine.
3. (Nice to have) A future refactor could extract a shared `_gate_or_raise` helper to remove the repeated status-mapping block at seven call sites. For a benchmark-sized patch, seven explicit blocks are acceptable and more readable.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Shared route helper/dependency (deferred: explicit call sites are clearer for review and diff comparison).

**Recommendations:** Keep the patch minimal and mechanical; each call site should read identically.

**Verdict:** APPROVED WITH CHANGES

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Findings |
|----------|---------|----------|--------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | F1: edit-route deny must return JSON error, never a redirect |
| Backend (Byte) | APPROVED WITH CHANGES | 2 | B1: credential stripping hardening; B2: structural deny/failure flag; B3: internal overwrite = update |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | C1: document fail-closed ops expectation; C2: Helm secret rendering |
| Security (Cipher) | APPROVED WITH CHANGES | 1 | S1 (critical): payload stripping + no token logging; S2: structural flag; S3: timeout clamp; S4: reason truncation |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | G1: per-route error-shape table; G2: single-source constants |

**No NEEDS REVISION verdicts; proceeding to implementation after incorporating the must-fix and should-fix items below.**

## Step 7.5 Resolutions (LLD revised before implementation)

| Finding | Severity | Resolution in revised LLD |
|---------|----------|---------------------------|
| B1 / S1 | Must-fix / Critical | `_build_gate_payload` now strips a fixed deny-list AND any key whose name contains `credential`, `password`, `secret`, or `token` (case-insensitive). Auth token is never logged. |
| B2 / S2 | Must-fix | `GateDecision` gains a `failure: bool` field. Routes map `failure=True` to 503 with `GATE_UNAVAILABLE_MESSAGE`, policy-deny to 403 with the gate reason. No string comparison. |
| B3 | Should-fix | `internal_register_service` sends `action="update"` when overwriting an existing server, `action="register"` when new. |
| B4 | Should-fix | Gate payload includes a top-level `path` key at all seven call sites (asset path or name). |
| B5 / C3 | Nice to have | Gate error log lines include gate URL host and call duration; token never logged. |
| F1 | Should-fix | LLD now states explicitly: on deny/failure, `/edit/{service_path}` returns a JSON error body regardless of Accept header. |
| S3 | Should-fix | Client clamps the effective timeout to at most 30 seconds. |
| S4 | Should-fix | Denial reason truncated to 300 characters in responses and logs. |
| S5 | Nice to have | Client warns and fails closed if the gate URL is not http(s). |
| C1 | Should-fix | Rollout Plan documents the fail-closed operational expectation and HA guidance. |
| C2 | Should-fix | Helm secret.yaml renders the five gate keys (token sensitive), following the ANS block pattern. |
| G1 | Should-fix | LLD Implementation Details now includes the per-route error-shape table. |
| G2 | Nice to have | Constants live in `registration_gate.py`; call sites and tests import them from there. |
