# Implementation Summary: Per-caller-per-target rate limits and quarantine kill switch

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Two features land at the existing single enforcement hook (`RateLimiter.check()` in `registry/rate_limiting/limiter.py`). First, a third `caller_target` rate-limit axis: a definition names the classified target plus the caller's rate-limit group, and the counter subject is the composite `<identity>|<target_name>`, giving every (caller, target) pair an independent quota. Second, quarantine: two reserved groups (`__quarantined_callers__`, `__quarantined_targets__`), auto-seeded as frozen anchor membership documents at auth-server startup, undeletable, and evaluated as an early deny before any counter work. A quarantine deny is a plain 403 with an `X-RateLimit-Quarantined: 1` marker and no `Retry-After` (deliberately NOT the throttle marker, so nginx's 429 rewrite does not fire and no nginx change is needed); admins bypass caller quarantine but not target quarantine; the target-quarantine lookup follows the global fail-open policy.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/rate_limiting/models.py` | modified | +104 / -8 | `caller_target` axis + `group` field + validator branches; `target` membership subject; quarantine constants; `RateLimitDecision.kind` + `quarantine()` + marker headers |
| `registry/rate_limiting/limiter.py` | modified | +124 / -5 | Early quarantine deny in `check()` (per-axis admin bypass); `_is_caller_quarantined` / `_is_target_quarantined` (fail-open policy); `_build_caller_target_gates` (composite subject) |
| `registry/rate_limiting/definitions_repository.py` | modified | +30 / -0 | Cached `list_caller_target_limits(entity_type, name, groups)` query |
| `registry/rate_limiting/memberships_repository.py` | modified | +47 / -1 | `get_groups_for_target`; idempotent `ensure_quarantine_seeds` (`$setOnInsert` + cache invalidation); `QUARANTINE_SEED_IDS` |
| `auth_server/rate_limiting_config.py` | modified | +18 / -0 | Best-effort `ensure_quarantine_groups_seeded()` startup helper (never raises) |
| `auth_server/server.py` | modified | +21 / -1 | Startup seeding call (every boot); quarantine-vs-throttle `error` code in the 403 detail |
| `registry/api/rate_limit_routes.py` | modified | +106 / -2 | `_validate_reserved_groups` (definitions), `_validate_membership_reserved` (subject-kind/group pairing), seed-delete 409, floors extended to `caller_target` |
| `api/registry_client.py` | modified | +26 / -3 | `group` passthrough + 5-segment id on `set_rate_limit`; new `get_rate_limit_membership` |
| `api/registry_management.py` | modified | +121 / -2 | `--axis caller_target`, `--group`, `rate-limit-quarantine-list / -caller / -target` (with `--release`) |
| `frontend/src/hooks/useRateLimits.ts` | modified | +20 / -7 | New axis type/id builder; quarantine group exports; `target` subject type |
| `frontend/src/components/IAMRateLimits.tsx` | modified | +200 / -10 | `caller_target` form fields (with axis-switch reset); quarantine panel (quarantine/release targets); stat tiles; `QUARANTINED` row badge |
| `frontend/src/components/iam/RateLimitGroupsEditor.tsx` | modified | +26 / -3 | Quarantine option in the group select; red `quarantined:` chip (Users + M2M pages) |
| `docs/design/rate-limiting.md` | modified | +21 / -3 | Three-axes section; Quarantine (Kill Switch) section with decided semantics |
| `registry/observability/meters.py` | modified | +9 / -0 | `mcpgw_rate_limit_quarantined_total{subject=caller\|target}` |
| `tests/unit/rate_limiting/test_limiter.py` | modified | +304 / -5 | Composite-counter independence, group gating, per-caller-type limits, quarantine early-deny/admin matrix, fail-open/closed lookup, quarantine-wins-over-throttle |
| `tests/unit/rate_limiting/test_models.py` | modified | +109 / -0 | `caller_target` validator cases; `target` membership subject; decision-kind/headers |
| `tests/unit/api/test_rate_limit_routes.py` | modified | +104 / -0 | Reserved-name 400s, pairing rules, 5-segment PUT, seed-delete 409 |
| `tests/unit/rate_limiting/test_quarantine_seeding.py` | added | +95 / -0 | Seeding idempotence/`$setOnInsert`/cache invalidation; store-outage never blocks startup |

Totals: 18 files, +1485 / -50.

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

## Deviations from the LLD
- The LLD sketched a `QUARANTINE_SEED_IDS` tuple in `memberships_repository.py` and derived seed ids from `QUARANTINE_SEED_SUBJECT_TYPES`; implemented as written (ids derived the same way), with the tuple defined next to the repository as the routes' guard input. No functional deviation.
- `IAMRateLimits` quarantine panel reuses the already-loaded `useServerList`/`useAgentList` data (per the review should-fix) rather than adding a new fetch, exactly as the revised LLD's form-hygiene note specifies.
- Route guard for membership reserved-group edits is stricter than the LLD sketch in one respect: ANY edit of a seed document (even removing foreign groups) is rejected 400, since seeds are frozen anchors. This is the LLD's clause (d) applied literally.

## Not Implemented / Follow-ups
- Quarantine audit trail / reason metadata and TTL auto-release: deferred by the LLD's non-goals.
- `mcp_tool` / `a2a_skill` classification for the new axis: inherits the existing `UNENFORCED_ENTITY_TYPES` 400 guard, per non-goals.
- The `eval.json` / `metrics.json` files present in the artifact directory belong to the harness, not to this change.

## Verification (not executed)
Per skill constraints the target repo's tests were NOT run. The full executable plan (functional, backwards-compat, UX, deployment-surface, E2E) is in `./testing.md`; unit tests added by the patch cover the limiter contract (composite counters, quarantine ordering/admin matrix, fail-open/closed), the model validators, the route guards, and the seeding helper. All edited Python files pass `ast.parse` (a syntax read, not project execution); `patch.diff` was verified with `git apply --check` against a clean `1.27.1` checkout.
