# Testing Plan: Consistent CSRF Across Toggle Endpoints

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies that every toggle endpoint enforces CSRF exactly when a session cookie is present (missing/invalid token -> 403; valid token -> pass) and never rejects cookie-less bearer-token requests with a CSRF error. Covers the dependency unit matrix, the real route signatures for agents and skills, and backwards compatibility for the SPA and the strict dependency's existing users.

### Prerequisites
- [ ] Registry code checked out at `v1.0.20` with `patch.diff` applied
- [ ] Python environment with repo dev dependencies (`uv sync` or equivalent) for running `tests/`
- [ ] No external services needed: all tests use FastAPI `TestClient` with dependency overrides

### Shared Variables
```bash
# Used inside pytest; shown here for the manual curl variants.
COOKIE_NAME="mcp_gateway_session"          # settings.session_cookie_name
SESSION_ID="0123456789abcdefTESTSESSION"   # any opaque string; tokens bind to it
# Mint a valid token bound to SESSION_ID with the repo's own signer:
#   python -c "from registry.auth.csrf import generate_csrf_token; print(generate_csrf_token('$SESSION_ID'))"
# export it as:
export CSRF_TOKEN="<output of generate_csrf_token>"
```

## 1. Functional Tests

### 1.1 curl / HTTP Tests

#### 1.1.1 Dependency unit matrix (`tests/unit/auth/test_csrf.py`, new file)

Drives a minimal FastAPI app (`POST /probe` protected by `verify_csrf_token_if_session_cookie` only) so the dependency is tested without route internals.

| # | Request setup | Expected |
|---|---------------|----------|
| 1 | No cookie, no token | 200 (skip path; no CSRF error) |
| 2 | Cookie `mcp_gateway_session=$SESSION_ID`, no token | 403, detail `CSRF validation failed: no token provided` |
| 3 | Cookie present, `X-CSRF-Token: garbage` | 403, detail `CSRF validation failed: invalid token` |
| 4 | Cookie present, valid token for a DIFFERENT session id | 403, detail `CSRF validation failed: invalid token` |
| 5 | Cookie present, `X-CSRF-Token: $CSRF_TOKEN` | 200 |
| 6 | Cookie present, valid token as `csrf_token` form field | 200 |
| 7 | Cookie present + `Authorization: Bearer x` + no token | 403 (hybrid: cookie wins, stricter branch) |

```bash
cd <repo> && uv run pytest tests/unit/auth/test_csrf.py -v
```

#### 1.1.2 Agent toggle (`POST /api/agents/{path}/toggle`)

In `tests/unit/api/test_agent_routes.py` (new test class alongside the existing toggle tests; auth dependency overridden, CSRF dependency NOT overridden):

| # | Request setup | Expected |
|---|---------------|----------|
| 1 | Bearer/M2M style: no cookie, no token (nginx_proxied_auth overridden to a context with `toggle_service` permission) | 200, agent toggled |
| 2 | Cookie present, no token | 403 `no token provided` |
| 3 | Cookie present, invalid token | 403 `invalid token` |
| 4 | Cookie present, valid token bound to cookie value | 200, agent toggled |

```bash
cd <repo> && uv run pytest tests/unit/api/test_agent_routes.py -k toggle -v
```

Manual browser-path check against a running stack:

```bash
curl -i -X POST "https://localhost/api/agents/test-agent/toggle?enabled=true" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H "Cookie: $COOKIE_NAME=$SESSION_ID"
# expect 200; without the header expect 403 CSRF validation failed
```

