# Expert Review: Per-caller-per-target rate limits and quarantine kill switch

*Created: 2026-09-30*
*Reviewed: github-issue.md + lld.md (draft)*
*Method: single-agent, five sequential persona passes (no subagents)*

---

## Reviewer 1: Frontend Engineer (Pixel)

Focus: UI/UX, components, state, API integration.

**Strengths**
- Reusing `RateLimitGroupsEditor` for caller quarantine is the right call: quarantine appears exactly where operators already manage rate-limit groups, on both Users and M2M lists, with zero new data fetching (options and memberships are already fetched once by the parents).
- The quarantine panel in `IAMRateLimits` sits next to the definitions table, which is where an operator triaging "who is blocked and why" will look first.
- The red `QUARANTINED` badge on rows gives at-a-glance state without a new page or route.

**Concerns**
1. *must-fix (UX correctness)*: `RateLimitGroupsEditor.handleSave` deletes the whole membership doc when the last group is deselected. If an operator edits the seed doc itself (it renders like any membership row in a raw list view) and empties it, the PUT/DELETE guard dance gets confusing (delete returns 409). The editor must never offer the seed docs as editable rows. Since the parents only render editors per real user/client row, the exposure is only in any future raw-membership list; still, the chip rendering must visually distinguish the reserved group so an operator understands what they are touching.
2. *should-fix*: axis select gains a third option; the form must reset `group` when switching axes, or a stale `group` value can be submitted for `caller`/`target` bodies (the new validator would then 400 with a confusing message).
3. *should-fix*: the target-quarantine panel's target select must reuse `useServerList`/`useAgentList` data already loaded by `IAMRateLimits` (the same source the target-name typeahead uses), not issue new requests.

**New libraries / infra dependencies**: none.

**Better alternatives considered**: a dedicated Quarantine page under Settings. Rejected: fragments a two-click action across navigation; the panel next to rate limits is one click and shares loaded state.

**Recommendations**: implement per LLD Step 7, adding the two should-fixes above (form-state reset on axis switch; reuse loaded server/agent lists).

**Questions for author**: none.

**Verdict: APPROVED WITH CHANGES** (none blocking after the should-fixes are folded in; they are form-state hygiene, not design changes).

---

## Reviewer 2: Backend Engineer (Byte)

Focus: API design, data models, business logic, performance.

**Strengths**
- The composite-subject gate is a clean extension of `_Gate`: no backend, `_enforce`, or scheduling changes; the new axis rides the existing sort-by-window, deny-does-not-consume machinery for free.
- Counter key `ct:<entity_type>:<identity>|<target>:<window>` is never parsed back, mirroring the colon-packed definition ids; `|` cannot appear in usernames/client_ids from the supported IdPs.
- `list_caller_target_limits` keeps the cached-read + invalidate-on-mutation pattern, preserving zero steady-state DB reads.

**Concerns**
1. *critical (correctness, API contract)*: the draft's membership guard contradicts the core feature. It says a membership may reference a reserved group "only via the matching seed subject". That makes quarantine unusable: quarantining alice REQUIRES `user:alice`'s doc to reference `__quarantined_callers__`. The guard must instead enforce subject-kind/group pairing: `user`/`client` docs may carry `__quarantined_callers__`, `target` docs may carry `__quarantined_targets__`, cross-usage is rejected, and only the two seed doc ids are undeletable (409).
2. *must-fix*: `RateLimitDecision.quarantine()` overloads `axis` with the subject kind (`"caller"`/`"target"`), which collides with axis-abbreviation semantics (`clr`/`tgt`) used by `_enforce` labels. Acceptable, but the field contract must be documented on the model, and `server.py` must branch on `decision.kind`, never on `axis`, when choosing the detail error string.
3. *should-fix*: multiple group memberships matching two `caller_target` defs for the same target+window yield two gates; both enforced, most-restrictive wins naturally. Correct, but add a unit test pinning it (regression bait).
4. *should-fix*: `build_id()` for the new axis embeds `group` between entity_type and name. Any CLI/doc that constructs ids by string-splitting on `:` would break; the codebase treats ids as opaque (consistency check only), so just keep it that way and do not add parsing.

**New libraries / infra dependencies**: none.

**Better alternatives considered**: storing the composite counter as two counter docs and combining at read time. Rejected: racy, and doubles backend round trips on the hot path.

