# Testing Plan: Per-caller-per-target rate limits and quarantine kill switch

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies the third `caller_target` rate-limit axis (independent per (caller, target) counters, group-gated) and the reserved quarantine groups (early absolute deny for quarantined callers and targets), at the `/validate` enforcement hook, through the admin API, CLI, and UI surfaces, including response semantics (throttle 403+marker vs quarantine 403+marker), admin bypass, and store-unavailable behavior.

### Prerequisites
- [ ] Registry + auth-server running (docker-compose up), `RATE_LIMITING_ENABLED=true`
- [ ] DocumentDB/MongoDB reachable; namespaces initialized
- [ ] Admin credentials for `/api/*` and the CLI (`registry_management.py`)
- [ ] A data-plane target registered (e.g. MCP server at `/mcpgw` or an A2A agent path)
- [ ] A non-admin user (`alice`) and an M2M client (`svc-agent`) with valid tokens
- [ ] The auth-server has been restarted at least once AFTER this change (seeding ran)

### Shared Variables
```bash
export REGISTRY_URL="http://localhost"
export ADMIN_TOKEN=$(jq -r '.access_token' .oauth-tokens/admin.json)     # per repo README token bootstrap
export ALICE_TOKEN=$(jq -r '.access_token' .oauth-tokens/alice.json)
export AGENT_TOKEN=$(jq -r '.access_token' .oauth-tokens/agent.json)
export TARGET="/mcpgw"
AUTH="Authorization: Bearer $ADMIN_TOKEN"
CT_JSON="-H Content-Type: application/json"
```

## 1. Functional Tests

### 1.1 Seeding (startup)
```bash
# After auth-server (re)start, the reserved anchors exist with no operator action:
curl -s -H "$AUTH" "$REGISTRY_URL/api/rate-limit-memberships/user:__quarantined_callers__"
# Expect 200: {"subject_type":"user","subject":"__quarantined_callers__","groups":["__quarantined_callers__"]}
curl -s -H "$AUTH" "$REGISTRY_URL/api/rate-limit-memberships/target:__quarantined_targets__"
# Expect 200: {"subject_type":"target","subject":"__quarantined_targets__","groups":["__quarantined_targets__"]}
```
Assertion: restart the auth-server twice; documents unchanged (idempotent `$setOnInsert`, no duplicates).

### 1.2 Create a caller_target definition (API + CLI)
```bash
curl -s -X PUT -H "$AUTH" $CT_JSON \
  "$REGISTRY_URL/api/rate-limits/caller_target:mcp_server:tenant-a:$TARGET:60" \
  -d '{"axis":"caller_target","entity_type":"mcp_server","group":"tenant-a","name":"'"$TARGET"'","user_max_requests":3,"agent_max_requests":2,"window_seconds":60,"fail_closed":false,"enabled":true}'
# Expect 200, echoed definition with axis=caller_target and the 5-segment id
```
```bash
python api/registry_management.py rate-limit-set --axis caller_target --entity-type mcp_server \
  --name "$TARGET" --group tenant-b --user-max-requests 5 --window-seconds 60
# Expect: stored confirmation; visible in rate-limit-list
```
Negative (floors apply to the new axis):
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H "$AUTH" $CT_JSON \
  "$REGISTRY_URL/api/rate-limits/caller_target:mcp_server:tenant-a:$TARGET:30" \
  -d '{"axis":"caller_target","entity_type":"mcp_server","group":"tenant-a","name":"'"$TARGET"'","user_max_requests":1,"window_seconds":30}'
# Expect 400 (below user floor for a <=60s window)
```
Negative (reserved names):
```bash
# A definition whose group is a reserved quarantine name -> 400
# A definition whose name is __quarantined_callers__ -> 400
```
Negative (misplaced `group`):
```bash
# PUT axis=target with a group field -> 400 ("group is only valid on the caller_target axis")
```

### 1.3 Per-(caller, target) enforcement (the core behavior)
Prepare: membership `user:alice -> groups: ["tenant-a"]`; definition as in 1.2 (user limit 3/min to `$TARGET`).

```bash
for i in 1 2 3; do
  curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $ALICE_TOKEN" \
    "$REGISTRY_URL/mcpgw/mcp" -X POST -H 'Content-Type: application/json' -d '{}'
