# Expert Review: Lifecycle Workflow Webhooks

*Created: 2026-09-30*
*Design reviewed: `./lld.md` (revision 1) against `./github-issue.md`*

## Reviewer 1: Backend Engineer (Byte)

### Strengths
- Reusing the three existing `_perform_*_security_scan_on_registration` helpers as the emission point guarantees every registration path (single register, internal, edit-overwrite, PUT-with-URL-change, batch processor) gets `scan_complete` without touching each caller.
- Signing the exact transmitted bytes (serialize-then-post `content=`) is correct; signing a dict and letting httpx re-serialize would produce receiver-mismatch failures.
- Reusing `_validate_lifecycle_status` keeps status semantics in one place.

### Concerns
1. **[must-fix]** Skill registration defaults `status` to `"draft"` at the Pydantic layer, so "omitted" and "explicitly draft" are indistinguishable in the handler. The LLD's resolution (compare effective value against the mandate, 400 on mismatch) changes the meaning of a plain `{"name": ..., "skill_md_url": ...}` registration when the mandate is `beta`: previously-valid requests start failing with no way to say "I have no opinion". The LLD must state this explicitly as a documented behaviour change for skills only, or the handler must pre-default `status=None` on the request model.
2. **[should-fix]** `send_scan_complete_webhook` as a second public function sharing "URL/auth/timeout logic" invites drift. The LLD already gestures at a `_post_webhook(payload)` shared helper; make it mandatory in the design, with both public functions reduced to payload construction.
3. **[should-fix]** The metric attribute name flips between `outcome` and `outcome`/`outcome` wording across sections (Step 2 says outcomes `sent/failed/skipped`, Observability says `sent/failed`). `skipped` (URL unset) never increments the counter per Step 2's own text - remove it from the attribute enum to avoid a label that can never appear.
4. **[minor]** `_emit_scan_complete` sketch re-derives `scan_timestamp` for the failure path with `datetime.now(UTC)`, but the except branch may not have a result at all - fine - yet the success path should pass `result.scan_timestamp` verbatim so consumers can correlate with the scan document.

### New Libraries / Infra Dependencies
- None. Correct to keep it stdlib-only.

### Better Alternatives Considered
- Deliver `scan_complete` from a repository layer hook (DocumentDB change stream). Rejected: the repo already centralizes emission in route helpers; change streams would fire on every write, not just registration scans.

### Recommendations
- Make `_post_webhook(payload: dict) -> None` the only place that touches httpx, signing, and the metric.
- Document the skills default-status nuance in `testing.md` as its own backwards-compat case.

### Questions for Author
- Should a `scan_complete` failure to *deliver* (webhook POST fails) be retried? LLD says no (fire-and-forget). Acceptable given the consumer can also poll the scan endpoint.

### Verdict: APPROVED WITH CHANGES

---

## Reviewer 2: Frontend Engineer (Pixel)

### Strengths
- The list filter changes only query parameters and the response shape stays identical; the dashboard's existing pagination components keep working.
- `has_field_filters` gating keeps the unfiltered dashboard on the fast DB-pagination path, so no performance regression for the default view.

### Concerns
1. **[should-fix]** The web UI has no affordance for the new lifecycle surfaces, which is fine, but the review queue use-case is API-only. At minimum the LLD should note the UI is untouched deliberately (cards already render `status`), so nobody "fixes" this later by adding an unfiltered client-side filter that fights the new server-side one.
2. **[minor]** 400 on unknown `status` values will surface as a raw detail string in any client that pipes it to a toast. The message from `_validate_lifecycle_status` already lists allowed values - good; keep the detail verbatim rather than wrapping it.

### New Libraries / Infra Dependencies
- None.

### Better Alternatives Considered
- Multi-status filter (`status=draft,beta`). Rejected for v1: review queue = one status; can extend later without breaking the single-value contract.

### Recommendations
- None blocking.

### Questions for Author
- None.

### Verdict: APPROVED

---

## Reviewer 3: SRE / DevOps Engineer (Circuit)

### Strengths
- Deployment surface checklist covers every place the existing webhook variables live (compose x3, terraform vars + module + task def, Helm values + secret). Missed surfaces are the classic reason a feature "works locally, silently off in prod".
- Metric uses the established OTel module-scope pattern; Prometheus export comes free.