**Recommendations**: fix the membership guard as specified in (1); document the decision-field contract in (2); add the tests in (3).

**Questions for author**: none.

**Verdict: APPROVED WITH CHANGES** (finding 1 is critical and must be resolved in the LLD before implementation).

---

## Reviewer 3: SRE / DevOps Engineer (Circuit)

Focus: deployment, monitoring, scaling, infrastructure.

**Strengths**
- Zero new deployment surface: no env vars, no compose/chart/terraform diffs, no nginx change. Rollout is a container image bump; rollback is the previous image, and releasing a quarantine is a membership edit, not a redeploy.
- Quarantine evaluation adds at most one cached lookup per request; steady-state cost is unchanged.
- Seeding is two `$setOnInsert` upserts per boot: idempotent, negligible, and safe across concurrent replicas (unique `_id` upsert race is atomic).

**Concerns**
1. *must-fix (operational safety)*: startup seeding runs on every auth-server boot, including deployments where rate limiting stays disabled and including a DocumentDB outage at boot. The helper must be best-effort (WARNING + continue) and must never delay or fail startup. The LLD says this; the implementation and its test must prove it (simulate the store raising; assert startup completes).
2. *should-fix*: an admin's data-plane request now triggers the target-quarantine lookup (a new read on the admin path). Bounded by the same 30s cache, but note it in the docs so a future "why does the admin path read memberships" question has an answer.
3. *should-fix*: the new metric label set must stay bounded: `subject` in {caller,target} only. The identity fields belong in logs only, as the existing throttle logging already does. Add an alerting note: `rate_limit_quarantined_total` increasing means a kill switch is ACTIVE, page an operator.

**New libraries / infra dependencies**: none.

**Better alternatives considered**: seeding via an init-job/migration script. Rejected: adds a deployment artifact, violates the no-new-deployment-configuration constraint; boot-time seeding is self-healing per replica.

**Recommendations**: implement as designed with the best-effort seeding test; add the ops notes to `docs/design/rate-limiting.md`.

**Questions for author**: none.

**Verdict: APPROVED WITH CHANGES**.

---

## Reviewer 4: Security Engineer (Cipher)

Focus: AuthN/AuthZ, validation, OWASP, data protection.

**Strengths**
- Fail-closed schema validation extended consistently (axis/entity-type/subject allowlists; new required-field branch; floors).
- Quarantine deny is a plain 403 without `Retry-After`: an attacker probing a quarantined path learns nothing about window boundaries, and clients cannot "wait out" a kill switch. The marker is a distinct header, so the nginx 429 rewrite cannot be tricked into downgrading a quarantine to a retryable throttle.
- No identity in metric labels; identities in WARNING logs only, matching existing practice.
- Seed-delete protection plus subject-kind/group pairing prevents quarantine-group confusion attacks (a target doc claiming `__quarantined_callers__` would be inert anyway, but rejecting it keeps the data honest).

**Concerns**
1. *critical (must resolve in design)*: the draft membership guard makes the feature unusable (see Byte finding 1). Same fix: pairing rules, not seed-only usage.
2. *must-fix (documented accepted risk)*: an admin token is exempt from caller quarantine (consistent with the existing caller-gate bypass that prevents operator lockout). A compromised ADMIN credential therefore bypasses caller quarantine entirely. Mitigations: (a) target quarantine denies admins too, so per-target containment works; (b) admin status is IdP-controlled, so revoking the admin group still removes data-plane access via the normal authz path. This must be stated explicitly in the LLD (Accepted Risks) and the ops doc, not left implicit.
3. *should-fix*: validate that a quarantined caller's release path (membership edit) is admin-only. It is: `put_rate_limit_membership` is behind `_require_admin`. State it in the review resolution.
4. *should-fix*: seeding uses `$setOnInsert`, so a restart never resurrects an operator's edits: the seed docs themselves are never the operational quarantine state; releasing alice edits `user:alice`, not the seed. `$setOnInsert` on the seed is therefore safe. No issue; verified.

**New libraries / infra dependencies**: none.

**Better alternatives considered**: signing/quarantine-audit trail. Rejected for this change (out of scope); membership mutations already flow through audited admin routes (`set_audit_action`).

**Recommendations**: resolve (1) in the LLD; add (2) as an explicit Accepted Risks entry; keep everything else.

**Questions for author**: none.