done; echo
# Expect: 200 200 200
curl -s -D - -o /dev/null -H "Authorization: Bearer $ALICE_TOKEN" \
  "$REGISTRY_URL/mcpgw/mcp" -X POST -H 'Content-Type: application/json' -d '{}'
# Expect: HTTP 429 (rewritten by nginx from the 403+marker), headers:
#   X-RateLimit-Limit: 3, X-RateLimit-Remaining: 0, Retry-After: >0
```
Independence assertions:
- Different caller, same target: `svc-agent` in `tenant-a` (agent limit 2) still allowed on its own counter until its own 2 are consumed.
- Same caller, different target: alice against a second registered server is allowed (no shared bucket).
- Non-member caller against `$TARGET`: unaffected (no gate applies).
- Caller in `tenant-b`: governed only by the tenant-b definition.

### 1.4 Caller quarantine (early deny)
```bash
# Quarantine alice: add the reserved caller group to her membership
python api/registry_management.py rate-limit-quarantine-caller --subject alice
# Expect: confirmation; GET membership shows groups includes __quarantined_callers__

curl -s -D - -o /dev/null -H "Authorization: Bearer $ALICE_TOKEN" \
  "$REGISTRY_URL/mcpgw/mcp" -X POST -H 'Content-Type: application/json' -d '{}'
# Expect: HTTP 403 (NOT 429), header X-RateLimit-Quarantined: 1, NO Retry-After header,
#         body error != rate_limit_exceeded (caller_quarantined)
```
Assertions: deny happens before counters (alice's `caller_target` counter is not incremented while quarantined); a fresh token with another username is unaffected; auth-server log contains `rate-limit quarantine: caller quarantined caller_username=alice`; `mcpgw_rate_limit_quarantined_total{subject="caller"}` increased.
Release:
```bash
python api/registry_management.py rate-limit-quarantine-caller --subject alice --release
# Traffic restored on the next request (cache TTL <=30s; invalidate happens on the PUT)
```

### 1.5 Target quarantine
```bash
python api/registry_management.py rate-limit-quarantine-target --subject "$TARGET"
curl -s -D - -o /dev/null -H "Authorization: Bearer $ALICE_TOKEN" "$REGISTRY_URL$TARGET/mcp" -X POST -d '{}'
curl -s -D - -o /dev/null -H "Authorization: Bearer $AGENT_TOKEN" "$REGISTRY_URL$TARGET/mcp" -X POST -d '{}'
curl -s -D - -o /dev/null -H "$AUTH"                   "$REGISTRY_URL$TARGET/mcp" -X POST -d '{}'
# Expect: 403 + X-RateLimit-Quarantined: 1 for ALL three (admin included), no Retry-After
```
Release and verify restoration. Seed-delete protection:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -H "$AUTH" \
  "$REGISTRY_URL/api/rate-limit-memberships/target:__quarantined_targets__"
# Expect 409
```

### 1.6 Store-unavailable failure mode
Stop DocumentDB (or point the auth-server at an unreachable store via a test profile):
- Quarantined-caller deny still evaluated from the last cached groups (30s TTL); after expiry, with `RATE_LIMIT_FAIL_OPEN=true` (default) traffic is ALLOWED and a WARNING `rate-limit quarantine lookup failed (fail-open)` is logged; with `RATE_LIMIT_FAIL_OPEN=false` traffic is DENIED.
- Counters behave as today (existing fail-open/closed tests still pass).
Restore the store; confirm recovery without restart.

### 1.7 CLI quarantine listing
```bash
python api/registry_management.py rate-limit-quarantine-list
# Expect: quarantined callers and targets with their subjects; empty lists after all releases
```

