# GitHub Issue: Per-caller-per-target rate limits and quarantine kill switch

## Title
Add a `caller_target` rate-limit axis (per caller, per target quotas) and reserved quarantine groups (absolute deny) at the `/validate` enforcement hook

## Labels
- enhancement
- security
- rate-limiting
- multi-tenancy

## Description

### Problem Statement
The application-level rate limiter enforces limits on two axes at the auth-server `/validate` chokepoint:

1. A **caller axis** (`axis="caller"`): a per-group quota with separate user/agent limits, counted per caller across all targets. A caller's traffic to server X consumes the same bucket as its traffic to server Y.
2. A **target axis** (`axis="target"`): one shared counter per target across all callers. On a shared multi-tenant backend, one noisy caller consumes another caller's headroom against the same server.

Two capabilities operators of shared deployments keep asking for cannot be expressed with these two axes:

- **"Each caller may call each target only N times per window."** No existing axis expresses an independent quota per (caller, target) pair. Fair-share per caller AND per target is impossible today.
- **An absolute kill switch.** When a caller is compromised or a target must be pulled from rotation, the only lever is setting a group limit very low, which (a) still lets traffic through, (b) is subject to the configuration-time floor safeguard (`rate_limit_user_floor_per_min` / `rate_limit_agent_floor_per_min`), and (c) resets at the next window boundary. Operators need to drop all matching traffic immediately and indefinitely.

### Proposed Solution
Two features, both landing at the existing single enforcement hook (`RateLimiter.check()`), with no new deployment configuration, no nginx template changes, and no new infrastructure:

1. **A third `caller_target` axis.** The counter subject is the composite of the caller identity and the classified target entity (`<identity>|<target_name>`). A definition names the target (`entity_type` + `name`, same classification as the target axis) and the rate-limit **group** the caller must belong to (reusing the existing `rate_limit_memberships` storage), plus the existing per-caller-type limits (`user_max_requests` / `agent_max_requests`). It only applies where a request classifies to a target, and only for callers in the group.
2. **Quarantine.** Two reserved rate-limit groups, `__quarantined_callers__` and `__quarantined_targets__`, auto-seeded empty at startup (as permanent membership anchor documents) so an operator never has to create them, and undeletable. A caller is quarantined by adding the reserved caller group to its membership (the existing membership editor/API/CLI); a target is quarantined by a `target`-subject membership mapped to the reserved target group. Both are evaluated as an early deny before any counter work.

Decided semantics (justified in the LLD):
- A quarantine deny returns **403 with an `X-RateLimit-Quarantined: 1` marker and no `Retry-After`** (it is an indefinite authorization-level block, not a throttle; no 429 rewrite, and therefore no nginx change). A throttle keeps today's 403 + `X-RateLimit-Throttled` marker that nginx rewrites to 429 + `Retry-After`.
- **Admin bypass follows the axis**: an admin caller bypasses its own caller-axis quarantine (consistent with the existing caller-gate bypass so an operator cannot lock themselves out), but a quarantined **target** denies everyone, admins included (consistent with target gates protecting a weak backend).
- **Failure mode when the backing store is unavailable**: the target-quarantine lookup follows the existing global `RATE_LIMIT_FAIL_OPEN` policy (fail-open by default to preserve availability; operators running security-critical deployments already set it to `false`, and quarantine then fails closed). Caller quarantine keys off the caller-groups lookup that caller gates already perform, so it introduces no new store dependency and no new failure mode.

### User Stories
- As an operator of a shared multi-tenant gateway, I want to cap each caller per target (e.g. every agent may send at most 30 requests/min to the `mcpgw` server) so that one noisy tenant cannot consume another tenant's headroom against the same backend.
- As an operator responding to a compromised credential, I want to quarantine a caller immediately so that all of its data-plane traffic is dropped at the gateway with no window reset and no floor safeguard in the way.
- As an operator, I want to quarantine a misbehaving or failing target so that it is pulled from rotation instantly while I investigate, without re-registering it or editing nginx.
- As an operator, I want to release a quarantine with the same one-step edit I used to apply it, through the admin API, CLI, or UI I already use for rate-limit groups.

### Acceptance Criteria
- [ ] `axis="caller_target"` definitions are accepted by the model, admin API, CLI, and UI; the definition names the target entity type, the target name, and the rate-limit group; at least one of `user_max_requests` / `agent_max_requests` is required; the id format is `caller_target:<entity_type>:<group>:<name>:<window_seconds>`.
- [ ] A non-admin caller in group G calling target T is throttled once its per-window (identity, T) counter exceeds the definition's limit for its caller type; a different caller against T has an independent counter, and the same caller against a different target has an independent counter.
- [ ] `caller_target` gates apply only to requests that classify to a target (data plane), only to non-admin callers in the group, and are enforced at the same `RateLimiter.check()` hook with the same deny-does-not-consume, tightest-window-first, fail-open/closed behavior as existing gates.
- [ ] Short-window (`<= 60s`) `caller_target` definitions below the per-minute floors are rejected at config time (same lockout safeguard as the caller axis).
- [ ] The two reserved quarantine groups exist (seeded empty, permanent anchor documents in the rate-limit membership collection) without any operator action after startup, and attempts to delete them or to define limits on them are rejected with 400.
- [ ] A non-admin caller whose membership contains `__quarantined_callers__` is denied at `/validate` before any counter operation, with 403 + `X-RateLimit-Quarantined: 1`, no `Retry-After`, and no 429 rewrite; removing the group releases the quarantine.
- [ ] A target whose `target`-subject membership contains `__quarantined_targets__` is denied for all callers (admins included) with the same response shape.
- [ ] An admin caller is NOT denied by its own caller quarantine (existing caller-gate bypass), and quarantine of a target still denies admin traffic.
- [ ] A quarantine deny emits a dedicated low-cardinality metric and a WARNING log line carrying the identity fields, mirroring the existing throttle observability.
- [ ] When the backing store errors during the target-quarantine lookup, behavior follows `RATE_LIMIT_FAIL_OPEN` (default: allow and log; `false`: deny).
- [ ] No new environment variables, no nginx template changes, no new collections beyond the existing two; everything manageable through the existing admin API routes, `registry_management.py` CLI, and Settings UI.
- [ ] Existing behavior is unchanged when `RATE_LIMITING_ENABLED=false` and for deployments that define only caller/target-axis limits.

### Out of Scope
- Fine-grained tool/skill classification (`mcp_tool` / `a2a_skill`): remains modeled but unenforced, unchanged.
- New counter backends (Redis) or a new quarantine storage collection.
- Quarantine audit trail / approval workflow, TTL-based auto-release, and quarantine reason metadata.
- nginx changes of any kind (the quarantine marker is consumed by logs/metrics; the client-visible status is a plain 403).
- Per-caller-per-target quotas on the caller identity itself without a group (a caller is always subject via membership, matching the existing model).

### Dependencies
- None new. Uses the existing DocumentDB collections (`mcp_rate_limits`, `rate_limit_memberships`, `rate_limit_counters`), the existing memberships repository/cache, and the existing `/validate` enforcement wiring.

### Related Issues
- #295 (application-level rate limiting: the two existing axes this extends)
- #1504 (this request)