**Verdict: APPROVED WITH CHANGES** (finding 1 blocks the draft; finding 2 must be documented before implementation).

---

## Reviewer 5: SMTS (Sage)

Focus: architecture, code quality, maintainability.

**Strengths**
- The design keeps ONE enforcement hook and ONE counter mechanism; the new axis is data (a definition shape), not a new subsystem. That is the difference between a feature and a fork.
- Deciding the three contested semantics up front (403-no-Retry-After vs 429; per-axis admin bypass; fail-open follow) and writing them down is exactly what makes this reviewable and testable.
- Non-goals are explicit and honest (no audit trail, no TTL release, no tool/skill granularity).

**Concerns**
1. *must-fix (process)*: Byte finding 1 / Cipher finding 1 is a genuine spec bug (the guard contradicts the feature). It must be fixed in the LLD before Step 8.5, and the fix re-validated against `rate_limit_routes.py`'s actual guard wiring.
2. *should-fix*: `check()` is accumulating responsibilities (quarantine + three axes). The quarantine block should be two small private helpers (`_is_caller_quarantined`, `_is_target_quarantined`) with the policy (admin bypass, fail-open) visible in one place each, so the next axis does not turn `check()` into a monolith.
3. *should-fix*: reserved-name constants must live in `models.py` (single source of truth) and be imported by routes/CLI/frontend-export surface; no string literals of `__quarantined_*` anywhere else.
4. *note*: `RateLimitDecision.kind` default keeps every existing construction site and test valid (no mass update); good backward-compat shape. Keep the default even though it is stringly typed.

**New libraries / infra dependencies**: none.

**Better alternatives considered**: a `QuarantineService` abstraction. Rejected: premature; two membership lookups do not warrant a service boundary, and the limiter already owns the deny policy.

**Recommendations**: proceed after the LLD revision; keep helpers small; pin the constants in `models.py`.

**Verdict: APPROVED WITH CHANGES**.

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Reset form `group` on axis switch; reuse loaded server/agent lists for the quarantine panel |
| Backend (Byte) | APPROVED WITH CHANGES | 1 (membership guard contradicts feature) | Pairing-rule guard instead of seed-only usage; document `decision.axis` overload; pin multi-group gate test |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | Prove best-effort seeding with an outage test; document admin-path lookup; bounded metric labels + paging note |
| Security (Cipher) | APPROVED WITH CHANGES | 1 (same guard bug) | Fix guard; document admin-bypass-of-caller-quarantine as accepted risk with mitigations |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 (same guard bug, process) | Fix LLD first; small quarantine helpers; constants single-sourced in models.py |

**Blocking findings (to resolve in lld.md before implementation):**
1. **Membership reserved-group guard is self-contradictory** (Byte #1, Cipher #1, Sage #1): replace "reserved group only via the matching seed subject" with subject-kind/group pairing rules (`user`/`client` docs may carry `__quarantined_callers__`; `target` docs may carry `__quarantined_targets__`; cross-usage rejected 400; only the two seed doc ids are undeletable via 409).
2. **Admin bypass of caller quarantine is an undocumented accepted risk** (Cipher #2): document in the LLD with mitigations (target quarantine denies admins; admin status revocable at the IdP).

**Resolution of blocking findings (lld.md revised 2026-09-30 before implementation):**
1. `lld.md` Step 5 now specifies `_validate_membership_reserved` as the pairing rule (reject a membership whose `subject_type` is `target` while carrying `__quarantined_callers__`, or a `user`/`client` carrying `__quarantined_targets__`, or any document carrying BOTH reserved groups; seed docs may not be edited to drop or rename their reserved group), and `delete_rate_limit_membership` returns 409 only for the two seed doc ids. The Data Models and API/CLI sections were corrected to match, so quarantining `user:alice` via a normal membership PUT is valid.
2. `lld.md` Overview gains an explicit Accepted Risks entry for the admin bypass of caller quarantine, with the two mitigations stated; the ops-doc change description includes the same note. (Cipher #3 confirmed: release path is admin-only via `_require_admin` on the membership PUT.)

**Next Steps:**
1. Pixel/Circuit/Sage should-fixes folded into the LLD implementation steps (form-state reset, loaded-list reuse, best-effort seeding test, helper structure, constants in models.py).
2. Proceed to `testing.md` (Step 8), then implementation against the revised LLD (Step 8.5).

No blocking findings remain; proceeding to implementation.