Manual bearer-path check (the issue's repro; must now pass):

```bash
curl -i -X POST "https://localhost/api/agents/test-agent/toggle?enabled=true" \
  -H "Authorization: Bearer $M2M_JWT"
# expect 200 (previously: 403 CSRF validation failed: no token provided)
```

#### 1.1.3 Skill toggle (`POST /api/skills/{path}/toggle`)

Same four-case matrix as 1.1.2 in `tests/unit/api/test_skill_routes.py` (new file, agent test conventions: `ToggleStateRequest` JSON body `{"enabled": true}`).

```bash
cd <repo> && uv run pytest tests/unit/api/test_skill_routes.py -k toggle -v
```

### 1.2 CLI Tests

**Not Applicable** - the change adds no CLI commands; toggles are HTTP-only.

## 2. Backwards Compatibility Tests

- [ ] **Strict dependency untouched:** `verify_csrf_token_flexible` still exists with identical behavior; `POST /api/logout` and the server edit form still enforce it (existing tests in `tests/unit/api/test_server_routes.py` pass unchanged).
- [ ] **SPA wire contract unchanged:** with cookie + valid `X-CSRF-Token`, every toggle route returns 200; `GET /api/auth/csrf-token` still returns `{"csrf_token": ...}` bound to the caller's session (no response shape change).
- [ ] **Deliberate hardening change (not a regression):** cookie-bearing requests WITHOUT a token to `POST /api/servers/toggle` and `POST /api/virtual-servers/{path}/toggle` previously succeeded and now get 403. Verify with:

```bash
curl -i -X POST "https://localhost/api/servers/toggle" \
  -H "Cookie: $COOKIE_NAME=$SESSION_ID" \
  -F "path=/test-server" -F "new_state=true"
# after patch: 403 CSRF validation failed: no token provided (previously 200)
```

- [ ] **Bearer path to `/api/servers/toggle` and virtual-server toggle:** no cookie + `Authorization: Bearer` still succeeds (no new CSRF error for pure bearer calls).

## 3. UX Tests

- [ ] SPA toggle switches (Agent/Skill/Server/VirtualServer cards) still flip state when clicked by a logged-in user (interceptor attaches the token automatically).
- [ ] With an expired session, a toggle click surfaces the existing error toast (403 from auth or CSRF) and does not hang or silently no-op.
- [ ] No new user-facing error strings; all 403 details are the pre-existing `CSRF validation failed: ...` messages.

## 4. Deployment Surface Tests

### 4.1 Docker wiring
**Not Applicable** - no Dockerfile, compose, or env var changes.

### 4.2 Terraform / ECS wiring
**Not Applicable** - no Terraform variables or task definitions change.

### 4.3 Helm / EKS wiring
**Not Applicable** - no chart values change.

### 4.4 Deploy and verify
- [ ] After a normal image build + deploy, run the manual curl checks from 1.1.2/1.1.3 and Section 2 against the running registry.

### 4.5 Rollback verification
- [ ] Rolling back to the previous image restores prior behavior (agent/skill bearer toggles 403 again; unprotected routes unprotected again) with no config cleanup needed, since no configuration surface changed.

## 5. End-to-End API Tests

- [ ] **M2M pipeline (the issue scenario):** register a new agent with a bearer token (`POST /api/agents` family), then enable it with the same token (`POST /api/agents/{path}/toggle?enabled=true`) - both succeed; repeat for skills. Before the patch the second step fails with 403.
- [ ] **SPA session:** log in via the UI, fetch `/api/auth/csrf-token`, toggle an agent OFF then ON, toggle a skill, toggle a virtual server - all succeed with cookie + header; replay the virtual-server toggle WITHOUT the header and confirm 403.
- [ ] **Internal caller:** `POST /api/internal/toggle` with a valid internal JWT and no cookie still succeeds (defense-in-depth dependency is a no-op there).

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes: `uv run pytest tests/unit/auth/test_csrf.py tests/unit/api/test_agent_routes.py tests/unit/api/test_skill_routes.py -v`
- [ ] Section 2 (Backwards Compat) verified: existing `tests/unit/api/test_server_routes.py` pass unchanged; compat curl checks recorded above
- [ ] Section 3 (UX) verified or marked Not Applicable (manual SPA pass)
- [ ] Section 4 (Deployment) verified or marked Not Applicable (no deployment surface change)
- [ ] Section 5 (E2E) verified (manual/API-level scenarios above)
- [ ] Unit tests added under `tests/unit/auth/` (dependency matrix)
- [ ] Route-level tests added under `tests/unit/api/` (agent, skill)
- [ ] `uv run pytest tests/` passes with no regressions

> Note per skill constraints: tests were designed and shipped in `patch.diff` but NOT executed during this benchmark run; Section 6 commands are for a human or CI to run.
