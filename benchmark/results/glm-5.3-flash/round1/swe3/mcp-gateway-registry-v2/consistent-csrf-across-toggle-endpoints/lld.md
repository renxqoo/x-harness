# Low-Level Design: Consistent CSRF Across Toggle Endpoints

*Created: 2026-09-30*
*Author: glm-5.3-flash*
*Status: Draft (revised after expert review)*

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
The registry exposes six POST "toggle" endpoints that flip the enabled state of registered assets (servers, agents, skills, virtual servers). Their CSRF treatment is inconsistent:

- `POST /api/toggle/{service_path}` and the edit-form route enforce `verify_csrf_token_flexible`, which requires BOTH a CSRF token AND a session cookie to validate it against.
- `POST /api/agents/{path}/toggle` and `POST /api/skills/{path}/toggle` enforce the same strict dependency even though they authenticate via `nginx_proxied_auth`, which is designed to accept OAuth M2M bearer tokens forwarded by nginx. A bearer client has no session cookie, so the check is structurally unsatisfiable: it can never send a token that validates. Because agents and skills are registered disabled by default, every programmatic registration pipeline breaks at the enable step with `403 CSRF validation failed: no token provided`.
- `POST /api/servers/toggle` and `POST /api/virtual-servers/{vs_path}/toggle` enforce NO CSRF check at all, so a cookie-authenticated SPA user is exposed to cross-site toggling there.
- `POST /api/internal/toggle` authenticates via a shared-secret internal JWT (`validate_internal_auth`); it is not reachable by browsers and needs no CSRF.

### Goals
- Make CSRF coverage consistent: every browser-reachable toggle endpoint applies the same CSRF policy.
- Keep the browser threat model intact: any request that arrives with a session cookie (ambient credential) must present a valid session-bound CSRF token.
- Unblock bearer-token M2M clients: no toggle endpoint may reject a request purely for lacking a session cookie.
- Use ONE shared dependency so future toggle-style endpoints cannot reintroduce the inconsistency.

