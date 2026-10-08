# Low-Level Design: Consistent, Bearer-Compatible CSRF Protection Across Toggle Endpoints

*Created: 2026-09-29*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (revised after expert review, see `./review.md`)*

## Table of Contents
1. [Overview](#overview)
2. [Codebase Analysis](#codebase-analysis)
3. [Architecture](#architecture)
4. [Data Models](#data-models)
5. [API / CLI Design](#api--cli-design)
6. [Configuration Parameters](#configuration-parameters)
7. [New Dependencies](#new-dependencies)
8. [Implementation Details](#implementation-details)
9. [Observability](#observability)
10. [Scaling Considerations](#scaling-considerations)
11. [File Changes](#file-changes)
12. [Testing Strategy](#testing-strategy)
13. [Alternatives Considered](#alternatives-considered)
14. [Rollout Plan](#rollout-plan)

## Overview

### Problem Statement

The registry exposes six POST toggle endpoints. They authenticate with the same dependency family (`nginx_proxied_auth` / `enhanced_auth`), but their CSRF protection is inconsistent: three routes carry `verify_csrf_token_flexible`, two carry nothing, and one (internal) correctly relies on a non-web credential. Where the CSRF dependency IS applied it is unsatisfiable for bearer-token M2M clients, because it requires a signed CSRF token bound to the `mcp_gateway_session` cookie - and a bearer client has no session cookie. Since agents and skills are registered disabled by default, every programmatic registration pipeline dies at the final enable step with `403 CSRF validation failed: no token provided`.

Simultaneously, `/api/servers/toggle` and `/api/virtual-servers/{path}/toggle` have NO CSRF dependency, so a cookie-bearing browser can be CSRF'd into toggling virtual servers and servers - the exact threat the dependency exists to stop.

### Goals

- One shared CSRF dependency, applied to all five user-facing toggle endpoints, with uniform semantics.
- Cookie-authenticated (browser/SPA) requests: full CSRF enforcement on every toggle endpoint - token required, validated against the session cookie. No weakening of the existing browser threat model.
- Bearer-token M2M requests (no session cookie): no CSRF requirement. The request is authenticated by a bearer credential validated by the auth server via nginx; bearer credentials are not ambient, so the classic CSRF forgery vector does not apply to them.
- The SPA keeps working with zero frontend changes (its axios interceptor already sends `X-CSRF-Token` on all mutating calls).
- Fix must be small, reviewable, and look native to this codebase.

### Non-Goals

- Changing CSRF token format/signing/expiry (`registry/auth/csrf.py` stays as-is).
- Extending CSRF to non-toggle mutating endpoints (register/edit/delete/rate/ANS link) - deferred as a follow-up hardening issue.
- Changes to nginx config, auth-server `/validate`, or cookie attributes.
- Deleting or restructuring `/api/toggle/{path}` vs `/api/servers/toggle` (two overlapping legacy surfaces remain; consolidating them is a separate refactor).

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/auth/csrf.py` | Token generation + `verify_csrf_token` (form-only) and `verify_csrf_token_flexible` (header or form) dependencies | The flexible variant is what toggle routes use today; it hard-requires a session cookie (`registry/auth/csrf.py:142-148`) and is the structural blocker for bearer clients |
| `registry/auth/dependencies.py` | `nginx_proxied_auth` (nginx X-User headers, falls back to session cookie via `enhanced_auth`), `enhanced_auth` (cookie-only) | The auth dependency on all five user-facing toggle routes; defines what "cookie-authenticated" vs "bearer-authenticated" looks like at the app layer |
| `registry/api/server_routes.py` | `POST /toggle/{service_path}` (:543, `enhanced_auth` + CSRF), `POST /servers/toggle` (:3005, `nginx_proxied_auth`, no CSRF), `POST /internal/toggle` (:1328, `validate_internal_auth`) | Three of the six toggles live here |
| `registry/api/agent_routes.py` | `POST /agents/{path}/toggle` (:981, `nginx_proxied_auth` + CSRF) | The endpoint M2M pipelines hit after agent registration |
| `registry/api/skill_routes.py` | `POST /skills/{path}/toggle` (:829, `nginx_proxied_auth` + CSRF) | The endpoint M2M pipelines hit after skill registration |
| `registry/api/virtual_server_routes.py` | `POST /virtual-servers/{path}/toggle` (:454, `nginx_proxied_auth`, no CSRF) | Missing CSRF for cookie sessions |
| `auth_server/server.py` | `/validate` endpoint consumed by nginx `auth_request`; validates session cookie FIRST, falls back to JWT bearer; returns `X-Auth-Method: session_cookie` vs provider name / `network-trusted` / `federation-static` | Proves browser requests arrive at FastAPI with `X-Auth-Method: session_cookie` and their cookie intact; bearer requests arrive with a provider method and no cookie |
| `docker/nginx_rev_proxy_http_and_https.conf` | `location {{ROOT_PATH}}/api/` runs `auth_request /validate`, forwards `X-User/X-Username/X-Scopes/X-Auth-Method` and passes through all request headers (`proxy_pass_request_headers on`), incl. cookies and `X-CSRF-Token` | Confirms the app receives both the cookie and the auth-method header on every API call |
| `frontend/src/contexts/AuthContext.tsx` | Axios interceptor attaches `X-CSRF-Token` to every post/put/delete/patch after fetching `/api/auth/csrf-token` | Browser path needs no frontend change |
| `frontend/src/pages/Dashboard.tsx`, `frontend/src/hooks/useVirtualServers.ts` | SPA toggle calls: `/api/toggle{path}` (FormData), `/api/agents/{path}/toggle?enabled=`, `/api/skills/{path}/toggle` (JSON), `/api/virtual-servers/{path}/toggle` (JSON) | All go through the interceptor; all already send the header |
| `registry/auth/routes.py` | `GET /api/auth/csrf-token` returns a token bound to the current session | How the SPA obtains its token; unchanged |
| `tests/unit/api/test_agent_routes.py`, `tests/unit/api/test_server_routes.py` | Existing unit-test conventions: build `FastAPI()` app or use `registry.main.app`, `dependency_overrides` for auth and CSRF | New tests must follow these patterns; important: they override `verify_csrf_token_flexible`, so renaming that function outright would break many tests |
| `tests/integration/test_skill_api.py`, `tests/integration/test_virtual_server_api.py` | Patch `nginx_proxied_auth` where used | Establishes mocking style for integration-level route tests |
| `docs/api-reference.md` | Documented toggle endpoints (:492 UI toggle, :908 servers/toggle) | Needs a short authentication/CSRF note per affected endpoint |
| `scripts/test-peer-federation*.sh` | Call `/api/servers/toggle` with bearer/X-User headers or session cookies | Confirms both credential styles are used against `/api/servers/toggle` in the wild |

### Existing Patterns Identified

1. **Dependency-injected auth via `Annotated[dict, Depends(nginx_proxied_auth)]`.**
   - Files: `registry/api/agent_routes.py:985`, `registry/api/skill_routes.py:833`, `registry/api/virtual_server_routes.py:461`, `registry/api/server_routes.py:3009`.
   - Follow: keep exactly this; the new CSRF dependency slots in alongside it.
2. **CSRF dependency as an ignored parameter**: `_csrf: Annotated[None, Depends(verify_csrf_token_flexible)] = None`.
   - Files: `agent_routes.py:987`, `skill_routes.py:835`, `server_routes.py:549,1542`.
   - Follow: same parameter shape with the new dependency to keep diffs minimal and tests' `dependency_overrides` meaningful.
3. **Header-or-form token extraction** already exists in `verify_csrf_token_flexible` (`X-CSRF-Token` first, then `csrf_token` form field).
   - Follow: reuse the same extraction order in the new shared dependency.
4. **Single settings object** `registry.core.config.settings` (e.g. `settings.session_cookie_name`).
   - Follow: read the cookie name from settings, never hardcode.
5. **Tests neutralize CSRF with `app.dependency_overrides[verify_csrf_token_flexible] = lambda: None`.**
   - Files: `tests/unit/api/test_agent_routes.py:59`, `tests/unit/api/test_server_routes.py:269`.
   - Follow: keep the legacy function name as a thin wrapper so existing tests keep passing; write new behavioral tests that exercise the real dependency (no override).

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `registry.auth.csrf` module | Extends | `verify_csrf_token_flexible` revised in place to be cookie-conditional (see Implementation Details); its use extended to the unprotected toggle routes |
| Five toggle route handlers | Uses | The three routes that already carry the `_csrf` parameter keep it with the corrected semantics; the two previously unprotected routes gain the parameter |
| `nginx_proxied_auth` / `enhanced_auth` | Depends on (indirectly) | The CSRF dependency inspects the same cookie + `X-Auth-Method` header those dependencies consume; it must run AFTER auth in the handler signature order so 401 wins over 403 for unauthenticated calls (FastAPI resolves dependencies in parameter order) |
| `GET /api/auth/csrf-token` | Unchanged | Browser clients keep obtaining tokens the same way |
| Audit middleware | Unaffected | Toggle handlers already call `set_audit_action`; CSRF rejection happens before handler body, so no audit rows are written for rejected forgeries (same as today) |

### Constraints and Limitations Discovered

- **Header spoofing must be assumed.** `X-Auth-Method` is set by nginx from the `/validate` response, but nothing in-process cryptographically binds it to the cookie. The design therefore uses the *cookie's presence* (not the header's value) as the trigger for CSRF enforcement, and treats the header only as a documentation/observability aid. An attacker who can inject `X-User` headers directly at the app is already past the trust boundary (out of scope; nginx strips/overwrites these headers on the public path).
- **`nginx_proxied_auth` falls back to session-cookie auth** (`registry/auth/dependencies.py:664-694`). A browser request may thus authenticate via cookie *without* any `X-Auth-Method` header (direct access to port 7860 in dev). The cookie-presence trigger handles this case correctly; an `X-Auth-Method: session_cookie` heuristic alone would have missed it. This is why the review's cookie-first rule was chosen over a header-switch rule.
- **Many existing tests override `verify_csrf_token_flexible` by name.** Renaming/removing it would break `tests/unit/api/test_agent_routes.py` and `tests/unit/api/test_server_routes.py` fixtures. Keep it (still used by `registry/auth/routes.py:301` logout), and have the new dependency live beside it.
- **`/api/toggle/{path}` uses `enhanced_auth`** (cookie-only) while the other four use `nginx_proxied_auth`. For that route the session cookie is always the credential, so the new dependency always enforces there - which matches today's behavior (it already has strict CSRF).
- **Form parsing caveat:** `verify_csrf_token_flexible` reads the form via `await request.form()`; Starlette caches the parsed form so the later `Form()` parameters in handlers are unaffected. Keep that mechanism.

## Architecture

### System Context Diagram

```
                    browser / SPA                         M2M client (CI, SDK)
                          |                                       |
                 cookie: mcp_gateway_session              Authorization: Bearer <jwt>
                 header: X-CSRF-Token: <signed>           (no cookie, no CSRF token)
                          |                                       |
                          v                                       v
                +---------------------------------------------------------+
                | nginx  location /api/  ->  auth_request /validate       |
                |   validates cookie (X-Auth-Method: session_cookie)      |
                |   OR bearer JWT (X-Auth-Method: keycloak/entra/...)     |
                |   forwards X-User/X-Scopes/X-Auth-Method + all headers  |
                +---------------------------------------------------------+
                          |                                       |
                          v                                       v
                +---------------------------------------------------------+
                | FastAPI registry API                                    |
                |   nginx_proxied_auth -> user_context                    |
                |   verify_csrf_token_flexible (cookie-conditional):      |
                |     cookie present? -> token MUST validate vs cookie    |
                |     cookie absent?  -> skip (bearer path)               |
                +---------------------------------------------------------+
```

### Sequence Diagram

Bearer M2M enable-after-register (today: 403; after fix: 200):

```
CI pipeline                nginx/auth-server            FastAPI
    | POST /api/agents/x/toggle?enabled=true      |                |
    | Authorization: Bearer <jwt> (no cookie)     |                |
    |-------------------------------------------->|                |
    |                        /validate: JWT valid |                |
    |                        X-Auth-Method: keycloak               |
    |-------------------------------------------->|                |
    |                                             | nginx_proxied_auth -> user_context (200 OK)
    |                                             | verify_csrf_token_flexible (cookie-conditional):
    |                                             |   no mcp_gateway_session cookie -> allow
    |                                             | toggle_agent(enabled=true)      |
    |<--------------------------------------------| 200 {"is_enabled": true}        |
```

Browser CSRF attempt (rejected on every toggle endpoint):

```
Malicious page -> browser                       nginx                FastAPI
    | POST /api/virtual-servers/v/x/toggle      |                |
    | Cookie: mcp_gateway_session=... (ambient) |                |
    | (attacker CANNOT set X-CSRF-Token: CORS)  |                |
    |------------------------------------------->|                |
    |                        /validate: cookie  |                |
    |                        X-Auth-Method: session_cookie        |
    |------------------------------------------->|                |
    |                                            | verify_csrf_token_flexible (cookie-conditional):
    |                                            |   cookie present, no X-CSRF-Token -> 403
    |<-------------------------------------------| 403 CSRF validation failed: no token provided
```

### Component Diagram

```
registry/auth/csrf.py
+-----------------------------------------------+
| generate_csrf_token(session_id)  (unchanged)  |
| validate_csrf_token(tok, sid)    (unchanged)  |
| verify_csrf_token                (unchanged)  |
| verify_csrf_token_flexible      (kept, legacy)|
| verify_csrf_token_flexible     (cookie-conditional) |
+-----------------------------------------------+
        | applied by
        v
server_routes.toggle_service_route        (cookie-only auth -> always enforced)
server_routes.toggle_service_api          (cookie -> enforced / bearer -> skipped)
server_routes.internal_toggle_service     (unchanged, validate_internal_auth)
agent_routes.toggle_agent                 (cookie -> enforced / bearer -> skipped)
skill_routes.toggle_skill                 (cookie -> enforced / bearer -> skipped)
virtual_server_routes.toggle_virtual_server (cookie -> enforced / bearer -> skipped)
```

## Data Models

No new Pydantic models and no model changes. Request/response shapes of all six endpoints are unchanged:

- `POST /api/agents/{path}/toggle?enabled=bool` - unchanged.
- `POST /api/skills/{path}/toggle` body `{"enabled": bool}` (`ToggleStateRequest`) - unchanged.
- `POST /api/virtual-servers/{path}/toggle` body `{"enabled": bool}` (`ToggleVirtualServerRequest`) - unchanged.
- `POST /api/servers/toggle` form fields `path`, `new_state` - unchanged.
- `POST /api/toggle/{path}` form field `enabled` - unchanged.

The only new wire-visible behavior is that `X-CSRF-Token` (or `csrf_token` form field) becomes *required* on cookie-bearing requests to `/api/servers/toggle` and `/api/virtual-servers/{path}/toggle`, where previously it was ignored.

## API / CLI Design

No new endpoints. The change is behavioral, on five existing endpoints.

**Cookie-bearing request without CSRF token (any of the five toggles):**

```
HTTP/1.1 403 Forbidden
{"detail": "CSRF validation failed: no token provided"}
```

**Bearer-token request without cookie (agent/skill/server-API/virtual-server toggles):**

```
HTTP/1.1 200 OK
{"message": "...", "is_enabled": true}   (per-endpoint shape as today)
```

**Error Cases:**
- 401: no valid credential at all (auth dependency, unchanged).
- 403 `CSRF validation failed: no session`: token presented but no session cookie to validate against (structurally the bearer case when a client mistakenly sends a token; unchanged message from today's dependency).
- 403 `CSRF validation failed: invalid token`: token present but signature/session mismatch/expiry.
- 403 `CSRF validation failed: no token provided`: cookie present, token absent.

## Configuration Parameters

No new environment variables. The dependency reuses `settings.session_cookie_name` and `settings.session_max_age_seconds` via the existing `validate_csrf_token`.

### Deployment Surface Checklist

- [ ] No `.env.example` change needed (no new vars).
- [ ] No docker-compose / Terraform / Helm change needed (no new vars).
- [ ] `docs/api-reference.md`: note the bearer-vs-cookie CSRF rule on the two toggle sections (UI toggle, servers/toggle) and a one-line note in the agent/skill/virtual-server API docs.

## New Dependencies

This change uses only existing dependencies (`itsdangerous`, FastAPI, Starlette). No new packages.

## Implementation Details

### Design Decision: cookie-presence double-submit, applied uniformly

**Implementation refinement (Step 8.5):** rather than adding a NEW dependency function, `verify_csrf_token_flexible` itself is revised in place to be cookie-conditional and its use is extended to the two unprotected toggle routes. Rationale: the function already sits on exactly the routes needing the new semantics (its other call sites - logout, edit form - are always cookie-borne and behave identically under both semantics), existing tests neutralize CSRF via `app.dependency_overrides[verify_csrf_token_flexible]` and keep working, and the codebase keeps ONE canonical CSRF dependency instead of gaining a second competing one. The code below is therefore the revised body of `verify_csrf_token_flexible` (name unchanged); the invariants section above is unchanged.

Three candidate designs were weighed (full comparison in Alternatives):

1. **(Chosen) Cookie-presence-conditional CSRF.** One dependency: if the `mcp_gateway_session` cookie is present on the request, require a valid CSRF token bound to it; if absent, the request is necessarily bearer-authenticated (that is the only remaining credential that passes auth), and CSRF is inapplicable. Bearer credentials are not ambient - the browser never attaches them automatically - so a cross-site page cannot forge a bearer-authenticated state change. This preserves the browser threat model 1:1 and unblocks M2M.
2. Sync-token required unconditionally on all toggles, with a new M2M token endpoint - rejected: adds an endpoint and a workflow; still unsatisfiable for cookie-less clients.
3. Drop CSRF on toggles entirely - rejected: weakens the browser threat model on `/api/servers/toggle` and virtual-server toggle (cross-site form posts with `text/plain` can carry JSON-shaped bodies; cookies are ambient).

### Invariants (must hold in the implementation)

1. **Cookie presence is the sole CSRF trigger.** The dependency checks `request.cookies.get(settings.session_cookie_name)` and nothing else. The nginx-injected `X-Auth-Method` header (e.g. `session_cookie` vs `keycloak`) is advisory/observational only: requests that authenticate via cookie always carry the cookie (including direct-to-app access that bypasses nginx, where the header is absent), and a header-based switch would open a bypass on those paths. A future maintainer must not "optimize" this into a header check.
2. **The `_csrf` parameter is declared AFTER the `user_context` parameter** in every handler signature. FastAPI resolves dependencies in parameter order, so an unauthenticated request receives the 401 from the auth dependency rather than a misleading 403 from CSRF.
3. **Canonical dependency rule:** `verify_csrf_token_flexible` (in its cookie-conditional form) is THE CSRF dependency for dual-credential (cookie-or-bearer) mutating endpoints going forward. Do not add a second competing CSRF dependency; do not reintroduce the unconditional-cookie requirement that locks out bearer clients.

### Step-by-Step Plan (for a future implementer)

#### Step 1: Make the shared dependency cookie-conditional
**File:** `registry/auth/csrf.py` - revise `verify_csrf_token_flexible` (body starting at :107) in place:

```python
async def verify_csrf_token_flexible(
    request: Request,
) -> None:
    """FastAPI dependency that validates CSRF token from multiple sources.

    Accepts CSRF token from:
    - Form data (for traditional HTML forms)
    - X-CSRF-Token header (for React/SPA applications)

    CSRF protects ambient credentials, and the session cookie is the only
    ambient credential here: a browser attaches it to cross-site requests
    automatically. Requests that carry the session cookie must therefore
    present a valid CSRF token bound to it. Requests without the session
    cookie are authenticated by a bearer credential that the auth server
    validates per request and that browsers never attach on their own, so
    there is nothing to forge and the check is skipped. This keeps CSRF
    enforcement uniform across endpoints that accept both credential styles
    without locking bearer-token M2M clients out of them (issue #891).
    """
    session_id = request.cookies.get(settings.session_cookie_name)

    if not session_id:
        logger.debug("CSRF check skipped: no session cookie (bearer or internal client)")
        return

    # Try to get token from header first (for JSON requests)
    csrf_token = request.headers.get("X-CSRF-Token")

    # If not in header, try form data (for HTML form requests)
    if not csrf_token:
        try:
            form_data = await request.form()
            csrf_token = form_data.get("csrf_token")
        except Exception:
            csrf_token = None

    if not csrf_token:
        logger.warning("CSRF validation failed: no token provided")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF validation failed: no token provided",
        )

    if not validate_csrf_token(csrf_token, session_id):
        logger.warning("CSRF validation failed: invalid token")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="CSRF validation failed: invalid token",
        )

    logger.debug("CSRF token verified via flexible dependency")
```

The legacy `no session` 403 branch is removed: a cookie-less request is the bearer/internal path, not a CSRF failure. Logout (`registry/auth/routes.py:301`) and the edit-server form (`server_routes.py:1542`) keep this dependency and behave identically (they are always cookie-borne).

#### Step 2: Extend the dependency to the two unprotected toggle routes
- `registry/api/server_routes.py:3005` `toggle_service_api`: add `_csrf: Annotated[None, Depends(verify_csrf_token_flexible)] = None` AFTER the `user_context` parameter (invariant 2).
- `registry/api/virtual_server_routes.py:458` `toggle_virtual_server`: add the same parameter after `user_context`, plus the import (`from ..auth.csrf import verify_csrf_token_flexible`).

(No edit is needed on the three routes that already carry the dependency - agent, skill, and the UI `/api/toggle/{path}` - they inherit the corrected conditional semantics automatically.)

#### Step 3: Leave the internal endpoint alone
`registry/api/server_routes.py:1328` `/internal/toggle` keeps `validate_internal_auth` only. Its caller (`mcpgw-server`) authenticates with a shared-secret internal JWT; adding CSRF there would break it with zero security gain. This exception is deliberate.

#### Step 4: Documentation
**File:** `docs/api-reference.md` - in the "Toggle Service" (UI) section (~:492) and "Toggle Server" section (~:908), add a short **CSRF** paragraph: requests presenting the `mcp_gateway_session` cookie must include a valid `X-CSRF-Token` (or `csrf_token` form field) from `GET /api/auth/csrf-token`; requests authenticated solely by bearer token are not CSRF-checked.

#### Step 5: Keep the repo's own automation self-consistent (review finding, Circuit)
**File:** `scripts/test-peer-federation-docker.sh` (toggle calls at ~:208-211)

The script authenticates with a session cookie jar (`COOKIE_A`) and currently posts `/api/servers/toggle` with no CSRF token - after this change those calls would 403 and the federation e2e would fail. Update it to fetch a token with the same cookie jar and send it on both toggle calls:

```bash
CSRF_TOKEN=$(curl -s -b "$COOKIE_A" "$REGISTRY_A_URL/api/auth/csrf-token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf_token"])')

curl -s -b "$COOKIE_A" -X POST "$REGISTRY_A_URL/api/servers/toggle" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -F "path=/test-server-1" -F "new_state=true" > /dev/null
curl -s -b "$COOKIE_A" -X POST "$REGISTRY_A_URL/api/servers/toggle" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -F "path=/test-server-2" -F "new_state=true" > /dev/null
```

`scripts/test-peer-federation.sh` (header-based auth, no cookie) needs no change; the new dependency skips cookie-less requests.

### Error Handling
- All CSRF failures raise `HTTPException(403)` with the same `detail` strings the current dependency uses (`no token provided` / `invalid token`), so existing client error handling and log greps keep working. The legacy `no session` detail is gone with the removed branch.
- Malformed multipart bodies during token extraction are swallowed exactly as in `verify_csrf_token_flexible` (token simply absent -> `no token provided`).

### Logging
- `logger.debug` when the check is skipped (no cookie) - gives operators a grep-friendly signal that a request took the bearer path.
- `logger.warning` on both failure modes - identical to today's messages.
- `logger.debug` on success - mirrors `verify_csrf_token_flexible`.

## Observability

- Log events (module `registry.auth.csrf`): "CSRF validation failed: no token provided" / "invalid token" (warning), "CSRF check skipped: no session cookie" (debug), success (debug).
- No metrics/tracing changes: rejected requests never reach the handler, matching current behavior for the three already-protected toggles; the audit middleware records no action for them today either.

## Scaling Considerations

- The dependency adds at most one cookie lookup and one itsdangerous signature verification per cookie-bearing request - the same cost as the current per-route check on three of the five routes; no additional storage, no locks.
- Bearer requests get a debug log and return early: marginally cheaper than today's agent/skill path (no form parse attempt).
- The form parse happens only when the header is absent on cookie-bearing requests; Starlette caches the parsed form, so handler `Form()` params are unaffected.

## File Changes

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/auth/csrf.py` | :107-165 (verify_csrf_token_flexible) | Revise the shared dependency in place to be cookie-conditional (~+18/-10) |
| `registry/api/server_routes.py` | :3005-3011 | Add CSRF dep to `toggle_service_api` (after `user_context`) |
| `registry/api/agent_routes.py` | :981-987 | No edit: `toggle_agent` already carries the dependency and inherits the corrected conditional semantics |
| `registry/api/skill_routes.py` | :829-835 | No edit: `toggle_skill` already carries the dependency and inherits the corrected conditional semantics |
| `registry/api/virtual_server_routes.py` | imports (~:16), :458-462 | Import dep; add CSRF dep to `toggle_virtual_server` |
| `scripts/test-peer-federation-docker.sh` | ~:205-211 | Fetch CSRF token with the session cookie jar; send `X-CSRF-Token` on both `/api/servers/toggle` calls |
| `docs/api-reference.md` | ~:492, ~:908 | Document the cookie-vs-bearer CSRF rule |
| `tests/unit/auth/test_csrf_dependency.py` | new file | Behavioral tests for the dependency (see Testing Strategy) |
| `tests/unit/api/test_toggle_csrf_consistency.py` | new file | Per-endpoint browser/bearer/negative tests via the real dependency |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| Modified code (dependency + route params + docs + script) | ~40 |
| New tests | ~340 |
| **Total** | **~380** |

## Testing Strategy

See `./testing.md` for the full executable plan. Summary:

- **Unit (dependency-level), `tests/unit/auth/test_csrf_dependency.py`:** cookie+valid token passes; cookie without token -> 403; cookie with wrong token -> 403; no cookie with token -> skipped (None); no cookie no token -> skipped; form-field token accepted; header token preferred.
- **Unit (route-level), `tests/unit/api/test_toggle_csrf_consistency.py`:** for each of the four `nginx_proxied_auth` toggles (agent, skill, server-API, virtual-server): bearer-style (no cookie) succeeds with only auth overridden; browser-style (cookie, no token) -> 403; browser-style (cookie + valid token signed for that cookie) -> 200. Plus the UI `/api/toggle/{path}` cookie-only route enforcing the token.
- **Regression:** existing suites that override `verify_csrf_token_flexible` keep passing (function retained); `/internal/toggle` tests untouched.

## Alternatives Considered

### Alternative 1: Unconditional sync-token CSRF on all toggles + M2M token issuance
**Description:** Keep strict CSRF everywhere; give M2M clients a CSRF-equivalent token via a new endpoint.
**Pros / Cons:** Uniform, but the token would have nothing to bind to (no cookie) - it degenerates into a static capability header; adds an endpoint, client changes, and key management.
**Why Rejected:** Does not solve the structural problem; strictly more machinery for the same outcome as the chosen design.

### Alternative 2: Drop CSRF on toggle endpoints; rely on SameSite cookies
**Description:** Remove CSRF dependencies; depend on cookie `SameSite` attributes.
**Pros / Cons:** Simplest; but `SameSite` is set nowhere in the repo for `mcp_gateway_session` (no `set_cookie` call found in `registry/`), older browsers fall back to `Lax`-only behavior, and `Lax` still allows top-level navigations that can fire GETs; cross-site POSTs via forms are the core risk and would become unprotected on ALL toggle endpoints.
**Why Rejected:** Weakens the browser threat model; explicitly prohibited by the task constraints. (Hardening `SameSite` is worth doing, noted in Open Questions, but as defense-in-depth, not as the primary control.)

### Alternative 3: Branch on `X-Auth-Method == "session_cookie"` header
**Description:** Enforce CSRF only when nginx's `X-Auth-Method` header says `session_cookie`.
**Pros / Cons:** Precise on the nginx-proxied path; but requests that reach the app directly (dev, port 7860, or misconfigured proxy) authenticate via cookie with NO `X-Auth-Method` header at all (`nginx_proxied_auth` falls back to `enhanced_auth`), and header spoofing is a live risk on any path that bypasses nginx.
**Why Rejected:** The cookie-presence trigger is strictly safer: every cookie-authenticated request has the cookie by definition, with or without the header.

### Comparison Matrix

| Criteria | Chosen (cookie-conditional) | Alt 1 (M2M token) | Alt 2 (drop CSRF) | Alt 3 (header switch) |
|----------|--------|--------|--------|--------|
| Browser protection preserved | Yes | Yes | **No** | Mostly |
| Unblocks bearer M2M | Yes | Partial | Yes | Yes |
| New endpoints/client changes | None | Many | None | None |
| Direct-access (no nginx) safety | Yes | Yes | No | **No** |
| Diff size | Small | Large | Tiny | Small |

## Rollout Plan

- Phase 1: Implementation (this patch).
- Phase 2: Testing (per `testing.md`; not executed by this benchmark run).
- Phase 3: Deployment - no config or migration steps; deploy registry as usual. SPA needs no release (already sends the header). Communication to API consumers (review findings, Circuit and Pixel):
  - Bearer-token automation: no change; agent/skill toggles now succeed without a CSRF token.
  - Cookie-authenticated automation: must now send `X-CSRF-Token` on `/api/servers/toggle` and `/api/virtual-servers/*/toggle` (previously optional because unenforced).
  - SPA edge case: if the initial `/api/auth/csrf-token` fetch fails, previously-working server/virtual-server toggles now 403 (correct fail-closed, matches agent/skill behavior today); refreshing re-fetches the token.
  - Canary signal post-deploy: watch the rate of `CSRF validation failed: no token provided` warnings for broken cookie clients.
- Rollback = revert the patch; behavior returns to the pre-change inconsistency.

## Open Questions

- Should `SameSite=Lax` (or `Strict`) and `Secure` attributes be added wherever `mcp_gateway_session` is issued (auth server)? Defense-in-depth follow-up; not required for this fix.
- Should the same cookie-conditional dependency replace `verify_csrf_token_flexible` on the other mutating endpoints (register/edit/delete/rating/ANS link) and on logout? Likely yes as a follow-up hardening pass; intentionally out of scope here.

## References

- Upstream issue: https://github.com/agentic-community/mcp-gateway-registry/issues/891
- `registry/auth/csrf.py` - existing token machinery
- `registry/auth/dependencies.py:538` - `nginx_proxied_auth` dual-credential flow
- `auth_server/server.py:1560-1800` - `/validate` credential precedence (cookie first, then JWT)
- OWASP CSRF Prevention Cheat Sheet (double-submit cookie / synchronizer token patterns)
