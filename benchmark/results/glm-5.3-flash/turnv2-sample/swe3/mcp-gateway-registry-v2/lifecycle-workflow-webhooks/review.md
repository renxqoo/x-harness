# Expert Review: Externally Orchestrated Asset Lifecycles

*Created: 2026-09-29*
*Reviewed: github-issue.md + lld.md (2026-09-29 draft)*

Five expert personas reviewed the issue specification and the low-level design. All reviews were produced inline in a single pass (single-agent benchmark run). Findings are labeled critical / should-fix / nice-to-have; verdicts are at the end of each section, with a summary table and the post-review LLD revision record.

---

## Review 1: Frontend Engineer (Pixel)

**Focus:** UI/UX, components, state, API integration.

### Strengths
- The `status=` filter is a pure query-param addition; the existing React dashboard keeps working untouched because the response shape is unchanged.
- Choice NOT to build UI in this change is correct - the review-queue consumer is an external admin queue, and the list response already carries `status` per card.

### Concerns
1. **(nice-to-have)** The dashboard list views will not surface the new filter until a control exists. Not blocking; the API is the contract here.
2. **(nice-to-have)** The UI config page group (`registration_webhook`) gains the signing secret and initial-status fields. Fine, but the group title still says "(Notifications)"; consider renaming to "(Notifications & Signing)" so operators can find the secret field. Cosmetic.
3. **(should-fix, docs-facing)** Consumers of `scan_complete` need to know the event is emitted asynchronously via `asyncio.create_task`, which means it can arrive AFTER a subsequent `update` event for the same asset. The docs section must call this out so a UI built on event order does not mis-sort. The LLD's contract section covers ordering generally; make the scan-vs-update interleave explicit.

### New libraries / infra dependencies
None.

### Better alternatives considered
None - API-first scope is right.

### Recommendations
- Add the explicit interleave example to the consumer-contract docs.
- Rename the config group label (one-line change, rides along).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (docs clarity items only; no architectural blockers)

---

## Review 2: Backend Engineer (Byte)

**Focus:** API design, data models, business logic, performance.

### Strengths
- `build_scan_data` normalizing three different scan-result models behind one `getattr`-based helper is the right shape - it keeps the wrappers one-line and makes the failure path uniform.
- Signing the exact transmitted bytes (`content=` instead of `json=`) is correct; the common naive implementation signs `json.dumps(payload)` and then lets httpx re-serialize, producing signatures that fail on key order or separators.
- `status` filter joining `has_field_filters` preserves pagination correctness (`total_count`) - the subtle bug class this codebase has already been careful about.
- `resolve_initial_status` centralizing the mandate logic next to the enum avoids three divergent copies.

### Concerns
1. **(critical)** Agent and skill registration request models default `status` to `"draft"`. If the LIFECYCLE_INITIAL_STATUS enforcement reads `request.status` directly, the mandate can never distinguish "caller explicitly asked for draft" from "default filled in". The LLD does specify `exclude_unset` presence detection (Step 5), but the edge case is inverted from what people expect: with the flag set to `draft`, an omitted status and an explicit `"draft"` are indistinguishable - that is fine; with the flag set to `active`, an omitted status must be forced to `active` even though the parsed model now carries `draft`. The implementation MUST use `model_dump(exclude_unset=True)` (or `model_fields_set`) and NOT the parsed attribute. Keep this called out as an implementation invariant.
2. **(should-fix)** The `update` event is fired by PATCH endpoints. After adding the `change_asset_status` gate, a successful PATCH that changed status will emit an `update` event - good - but the LLD never states that the update event payload includes the new status. It does (the card is serialized post-merge); state it in the docs so orchestrators know they can reconcile state from `update` events.
3. **(should-fix)** `resolve_status_filter` placed in `server_routes.py` and imported by agent/skill routes is a mild layering smell (routes importing routes). Prefer moving it to `registry/api/endpoint_utils.py`, which exists precisely for shared API helpers (`get_endpoint_url`). Low risk either way, but do it cleanly.
4. **(nice-to-have)** `_serialize_body` with `default=str` silently stringifies datetimes/UUIDs; that is what httpx's json encoder effectively did, and card dicts are already JSON-safe, so this is acceptable. Document that the signature covers the `default=str` rendering, so consumers re-serializing in a different style do not chase phantom mismatches.
5. **(should-fix)** Skill PUT: `update_skill` computes `updates` AFTER the gate-check point where ownership is verified but BEFORE `check_registration_gate`. The status-change permission check must run before the gate call (fail fast on permissions before calling out to the external gate). Confirm ordering in the LLD.
6. **(nice-to-have)** The skill fast-path filter builds `SkillInfo` per card; filtering on `s.status` before construction avoids wasted model instantiations - the LLD already says this. Good.

