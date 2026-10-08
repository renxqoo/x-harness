# Testing Plan: Consistent, Bearer-Compatible CSRF Protection Across Toggle Endpoints

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing

Verify that all five user-facing toggle endpoints enforce CSRF for cookie-bearing (browser) requests, skip CSRF for bearer-token M2M requests (no session cookie), and that unauthenticated requests still receive 401 before any CSRF evaluation. Covers the new shared dependency's unit behavior, per-endpoint route behavior, the repo's own federation script, and documentation consistency.

### Prerequisites

- [ ] Registry API running locally (`docker-compose up` or `uv run uvicorn registry.main:app --port 7860`) with nginx + auth server for deployment-surface tests; unit tests need neither.
- [ ] An admin bearer token (Keycloak/client-credentials or `REGISTRY_API_TOKEN` per docs) in `$TOKEN`.
- [ ] A valid browser session: login via the SPA (or `GET /api/auth/csrf-token` with a session cookie) in `$COOKIE_JAR`, plus a fetched CSRF token in `$CSRF`.
- [ ] `jq` available for JSON parsing.

### Shared Variables

```bash
export REGISTRY_URL="http://localhost"          # via nginx (deployment tests)
export DIRECT_URL="http://localhost:7860"       # direct FastAPI (dev mode tests)
export TEST_AGENT="/test-csrf-agent"
export TEST_SKILL="test-csrf-skill"
export TEST_SERVER="/test-csrf-server"
export TEST_VSERVER="virtual/test-csrf-vserver"
# Browser session (cookie jar + token):
# CSRF=$(curl -s -b "$COOKIE_JAR" "$REGISTRY_URL/api/auth/csrf-token" | jq -r .csrf_token)
```

## 1. Functional Tests

### 1.1 curl / HTTP Tests

#### 1.1.1 Bearer-token M2M can toggle agent and skill (the reported bug)

```bash
# Pre-register via bearer (works today), then enable (fails before the fix, 200 after):
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/agents${TEST_AGENT}/toggle?enabled=true" \
  -H "Authorization: Bearer $TOKEN"
# Expected: 200 (before fix: 403 CSRF validation failed: no token provided)

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/skills/${TEST_SKILL}/toggle" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true}'
# Expected: 200
```

Assertions: HTTP 200; agent listing shows `"enabled": true`; skill listing shows `"is_enabled": true`.

#### 1.1.2 Bearer-token toggles for server API and virtual server keep working

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/servers/toggle" \
  -H "Authorization: Bearer $TOKEN" \
  -F "path=${TEST_SERVER}" -F "new_state=true"
# Expected: 200

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/virtual-servers/${TEST_VSERVER}/toggle" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true}'
# Expected: 200 (admin-scoped token required)
```

#### 1.1.3 Cookie session without CSRF token is rejected on every toggle endpoint (negative case, per endpoint)

```bash
for ep in \
  "POST $REGISTRY_URL/api/toggle${TEST_SERVER}" \
  "POST $REGISTRY_URL/api/servers/toggle" \
  "POST $REGISTRY_URL/api/agents${TEST_AGENT}/toggle?enabled=true" \
  "POST $REGISTRY_URL/api/skills/${TEST_SKILL}/toggle" \
  "POST $REGISTRY_URL/api/virtual-servers/${TEST_VSERVER}/toggle"; do
  set -- $ep
  curl -s -o /dev/null -w "%{http_code}\n" -X "$2" "$3" -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" -d '{}'
done
# Expected: 403 from every endpoint; body {"detail":"CSRF validation failed: no token provided"}
```

#### 1.1.4 Cookie session WITH valid CSRF token succeeds (positive browser path)

```bash
CSRF=$(curl -s -b "$COOKIE_JAR" "$REGISTRY_URL/api/auth/csrf-token" | jq -r .csrf_token)

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/virtual-servers/${TEST_VSERVER}/toggle" \
  -b "$COOKIE_JAR" -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
# Expected: 200

# Form-field token variant on the form-native endpoints:
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/servers/toggle" -b "$COOKIE_JAR" \
  -F "path=${TEST_SERVER}" -F "new_state=false" -F "csrf_token=${CSRF}"
# Expected: 200
```

#### 1.1.5 Garbage token / forged form field is rejected (cross-site forgery shape)

```bash
# Cross-site attacker CAN post a form with a csrf_token field, but CANNOT know its value:
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/servers/toggle" -b "$COOKIE_JAR" \
  -F "path=${TEST_SERVER}" -F "new_state=true" -F "csrf_token=forged-value"
# Expected: 403 {"detail":"CSRF validation failed: invalid token"}

curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/virtual-servers/${TEST_VSERVER}/toggle" \
  -b "$COOKIE_JAR" -H "Content-Type: application/json" \
  -H "X-CSRF-Token: forged-value" -d '{"enabled": true}'
# Expected: 403 invalid token
```

#### 1.1.6 Unauthenticated request returns 401 (not 403)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/agents${TEST_AGENT}/toggle?enabled=true"
# Expected: 401 (auth dependency resolves before CSRF; no cookie, no bearer)
```

### 1.2 CLI / Script Tests

#### 1.2.1 Federation script stays green (repo's own automation)

```bash
cd scripts && SECRET_KEY="$SECRET_KEY_A" bash test-peer-federation-docker.sh
# Expected: script completes; "Servers enabled" section succeeds.
# The script now fetches a CSRF token with COOKIE_A and sends X-CSRF-Token
# on both /api/servers/toggle calls (per lld.md Step 6).
```