## 2. Backwards Compatibility Tests
- [ ] With `RATE_LIMITING_ENABLED=false`: all `/validate` behavior identical to pre-change (no limiter calls, no seeding errors in logs, quarantine groups still seeded but inert).
- [ ] Existing `caller` and `target` definitions enforce exactly as before (rerun the original issue-#295 smoke from `docs/design/rate-limiting.md`).
- [ ] PUT definition bodies WITHOUT `group` for axes caller/target still accepted (group omitted = absent, not None-string).
- [ ] `PUT axis=target with a group` is REJECTED 400 (new rule) - confirm no existing client sends group today (`grep -rn '"group"' api/registry_client.py` shows it only on the new path).
- [ ] `RateLimitDecision` consumers: existing tests constructing `RateLimitDecision(...)` positionally/keyword still pass (`kind` defaults to `"throttle"`); `headers()` output unchanged for throttle decisions.
- [ ] Membership PUT with `subject_type` user/client unchanged; the new `target` subject type is additive.
- [ ] `rate-limit-list` output shape unchanged (definitions simply may include the new axis); frontend list renders new rows without errors.

## 3. UX Tests
- [ ] Settings > IAM > Rate Limits: axis dropdown offers "caller_target (per caller, per target)"; selecting it shows Target type + Target name + Group fields and hides user/agent limit fields until limits are entered; switching axis back clears `group` (no stale submit).
- [ ] Definition list shows the caller_target row with `user N, agent M / 60s @ group tenant-a`.
- [ ] Quarantine panel (definitions list view): quarantined targets listed with Release; quarantining a target from the panel makes the definitions-table row show the red `QUARANTINED` badge.
- [ ] Users page: alice's rate-limit group chips show a red `quarantined` chip for `__quarantined_callers__`; the editor's option list offers the reserved group with a "(quarantine: block all)" hint; saving works and the chip renders red.
- [ ] M2M page: same editor behavior for a client subject.
- [ ] CLI: `rate-limit-quarantine-caller --subject alice` then `--release` print clear confirmations; `rate-limit-quarantine-list` output is empty after releases.

## 4. Deployment Surface Tests
### 4.1 Docker wiring
**Not Applicable** - no new environment variables, images, or compose changes; existing compose files exercise the feature unchanged (verified by 1.1-1.6 under docker-compose).

### 4.2 Terraform / ECS wiring
**Not Applicable** - no new parameters; task constraints forbid new deployment configuration.

### 4.3 Helm / EKS wiring
**Not Applicable** - no new values; charts unchanged.

### 4.4 Deploy and verify
- [ ] Fresh deployment (empty DB): startup seeds both anchors; `rate-limit-quarantine-list` shows none quarantined.
- [ ] Upgrade deployment (existing DB with limits): pre-existing definitions/memberships untouched by seeding (`$setOnInsert`).

### 4.5 Rollback verification
- [ ] Release quarantines (membership edits) and roll the image back: previous version ignores the reserved groups (unknown group = no gate) and unknown axis definitions are skipped by the malformed-doc guard (`skipping malformed rate-limit definition`), i.e. rollback is safe and non-destructive.

## 5. End-to-End API Tests
- [ ] **Fair-share scenario**: two tenants (tenant-a, tenant-b) each with a `caller_target` limit to `$TARGET`; blast tenant-a's user to its cap; assert tenant-b traffic unaffected AND the target-axis aggregate (if configured) is what eventually throttles both.
- [ ] **Kill-switch scenario**: quarantine a compromised client (`rate-limit-quarantine-caller --subject svc-agent`); assert immediate 403+quarantine marker on its very next request (no 429 warm-up, no window wait); release; assert recovery.
- [ ] **Target out-of-rotation scenario**: quarantine `$TARGET`; assert all callers (user, agent, admin) denied; release; assert recovery.
- [ ] **Priority scenario**: caller quarantined AND target quarantined AND over a caller_target limit -> quarantine deny wins (early return), counter untouched.
- [ ] **Unit suite**: `uv run pytest tests/unit/rate_limiting tests/unit/api/test_rate_limit_routes.py` passes including the new `test_quarantine_and_caller_target.py` (early-deny ordering, admin matrix, composite counters independence, most-restrictive multi-group gate, fail-open/closed lookup, seeding best-effort) and the extended model/route tests.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) verified or marked Not Applicable with justification
- [ ] Section 5 (E2E) verified
- [ ] Unit tests added under `tests/unit/rate_limiting/` and `tests/unit/api/`
- [ ] `uv run pytest tests/unit/rate_limiting tests/unit/api` passes with no regressions