### Concerns
1. **[should-fix]** Terraform module wiring: the LLD lists `terraform/aws-ecs/variables.tf` and `modules/mcp-gateway/variables.tf`, but the existing webhook variables live at `terraform/aws-ecs/variables.tf` (root) and are consumed in `modules/mcp-gateway/ecs-services.tf` via `var.registration_webhook_url`. Confirm whether the module re-declares the variables or reads root vars through the module call site; the patch must thread both new vars through the same path or ECS deploys will not see them.
2. **[should-fix]** Secret handling: the Helm secret template base64-encodes values and gates optional ones behind `{{- if }}`. The signing secret must be optional (not rendered when empty) exactly like `REGISTRATION_WEBHOOK_AUTH_TOKEN`, and never logged - the LLD says DEBUG "Signing webhook body" which is fine (no secret material), keep it that way.
3. **[minor]** Rolling update window: during a rollout, replicas with the secret and replicas without it will emit signed and unsigned events. Consumers must tolerate both during the window; the consumer-contract doc should say "verify only when the header is present" OR "require the header once the cut-over completes" - state the recommended posture (verify-if-present during migration, require after).

### New Libraries / Infra Dependencies
- None.

### Better Alternatives Considered
- AWS Secrets Manager reference for the signing secret in ECS (mirrors auth token guidance). Agree with the doc; no code change.

### Recommendations
- Verify the exact terraform variable threading by reading the module files during implementation.

### Questions for Author
- None.

### Verdict: APPROVED WITH CHANGES

---

## Reviewer 4: Security Engineer (Cipher)

### Strengths
- The threat model is right: outbound events trigger promotion decisions, so integrity is the property that matters; HMAC-SHA256 over exact bytes with `hmac.compare_digest` on the consumer side is the correct primitive.
- Keeping the signing secret out of logs and gating emission on a non-empty secret preserves today's behaviour for existing deployments (no surprise breakage).

### Concerns
1. **[must-fix]** Signature comparison guidance must mandate constant-time comparison (`hmac.compare_digest`) and reject non-hex/short strings before comparing; the LLD mentions `compare_digest` only in passing. Consumer-doc must include a complete verification snippet, not a name-drop.
2. **[must-fix]** The `scan_complete` payload must not leak `raw_output` (tool schemas, header values seen by the scanner) or credential-derived headers. The LLD's whitelist-style field list is right; make "whitelist-only fields, never `raw_output`" an explicit invariant of `send_scan_complete_webhook` so future field additions cannot silently leak.
3. **[should-fix]** `modify_service_status` is enforced in the PATCH/PUT handlers, but `register_service_api` (`POST /servers/register`, line 3491) accepts `status` at registration under `register_service` permission. That is by design (initial status), but the LLD should call out that a user with register-but-not-promote can still *land* an asset directly in `active` unless the mandate is configured. The mandate flag is the control that closes this; document the pairing.
4. **[should-fix]** Timing: signing after serialization is correct, but ensure serialization is deterministic (`separators=(",", ":")`, `ensure_ascii=False` consistent between sign and send). The LLD pins this in `_serialize_payload` - keep it a single function so it cannot diverge.
5. **[minor]** No key-rotation story beyond "change both sides". Acceptable for v1; note that events in flight during rotation fail verification and are dropped, which is safe.

### New Libraries / Infra Dependencies
- None (stdlib hmac/hashlib).

### Better Alternatives Considered
- Asymmetric signing (Ed25519) so consumers cannot forge events if the consumer secret leaks. Rejected for v1: key distribution machinery out of proportion; HMAC with a shared secret matches the repo's existing telemetry signing precedent (`registry/core/telemetry.py:445`).

### Recommendations
- Whitelist invariant + complete consumer verification snippet in docs.

### Questions for Author
- Should the registry also emit `X-Webhook-Event-Id` (UUID) to make dedupe trivial? Nice-to-have; timestamp+type+path suffices. Not blocking.

### Verdict: APPROVED WITH CHANGES

---

## Reviewer 5: SMTS (Sage)

### Strengths
- The design stays inside the repo's existing shapes: one service, three helpers, two settings, one counter. No new abstraction layer, no framework. Entry-level implementable.
- Treating `_build_status_filter` as semantically different (exclusion at search time) rather than awkwardly reusing it shows the right instinct.