#### 1.2.2 Header-auth script needs no token

```bash
cd scripts && bash test-peer-federation.sh
# Expected: unchanged behavior; cookie-less header-auth toggle calls skip CSRF.
```

## 2. Backwards Compatibility Tests

- [ ] **Bearer clients on the previously-open endpoints:** `/api/servers/toggle` and `/api/virtual-servers/*/toggle` called with only a bearer token behave exactly as before (1.1.2).
- [ ] **Bearer clients on the previously-blocked endpoints:** agent/skill toggle transitions from 403 to 200 with no request change - this is the fix; document in release notes, no client change needed.
- [ ] **SPA without code changes:** drive the SPA UI (toggle an agent, skill, server, virtual server); every action succeeds because `AuthContext.tsx` already sends `X-CSRF-Token`.
- [ ] **Legacy UI toggle route:** `POST /api/toggle/{path}` with cookie + `csrf_token` form field still succeeds, and without token still 403s (its behavior is unchanged by the refactor from `verify_csrf_token_flexible` to the shared dependency).
- [ ] **Logout and edit-server form:** `POST /api/auth/logout` and `POST /api/edit/{path}` keep using `verify_csrf_token_flexible`; verify both still 403 without token and 200 with token.
- [ ] **Internal toggle unchanged:** `POST /api/internal/toggle` with `Authorization: Bearer <internal JWT>` (signed with `SECRET_KEY`, per `registry/auth/internal.py`) still succeeds with NO cookie and NO CSRF token.

```bash
INTERNAL_TOKEN=$(python3 -c "from registry.auth.internal import generate_internal_token; print(generate_internal_token('it'))")
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$DIRECT_URL/api/internal/toggle" \
  -H "Authorization: Bearer $INTERNAL_TOKEN" -F "service_path=${TEST_SERVER}"
# Expected: 200/404 (service-path dependent), never 403 CSRF
```

## 3. UX Tests

- [ ] SPA toggle switch on AgentCard, SkillCard, server row, and VirtualServerList still flips state and shows the success toast (cookie + interceptor header).
- [ ] Force `csrfToken = null` in the SPA (simulate failed `/api/auth/csrf-token` fetch) and attempt a server toggle: UI shows the failure toast with the 403 detail; after page refresh (token re-fetched) the same toggle succeeds.
- [ ] CLI/API error message clarity: a bearer client sending a stale `X-CSRF-Token` header *with* a session cookie that mismatches receives `403 CSRF validation failed: invalid token` (message strings unchanged from the existing dependency).

## 4. Deployment Surface Tests

### 4.1 Docker wiring

```bash
grep -rn "CSRF" docker-compose.yml docker/*.conf
# Expected: no matches needed - the change introduces no new env vars or nginx directives.
docker compose up -d registry
```

### 4.2 Terraform / ECS wiring

**Not Applicable** - no new configuration parameters; container image only.

### 4.3 Helm / EKS wiring

**Not Applicable** - no chart values change; `charts/` untouched by this patch.

### 4.4 Deploy and verify

```bash
# After deploying the patched image, run sections 1.1.1-1.1.6 against $REGISTRY_URL.
# Verify skip-path log on bearer calls:
docker logs $(docker ps -qf name=registry) 2>&1 | grep "CSRF check skipped: no session cookie"
# Expected: one debug line per bearer toggle call (bearer path taken).
```

### 4.5 Rollback verification

```bash
# Revert to the previous image tag, then:
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/agents${TEST_AGENT}/toggle?enabled=true" -H "Authorization: Bearer $TOKEN"
# Expected: 403 again (pre-fix behavior) - confirms rollback restored prior state.
```

## 5. End-to-End API Tests

### 5.1 M2M registration pipeline completes (the issue scenario)

```bash
# 1. Register agent (bearer) -> 200
curl -s -X POST "$REGISTRY_URL/api/agents/register" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"csrf-e2e-agent","description":"e2e","path":"/csrf-e2e-agent","provider":"custom","provider_id":"x","endpoint_url":"http://localhost:9999/mcp"}' | jq .success
# 2. Immediately enable it (bearer) -> 200 (THE fix; was 403)
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$REGISTRY_URL/api/agents/csrf-e2e-agent/toggle?enabled=true" -H "Authorization: Bearer $TOKEN"
# 3. Confirm enabled
curl -s "$REGISTRY_URL/api/agents/csrf-e2e-agent" -H "Authorization: Bearer $TOKEN" | jq .enabled
# Expected: true
```

Repeat steps 1-3 for a skill via `POST /api/skills/register` + `POST /api/skills/{path}/toggle` (disabled-by-default then enabled).

### 5.2 Browser full journey

Login through the SPA, register nothing, then toggle each asset type on the dashboard (server, agent, skill, virtual server): all four succeed; concurrently, replay one of those toggle requests from a fresh context WITHOUT the `X-CSRF-Token` header (same cookie jar, e.g. curl) and confirm 403 - proving the enforcement holds even while the SPA's own requests pass.

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/auth/test_csrf_dependency.py` (dependency: cookie+token pass; cookie w/o token 403; wrong token 403; no-cookie skip; form-field token; header-preferred)
- [ ] Route-level tests added under `tests/unit/api/test_toggle_csrf_consistency.py` (bearer/browser/negative per toggle endpoint; 401-before-403 ordering; `/api/toggle/{path}` always enforces)
- [ ] `uv run pytest tests/unit -k csrf` passes with the new tests
- [ ] `uv run pytest tests/` passes with no regressions