### New libraries / infra dependencies
None (stdlib hmac/hashlib). Correct call.

### Better alternatives considered
DB-level filtering (rejected in LLD, agreed - three backends for a filter the fallback path already handles).

### Recommendations
- Pin the exclude_unset invariant with a unit test that constructs `AgentRegistrationRequest(**{... no status ...})` and asserts the handler-visible "supplied" set is empty.
- Move `resolve_status_filter` to `endpoint_utils.py`.
- Put the skill PUT gate before `check_registration_gate`.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (1 critical, 3 should-fix)

---

## Review 3: SRE / DevOps Engineer (Circuit)

**Focus:** Deployment, monitoring, scaling, infrastructure.

### Strengths
- Two new env vars default off - zero behavioral change on upgrade, rollback = unset. Textbook config-flag hygiene.
- The deployment surface checklist covers every surface this repo actually uses (3 compose files, Terraform/ECS, Helm) - this matches how existing webhook vars are wired, so drift is unlikely.
- The webhook send counter with bounded attributes is scrape-friendly; no cardinality bomb.

### Concerns
1. **(should-fix)** Secret handling asymmetry: in Helm, `REGISTRATION_WEBHOOK_AUTH_TOKEN` goes into the chart secret; the signing secret should too (it is exactly as sensitive). The LLD lists `secret.yaml` - make sure the value follows the same `{{- if }}` guarded pattern and is documented for ECS as a Secrets Manager reference, not plaintext tfvars, consistent with the existing token guidance in the docs.
2. **(should-fix)** The one-per-process "UNSIGNED webhooks" warning is good, but operators rotating the secret need a signal that signing actually engaged. The `signed=true/false` field on the send log line covers it; make sure the docs' troubleshooting table gains a row: "Signature verification fails -> secret mismatch / body re-serialized by a proxy before hashing".
3. **(nice-to-have)** No retry/DLQ is a deliberate non-goal, but a consumer outage will now silently drop scan events AND increment `outcome="failed"`. Add to the docs: alert on `rate(mcpgw_registry_webhook_send_total{outcome="failed"}[5m]) > 0` sustained. One paragraph.
4. **(nice-to-have)** Metric emission inside the fire-and-forget path means a metrics-service outage cannot affect registration - correct, the counter is in-process OTel and NoOp-safe. No concern, noting for the record.

### New libraries / infra dependencies
None.

### Better alternatives considered
Per-event-type endpoints / SNS fan-out - out of scope, correctly.

### Recommendations
- Keep the secret in the Helm secret template with the same guard pattern as the auth token.
- Add the failed-send alert snippet and the signature-mismatch troubleshooting row to the docs.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (2 should-fix)

---

## Review 4: Security Engineer (Cipher)

**Focus:** AuthN/AuthZ, validation, OWASP, data protection.

### Strengths
- HMAC over exact transmitted bytes is the correct construction; using `hmac` stdlib and hex digest with a `sha256=` prefix matches de-facto standards (GitHub-style) so consumers can reuse existing verification code.
- Refusing to downgrade to unsigned when serialization fails is the right call - a signed contract that silently degrades is a vulnerability.
- The gate only firing on an actual status CHANGE avoids both lockout noise and no-op bypasses; admins bypassing keeps existing admin workflows intact.
- Keeping `raw_output` out of the scan payload avoids leaking potentially sensitive scanner output to the consumer.

### Concerns
1. **(critical)** Signature comparison on the consumer side must be constant-time. The docs example MUST use `hmac.compare_digest`, not `==`. The LLD mentions it, but make the docs example itself exemplary - copy-paste code is how this gets implemented downstream.
2. **(should-fix)** The signing secret has no minimum length guidance. A 4-character secret is technically "signed". Add a recommendation (not enforcement) in docs: 32+ random bytes; and log a WARNING at startup if the configured secret is shorter than 16 characters. Cheap signal, no breakage.
3. **(should-fix)** The permission gate trusts `patched_status` casing via `.lower()` compare - fine - but the stored `existing["status"]` may be absent (legacy rows). The `or "active"` fallback matches the list endpoint's convention; make sure the agent PATCH uses `existing_agent.status or "active"` and skill PUT `existing.status or "active"` exactly as the LLD says, otherwise legacy assets get a spurious 403 on first status edit. This is a consistency requirement, not a new design.
4. **(should-fix)** `resolve_initial_status` normalizes with `.lower().strip()` (via `_validate_lifecycle_status`), but the mandate comparison then compares normalized vs mandated - correct. One more input: the server form path (`edit_server_submit`) also writes `status`; if it bypasses the mandate the flag is trivially bypassable through the older UI endpoint. The LLD gates it for permissions but does NOT apply `resolve_initial_status` on the edit path - confirm that is intentional: initial-status mandate applies to REGISTRATION only; edits are governed by the permission. State it explicitly in the LLD so an implementer does not "helpfully" add it to the edit path and break status workflows.
5. **(nice-to-have)** Timing side-channels on signature verification are the consumer's problem; the registry side only signs. No action.
6. **(nice-to-have)** Consider documenting that the webhook URL should be HTTPS and the signature is not a substitute for transport security (defense in depth). One sentence in docs.