### Concerns
1. **[must-fix]** Internal consistency: the LLD alternately calls the metric attribute `outcome` and lists `skipped` as a value that "never increments". Strip `skipped` from the contract and pick one attribute name; as written, two implementers would build different things. (Same finding as Byte's #3 - it is a design-doc defect, not just wording.)
2. **[must-fix]** The skills "omitted vs explicit draft" indeterminacy (Byte's #1) is a real semantic hole: `SkillRegistrationRequest.status` has a default, so `exclude_unset` is the only discriminator and the register handler does not use it. The revised LLD must pick one behaviour and state it as a documented deviation for skills (mandate compares effective value) or change the model to `status: str | None = None` for the request path. Recommend the model change: it is two lines, restores "omitted means no opinion", and keeps skills consistent with servers/agents.
3. **[should-fix]** `_require_status_change_permission` should live once (server_routes or a shared util) and be imported by agent/skill routes, mirroring how `_check_agent_permission` mirrors `_check_server_permission` today. Three divergent copies is how the 403 detail strings drift.
4. **[should-fix]** PUT semantics on servers: `ServerUpdateRequest.status` is not `exclude_unset`-friendly through `_merge_server_update` the same way PATCH is; the implementation must compare against the stored status (not merely presence-in-body) in both PUT and PATCH so a no-op status echo does not require the new permission. The LLD's "different from stored" phrasing is correct; keep it normative.
5. **[minor]** Consider emitting `event_id` (uuid4) on every webhook payload for consumer idempotency keys. Cheap, non-breaking. Optional.

### New Libraries / Infra Dependencies
- None.

### Better Alternatives Considered
- A dedicated `lifecycle_service.py` module. Rejected: would be a 40-line pass-through; the helpers belong where their siblings are.

### Recommendations
- Apply the two must-fixes in the LLD before implementation; the rest are execution guidance.

### Questions for Author
- None.

### Verdict: NEEDS REVISION

---

## Review Summary

| Reviewer | Verdict | Blocking Findings | Key Recommendation |
|----------|---------|-------------------|--------------------|
| Frontend (Pixel) | APPROVED | 0 | Keep fast path for unfiltered lists; keep verbatim 400 detail |
| Backend (Byte) | APPROVED WITH CHANGES | 2 | Shared `_post_webhook` mandatory; document skills default-status behaviour |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | Verify terraform variable threading; optional-secret Helm pattern |
| Security (Cipher) | APPROVED WITH CHANGES | 2 | Full consumer verification snippet; whitelist-only scan payload invariant |
| SMTS (Sage) | NEEDS REVISION | 2 | Metric attribute contract fix; skills `status=None` model change |

### Blocking Findings (must address in lld.md before implementation)

1. **[Sage/Byte] Metric attribute contract inconsistent** - `outcome` values listed as `sent/failed/skipped` in one place and `sent/failed` in another; `skipped` never increments by design.
2. **[Sage/Byte] Skills omitted-vs-default `status` indistinguishable** - mandate would reject `status`-less skill registrations when the mandate is not `draft`.
3. **[Cipher] Consumer verification guidance incomplete** - doc must contain a full constant-time verification snippet and reject malformed signatures.
4. **[Cipher] `scan_complete` payload leakage risk** - whitelist-only fields must be an explicit invariant (never `raw_output`, never credential-derived headers).

### Next Steps
1. Revise `lld.md` per findings 1-4 (revision 2, see section "Review Revisions").
2. Proceed to `testing.md` and implementation against the revised design.

**Resolution log (added after LLD revision 2):**

- Finding 1 - Resolution: metric contract fixed to a single attribute set: `event_type` in {registration, update, deletion, scan_complete}, `outcome` in {sent, failed}; disabled webhook (URL unset) returns before touching the counter, so no `skipped` label exists. LLD Steps 2/3 and Observability now agree verbatim.
- Finding 2 - Resolution: `SkillRegistrationRequest.status` changed to `str | None = None`; `skill_service.register_skill` coerces `None -> "draft"` exactly as before, so stored data and existing clients are unchanged, while the register handler can now distinguish "omitted" (force mandate) from "explicit draft". LLD Step 7 rewritten accordingly; added as a backwards-compat case in testing.md.
- Finding 3 - Resolution: `docs/registration-webhooks.md` gains a complete verification snippet using `hmac.new(secret, raw_body, hashlib.sha256)` and `hmac.compare_digest`, with malformed-header rejection before comparison and the migration posture (verify-if-present during rollout, require after).
- Finding 4 - Resolution: `send_scan_complete_webhook` documents a whitelist-only payload invariant (path, timestamps, is_safe, scan_failed, error_message, severity counts, analyzers_used); `raw_output` and any credential-derived material are structurally excluded by building the payload from explicit fields, never from the result model dump.

No other blocking findings; proceeding to testing plan and implementation on the revised design.