### Non-Goals
- Changing `nginx_proxied_auth`, `enhanced_auth`, or the nginx auth_request wiring.
- Adding CSRF protection to non-toggle endpoints (logout, edit form, ANS admin, federation) beyond what exists today.
- Origin/Referer-based CSRF defenses, `Sec-Fetch-Site` checks, or CORS changes.
- Changing session cookie name, signer salt, secret key handling, or token TTL.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/auth/csrf.py` | CSRF token generation and validation (`generate_csrf_token`, `validate_csrf_token`, `verify_csrf_token`, `verify_csrf_token_flexible`) | Home of the new shared dependency; existing helpers are reused, not modified |
| `registry/api/server_routes.py` | Server routes incl. `POST /toggle/{path}` (line ~543), `POST /servers/toggle` (line ~3005), `POST /internal/toggle` (line ~1328), edit form (~1542) | Two toggle routes gain CSRF; strict dependency retained on edit form |
| `registry/api/agent_routes.py` | `POST /agents/{path}/toggle` (line ~981) | Swap strict dependency for the session-conditional one |
| `registry/api/skill_routes.py` | `POST /skills/{path}/toggle` (line ~829) | Same swap |
| `registry/api/virtual_server_routes.py` | `POST /virtual-servers/{vs_path}/toggle` (line ~454) | Gains CSRF dependency (currently none) |
| `registry/auth/dependencies.py` | `enhanced_auth` (session cookie only) and `nginx_proxied_auth` (nginx X-User headers first, session-cookie fallback via `enhanced_auth`) | Defines the two authentication paths the CSRF policy must distinguish |
| `registry/auth/routes.py` | `GET /csrf-token` mints a session-bound token; `POST /logout` uses strict `verify_csrf_token_flexible` | SPA obtains its token here; logout behavior must not change |
| `registry/auth/internal.py` | `validate_internal_auth` - internal JWT bearer for `/internal/*` routes | `/internal/toggle` is not browser-forgeable; explicitly out of CSRF scope |
| `docker/nginx_rev_proxy_http_and_https.conf` | nginx `auth_request` sets `X-User`, `X-Scopes`, etc. from the validated auth subrequest before proxying to FastAPI | Bearer requests reach the app with nginx-set identity headers and typically no session cookie |
| `frontend/src/contexts/AuthContext.tsx` | SPA axios interceptor: fetches `/api/auth/csrf-token` and attaches `X-CSRF-Token` on post/put/delete/patch | The browser path must keep working unchanged |
| `tests/unit/api/test_agent_routes.py` | Toggle tests override `verify_csrf_token_flexible` with `lambda: None` via `app.dependency_overrides` | Existing tests keep passing only if the new dependency is overridable the same way; new tests follow this pattern |

### Existing Patterns Identified
1. **CSRF as a FastAPI dependency** returning `None` and raising `HTTPException(403)`:
   - Files: `registry/auth/csrf.py`, used at `server_routes.py:549`, `agent_routes.py:987`, `skill_routes.py:835`, `auth/routes.py:301`
   - Follow it: the new dependency has the same shape and lives in the same module, so `app.dependency_overrides[...]` keeps working in every existing test fixture.
2. **Session-bound signed tokens** via `itsdangerous.URLSafeTimedSerializer` with `CSRF_SALT` and `settings.session_max_age_seconds` max age:
   - Files: `registry/auth/csrf.py` (`generate_csrf_token`, `validate_csrf_token`)
   - Follow it: reuse both helpers verbatim; do not invent a second token scheme.
3. **Token sources**: `X-CSRF-Token` header first, then `csrf_token` form field:
   - File: `verify_csrf_token_flexible`
   - Follow it: identical extraction order in the new dependency.
4. **Dual authentication on the same route** (`nginx_proxied_auth` = nginx-injected identity headers, else session-cookie fallback):
   - File: `registry/auth/dependencies.py:538`
   - Follow it: the CSRF policy keys off the presence of the session cookie (the ambient credential), not off which auth dependency ran.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `verify_csrf_token_flexible` | Reused | The new dependency delegates token extraction and validation to the same helpers |
| `GET /api/auth/csrf-token` | Uses | Unchanged; SPA token minting stays identical |
| All six toggle routes | Extended | Each gains/applies exactly one CSRF dependency: the new session-conditional one |
| Existing unit tests | Unaffected | They override the strict dependency by name; only routes that switch dependencies needed their overrides updated to the new symbol |

### Constraints and Limitations Discovered
- `validate_csrf_token` needs a session ID string; there is no token variant that binds to a bearer credential. Binding CSRF tokens to bearer tokens is unnecessary anyway: bearer headers are not ambient credentials, so those requests are not CSRF-forgeable.
- Policy summary for `csrf.py` readers: CSRF enforcement applies to cookie-authenticated (browser) requests; bearer-authenticated requests are exempt because they carry no forgeable ambient credential. The exemption is deliberate, not a missing check.
- nginx sets `X-User` only from the `auth_request` subrequest response; a browser request without a session cookie cannot authenticate at all, so "no cookie" reliably implies non-browser (bearer or internal JWT) auth on these routes.
- `POST /api/toggle/{service_path}` uses `enhanced_auth` (session-only). It is a browser-only route by construction; the session-conditional dependency is a no-op relaxation there (browser requests always carry the cookie and are still fully checked).
- FastAPI dependency overrides are keyed by function object; renaming the imported symbol in a route module requires updating the test fixtures that override it.

## Architecture

### System Context Diagram

```
                   +---------------------+
                   |   Browser / SPA     |
                   |  (session cookie +  |
                   |   X-CSRF-Token)     |
                   +----------+----------+
                              |
                              v
                   +---------------------+
                   |       nginx         |
                   |  auth_request ->    |
                   |  X-User/X-Scopes    |
                   +----------+----------+
                              |
        +---------------------+----------------------+
        |                     |                      |
        v                     v                      v
 +-------------+     +----------------+     +--------------+
 | Bearer M2M  |     |  Registry API  |     | Internal svc |
 | client      |---->|  (FastAPI)     |     | (internal    |
 | (no cookie) |     |  toggle routes |     |  JWT)        |
 +-------------+     +-------+--------+     +--------------+
                             |
                     verify_csrf_token_if_session_cookie
                     cookie present  -> token REQUIRED + validated
                     cookie absent   -> skip (not forgeable)
```

### Sequence Diagrams

Browser toggle (SPA, unchanged wire behavior):

```
SPA                     Registry                     nginx/auth
 |--- GET /api/auth/csrf-token ------------------------>|
 |<-- {csrf_token} (bound to session) ------------------|
 |--- POST /api/agents/foo/toggle?enabled=true -------->|
 |    Cookie: mcp_gateway_session=...                   |
 |    X-CSRF-Token: <token>                             |
 |                       |-- CSRF dep: cookie present ->|
 |                       |   validate(token, session)   |
 |                       |   OK -> route handler        |
 |<-- 200 {enabled: true} ------------------------------|
```

Bearer M2M toggle (previously broken for agents/skills, now allowed):

```
M2M client              Registry
 |--- POST /api/agents/foo/toggle?enabled=true ------->|
 |    Authorization: Bearer <oauth token>              |
 |    (no session cookie)                              |
 |                       |-- CSRF dep: no cookie ->    |
 |                       |   skip (not forgeable)      |
 |                       |-- nginx_proxied_auth:       |
 |                       |   X-User headers -> context |
 |<-- 200 {enabled: true} ------------------------------|
```

Cross-site forged browser toggle (blocked on every toggle route):

```
Evil page               Victim browser               Registry
 |--- forged POST (form/auto request) -->|             |
 |    Cookie: mcp_gateway_session=...    |             |
 |    (no valid X-CSRF-Token)            |             |
 |                                       |--- POST --->|
 |                                       |  CSRF dep:  |
 |                                       |  cookie +   |
 |                                       |  bad token  |
 |                                       |<-- 403 -----|
```

### Component Diagram

```
registry/auth/csrf.py
  generate_csrf_token(session_id)              (unchanged)
  validate_csrf_token(token, session_id)       (unchanged)
  verify_csrf_token(request, csrf_token=Form)  (unchanged, unused by toggles)
  verify_csrf_token_flexible(request)          (unchanged; edit form + logout)
  verify_csrf_token_if_session_cookie(request) (NEW; all six toggle routes)

Routes
  server_routes.toggle_service_route     --> NEW dep
  server_routes.toggle_service_api       --> NEW dep
  server_routes.internal_toggle_service  --> NEW dep (defense in depth)
  agent_routes.toggle_agent              --> NEW dep (replaces strict)
  skill_routes.toggle_skill              --> NEW dep (replaces strict)
  virtual_server_routes.toggle_virtual_server --> NEW dep (adds coverage)
```

## Data Models

No new or changed Pydantic models, schemas, or persisted data. Toggle request shapes are unchanged:

- `POST /api/toggle/{service_path}` - form field `enabled` (string, unchanged)
- `POST /api/servers/toggle` - form fields `path`, `new_state` (unchanged)
- `POST /api/agents/{path}/toggle` - query param `enabled` (unchanged)
- `POST /api/skills/{path}/toggle` - JSON body `ToggleStateRequest` (unchanged)
- `POST /api/virtual-servers/{vs_path}/toggle` - JSON body `ToggleVirtualServerRequest` (unchanged)
- `POST /api/internal/toggle` - form field `service_path` (unchanged)

## API / CLI Design

No new endpoints. The wire contract of every existing toggle endpoint is unchanged for both supported clients:

**Browser/SPA requests** must continue to send the session cookie and the CSRF token (header or form field), exactly as today. Missing/invalid token with a cookie present: `403 {"detail": "CSRF validation failed: ..."}` (same messages as `verify_csrf_token_flexible`).

**Bearer M2M requests** (no session cookie) now succeed on agent/skill toggles instead of receiving `403 CSRF validation failed: no token provided`. `POST /api/servers/toggle` and virtual-server toggle gain a CSRF requirement only when a session cookie is present; pure bearer calls are unaffected.

**Error Cases**
- 403 `CSRF validation failed: no token provided` - cookie present, no token found in header or form.
- 403 `CSRF validation failed: no session` - cookie present but empty/unreadable during validation.
- 403 `CSRF validation failed: invalid token` - token signature invalid, expired, or bound to a different session.
- 401/403 from the auth dependencies - unchanged, evaluated independently of CSRF.

## Configuration Parameters

None added. Reuses `settings.secret_key`, `settings.session_cookie_name` (`mcp_gateway_session`), and `settings.session_max_age_seconds`.

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| (none) | - | - | - | This change adds no configuration surface |

### Deployment Surface Checklist
- No `.env.example`, `docker-compose.yml`, Terraform, or Helm changes required.

## New Dependencies

This change uses only existing dependencies (`itsdangerous` via the existing signer, FastAPI).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Add the session-conditional CSRF dependency
**File:** `registry/auth/csrf.py`
**Lines:** appended after `verify_csrf_token_flexible` (end of module)

```python
async def verify_csrf_token_if_session_cookie(request: Request) -> None:
    """FastAPI dependency that enforces CSRF only for cookie-authenticated requests.

    Cross-site attackers cannot attach an Authorization header to a victim's
    request; they can only ride ambient credentials such as cookies. So:

    - No session cookie -> the request must have authenticated with an explicit
      credential (bearer token or internal JWT). CSRF validation is skipped.
    - Session cookie present -> the request may be a forged browser request.
      A valid session-bound CSRF token is REQUIRED, same rules as
      verify_csrf_token_flexible.
    """
    session_id = request.cookies.get(settings.session_cookie_name)
    if not session_id:
        logger.info(
            "CSRF check skipped: no session cookie (non-browser/bearer-authenticated request)"
        )
        return

    # Reuse the strict validator, but only after the cookie gate passed.
    # verify_csrf_token_flexible re-reads the cookie and raises 403 with the
    # established error messages if the token is missing or invalid.
    await verify_csrf_token_flexible(request)
```

Behavior notes (invariants an implementer MUST preserve):
- ORDERING: the cookie gate runs FIRST and returns before any token parsing or validation. The skip branch must never sit behind a 403-raising branch; if the steps were reordered, a tokenless bearer request would hit "no token provided" and re-break M2M.
- AUTHENTICATION IS NEVER SKIPPED: when no cookie is present the dependency returns immediately, and the route's auth dependency (`nginx_proxied_auth`, `enhanced_auth`, or `validate_internal_auth`) remains the sole authority for who the caller is. Skipping CSRF grants no identity; a future toggle route MUST still carry a real auth dependency.
- HYBRID REQUESTS: a request carrying BOTH a session cookie and an Authorization header is treated as a browser request (cookie wins) and MUST present a valid CSRF token. Always take the stricter branch.
- When a cookie is present, all strict rules apply (token from `X-CSRF-Token` or `csrf_token` form field, signed, unexpired, bound to the session ID).
- The dependency is async, takes only `request`, returns `None`, and raises `HTTPException` - exactly like the existing ones - so `app.dependency_overrides` works identically in tests.

#### Step 2: Apply it to the server toggle routes
**File:** `registry/api/server_routes.py`

- `toggle_service_route` (`POST /toggle/{service_path}`, line ~543): replace
  `_csrf: Annotated[None, Depends(verify_csrf_token_flexible)] = None` with
  `_csrf: Annotated[None, Depends(verify_csrf_token_if_session_cookie)] = None`.
- `toggle_service_api` (`POST /servers/toggle`, line ~3005): add the same parameter
  (this route currently has NO CSRF check; browser sessions become protected here).
- `internal_toggle_service` (`POST /internal/toggle`, line ~1328): add the same
  parameter as defense in depth. Internal JWT callers send no session cookie, so
  behavior is unchanged; a request that arrives with BOTH an internal JWT and a
  session cookie must also present a valid CSRF token.
- Keep `verify_csrf_token_flexible` on the edit form route (~line 1542): that route
  is a session-cookie-only HTML form where the strict check is always satisfiable.
- Update the import line to include the new symbol.

#### Step 3: Apply it to the agent toggle route
**File:** `registry/api/agent_routes.py` (line ~981)

- In `toggle_agent`, replace
  `_csrf: Annotated[None, Depends(verify_csrf_token_flexible)] = None` with
  `_csrf: Annotated[None, Depends(verify_csrf_token_if_session_cookie)] = None`.
- Update the import.

#### Step 4: Apply it to the skill toggle route
**File:** `registry/api/skill_routes.py` (line ~829)

- In `toggle_skill`, make the same replacement and update the import.

#### Step 5: Apply it to the virtual server toggle route
**File:** `registry/api/virtual_server_routes.py` (line ~454)

- In `toggle_virtual_server`, add
  `_csrf: Annotated[None, Depends(verify_csrf_token_if_session_cookie)] = None`
  (this route currently has NO CSRF check) and add the import.

#### Step 6: Tests
**Files:** `tests/unit/auth/test_csrf.py` (new), plus small additions to
`tests/unit/api/test_agent_routes.py` and `tests/unit/api/test_skill_routes.py`
(new file, following the agent test conventions).

- Unit tests for the dependency itself (cookie absent -> pass; cookie present without
  token -> 403; invalid/garbage token -> 403; valid session-bound token -> pass),
  driving a tiny throwaway FastAPI app so the tests do not depend on route internals.
- API-level tests proving the bearer path through the real route signatures:
  `POST /agents/{path}/toggle` and `POST /skills/{path}/toggle` with
  `nginx_proxied_auth` overridden and NO cookie -> 200 (not 403).
- API-level tests proving the browser path: with a `mcp_gateway_session` cookie but
  no/invalid token -> 403; with a valid token generated by `generate_csrf_token(session_value)`
  -> 200. Token validation is exercised for real (the dependency is NOT overridden
  in these tests), while the auth dependency is overridden as in existing fixtures.
- Existing fixtures that override `verify_csrf_token_flexible` by name keep working
  for the routes that still use it; fixtures for routes that switched symbols are
  updated to override `verify_csrf_token_if_session_cookie` instead.

### Error Handling
- The new dependency raises the same `HTTPException(403)` values as `verify_csrf_token_flexible`; no new error codes or messages are introduced.
- No new exception paths in route handlers; toggles behave identically once CSRF passes.

### Logging
- One `logger.info` line when the check is skipped due to no cookie (makes bearer traffic auditable without debug logging).
- All existing warnings from `validate_csrf_token` / `verify_csrf_token_flexible` (missing token, missing session, invalid token) apply unchanged on the cookie path.

## Observability
### Tracing / Metrics / Logging Points
- `CSRF check skipped: no session cookie...` (INFO) - one per bearer toggle call; a spike with no cookies on browser-only routes would be worth alerting on later, out of scope here.
- Existing WARNING lines for missing/invalid tokens remain the browser-attack signal.

## Scaling Considerations
- No additional network calls, DB reads, or crypto work beyond today: the skip path is a dict lookup; the cookie path is the same itsdangerous validation as before.
- No per-route state; the dependency is stateless and scales horizontally like the rest of the app.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `tests/unit/auth/test_csrf.py` | Unit tests for `verify_csrf_token_if_session_cookie` (skip path, enforce path, token validation) |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/auth/csrf.py` | ~end of file | Add `verify_csrf_token_if_session_cookie` (~15 lines) |
| `registry/api/server_routes.py` | ~14, 549, 1331, 3005+ | Import new symbol; apply dependency to `/toggle/{path}` and `/servers/toggle` and `/internal/toggle` |
| `registry/api/agent_routes.py` | ~28, 987 | Import + swap dependency on `/agents/{path}/toggle` |
| `registry/api/skill_routes.py` | ~32, 835 | Import + swap dependency on `/skills/{path}/toggle` |
| `registry/api/virtual_server_routes.py` | ~24, 454 | Import + add dependency on `/virtual-servers/{path}/toggle` |
| `tests/unit/api/test_agent_routes.py` | toggle test class | Update CSRF override symbol; add bearer-path and browser-path toggle tests |
| `tests/unit/api/test_skill_routes.py` | new file | Skill toggle tests (bearer path, browser path) following agent test conventions |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~20 |
| New tests | ~230 |
| Modified code | ~12 |
| **Total** | **~260** |

## Testing Strategy
See `testing.md` for the full executable plan. Summary:
- Unit: dependency behavior matrix (no cookie / cookie without token / cookie with bad token / cookie with valid token).
- API: real route signatures for agent and skill toggles covering bearer path (no cookie -> success) and browser path (cookie -> token required and validated).
- Backwards compat: strict `verify_csrf_token_flexible` untouched for edit form and logout; SPA flow unchanged.
- Not executed in this run per skill constraints; tests are delivered in the patch.

## Alternatives Considered

### Alternative 1: Remove CSRF from agent/skill toggles entirely
**Description:** Make all toggle endpoints CSRF-free, arguing bearer clients dominate.
**Pros / Cons:** Simplest diff; but removes protection from cookie-bearing SPA requests on four routes and widens the existing gap (`/servers/toggle`, virtual-servers) instead of closing it.
**Why Rejected:** Explicitly violates the constraint "must not weaken CSRF protection for browser sessions".

### Alternative 2: Keep strict CSRF and teach M2M clients to obtain a session + CSRF token
**Description:** Document a flow where pipelines log in, keep a cookie jar, fetch `/csrf-token`, and attach both.
**Pros / Cons:** No code change; but M2M clients do not have interactive sessions, cookie handling in pipelines is fragile, and it contradicts the registry's own design where bearer clients register assets without cookies.
**Why Rejected:** Structurally unsatisfiable requirement is not fixed by client gymnastics.

### Alternative 3: Double-submit cookie or Origin/Referer checking
**Description:** Replace token validation with a double-submit cookie or Origin allowlist.
**Pros / Cons:** Origin checking is a genuine additional layer; double-submit alone is weaker than signed session-bound tokens and would still need cookie-based branching.
**Why Rejected:** Larger change, weaker or redundant protection relative to the existing signed-token scheme; can be layered later without altering this design.

### Alternative 4 (CHOSEN): Session-conditional CSRF dependency
**Description:** One dependency; enforce signed session-bound token iff a session cookie is present, skip otherwise.
**Pros / Cons:** Tiny diff; keeps browser threat model exactly; unblocks bearer clients everywhere; single symbol prevents future drift. Skip path trusts the auth dependency to reject unauthenticated callers, which it already does.
**Why Rejected:** Not rejected - chosen.

### Comparison Matrix

| Criteria | Chosen (session-conditional) | Alt 1 (remove) | Alt 2 (cookie for M2M) | Alt 3 (origin check) |
|----------|------------------------------|----------------|------------------------|----------------------|
| Browser protection | unchanged/strengthened | weakened | unchanged | strong |
| M2M unblocked | yes | yes | no | yes |
| Diff size | small | smallest | none | medium |
| Consistency guarantee | one shared dep | none | none | per-route |
| New client complexity | none | none | high | none |

## Rollout Plan
- Phase 1: Implementation (this patch; edit `csrf.py` + four route modules + tests).
- Phase 2: Testing (run `tests/unit/auth/test_csrf.py` and the updated route tests via the repo's normal `pytest` flow; not executed in this run).
- Phase 3: Deployment (no config or infra changes; deploy with the next normal registry release).

## Open Questions
- None blocking. (Post-merge hardening idea, out of scope: also validate `Origin`/`Sec-Fetch-Site` on cookie-authenticated mutations for defense in depth.)

## References
- `registry/auth/csrf.py` - existing token scheme and strict dependency.
- `registry/auth/dependencies.py:538` - `nginx_proxied_auth` dual auth model.
- `frontend/src/contexts/AuthContext.tsx` - SPA CSRF interceptor.
- Issue #891.