### New libraries / infra dependencies
None.

### Better alternatives considered
Asymmetric signing (rejected in LLD - agreed for this scope; revisit if multi-consumer signing is ever needed).

### Recommendations
- Docs: constant-time compare example, secret-length guidance, short-secret startup warning, HTTPS note.
- Explicit non-goal note: initial-status mandate is registration-only by design.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (1 critical, 3 should-fix)

---

## Review 5: SMTS (Sage)

**Focus:** Architecture, code quality, maintainability.

### Strengths
- The design threads five requirements through ONE send path instead of adding five parallel mechanisms; signing/idempotency/metrics land in `webhook_service.py` once and every event inherits them. That is the single highest-leverage decision in the LLD.
- Reusing `LifecycleStatus`/`_validate_lifecycle_status` instead of a new validation vocabulary keeps one source of truth for the allowed set.
- Honest non-goals: no transition events (orchestrator already knows), no retries. Scope discipline is what keeps this reviewable.

### Concerns
1. **(should-fix)** `server_routes.py` is already ~5800 lines and this change adds four separate concerns to it (scan hook, two gates, filter). The LLD mitigates with helpers (`build_scan_data`, `resolve_initial_status`, `resolve_status_filter`) - good - but keep the route-file deltas strictly additive and mechanical so review stays diff-shaped rather than semantic.
2. **(should-fix)** `build_scan_data` duck-types three models via `getattr`. That is pragmatic here (they genuinely share field names), but add a one-line comment naming the three types it accepts so the next contributor does not have to diff them to trust it.
3. **(nice-to-have)** `event_id` is generated per send attempt. If the process dies mid-flight, the event is lost (at-most-once) - consistent with fire-and-forget, and the docs say so. No change needed; noting the semantics are coherent.
4. **(nice-to-have)** The `update` vs `scan_complete` interleave (Pixel's point) is inherent to `create_task` ordering; the contract docs should also recommend consumers key idempotency on `event_id` and not on `(asset, event_type)` pairs.

### New libraries / infra dependencies
None.

### Better alternatives considered
A dedicated event-bus abstraction - overkill for one URL and four event types; the existing single-function sender is the right altitude.

### Recommendations
- Keep helper functions in service/schema layers; keep route edits additive.
- Name the accepted types on `build_scan_data`.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (2 should-fix)

---

## Review Summary

| Reviewer | Verdict | Critical | Should-fix | Key Recommendations |
|----------|---------|----------|------------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | 1 (docs) | Document scan-vs-update event interleave; rename config group label |
| Backend (Byte) | APPROVED WITH CHANGES | 1 | 3 | exclude_unset invariant for initial-status; move `resolve_status_filter` to endpoint_utils; gate ordering before registration gate; document signed rendering |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | 2 | Secret into Helm secret + Secrets Manager guidance; troubleshooting row + failed-send alert snippet |
| Security (Cipher) | APPROVED WITH CHANGES | 1 | 3 | Constant-time compare example; secret-length guidance + startup warning; legacy-status fallback consistency; mandate is registration-only (explicit) |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | 2 | Keep route deltas additive/mechanical; document `build_scan_data` accepted types |

**Overall: no NEEDS REVISION verdicts. The design is approved contingent on the critical and should-fix items being resolved in the LLD before implementation.**

### Critical findings requiring LLD revision (triggering the Step 7.5 loop)
1. **(Byte)** Initial-status mandate MUST use `model_dump(exclude_unset=True)` presence detection on agents/skills - reading the parsed attribute would make the mandate ineffective (models default `status` to `"draft"`).
2. **(Cipher)** Consumer-side signature verification example must be constant-time (`hmac.compare_digest`) and the docs must make the raw-body-before-parse rule unmissable.

## Next Steps
1. Revise `lld.md` to resolve the critical findings and adopt the should-fix items (Step 7.5 loop).
2. Proceed to `testing.md` and implementation against the revised LLD.
