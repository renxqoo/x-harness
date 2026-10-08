# GitHub Issue: Consistent CSRF protection across all toggle endpoints that stays compatible with bearer-token (M2M) auth

## Title
Make CSRF coverage consistent across toggle endpoints without blocking OAuth M2M bearer clients

## Labels
- bug
- security
- enhancement
- api

## Description

### Problem Statement
CSRF protection across the registry's toggle endpoints is inconsistent, and where it is applied it breaks legitimate programmatic clients.

A client authenticated with an OAuth M2M bearer token can register agents, skills, servers, and virtual servers, but cannot ENABLE the agent or skill it just registered: those toggle calls return `403 CSRF validation failed: no token provided`. Agents are registered disabled by default, so every registration pipeline fails at the last step.

The root cause is structural, not a matter of sending the right header. `verify_csrf_token_flexible` requires BOTH a CSRF token AND a session cookie to validate the token against (`registry/auth/csrf.py`). A bearer-token client has no session cookie, so the requirement is unsatisfiable for every M2M caller.

At the same time, two of the browser-reachable toggle endpoints carry no CSRF dependency at all, so a cookie-authenticated browser (SPA) request is unprotected there:

| Toggle endpoint | Auth dependency | CSRF today |
|---|---|---|
| `POST /api/toggle/{service_path}` | `enhanced_auth` (session cookie only) | yes (`verify_csrf_token_flexible`) |
| `POST /api/servers/toggle` | `nginx_proxied_auth` (bearer via nginx headers, or session fallback) | none |
| `POST /api/internal/toggle` | `validate_internal_auth` (internal JWT bearer) | none |
| `POST /api/agents/{path}/toggle` | `nginx_proxied_auth` | yes (`verify_csrf_token_flexible`) - blocks bearer clients |
| `POST /api/skills/{path}/toggle` | `nginx_proxied_auth` | yes (`verify_csrf_token_flexible`) - blocks bearer clients |
| `POST /api/virtual-servers/{path}/toggle` | `nginx_proxied_auth` | none |

All four asset toggles authenticate the same way (`nginx_proxied_auth`), yet only two carry the CSRF dependency.

### Proposed Solution
Introduce one shared CSRF dependency, `verify_csrf_token_if_session_cookie`, that is threat-model aware:

- If the request carries NO session cookie, it cannot be an ambient-credential browser request, so CSRF validation is skipped. Such requests must have authenticated via a bearer token (Authorization headers cannot be attached by cross-site pages), so they are not CSRF-forgeable.
- If the request DOES carry a session cookie, a valid CSRF token (X-CSRF-Token header or csrf_token form field) bound to that session is required, exactly as today.

Apply this single dependency to all six toggle endpoints. Cookie-bearing browser/SPA requests remain CSRF-protected on every toggle endpoint, and bearer-token M2M clients can enable the assets they register.

### User Stories
- As an M2M registration pipeline, I want to enable an agent or skill immediately after registering it with my bearer token, so that my pipeline completes without manual UI steps.
- As an SPA user, I want every toggle action I take in the browser to remain protected against cross-site request forgery, so that an evil page cannot flip my assets.
- As a registry operator, I want uniform, explainable CSRF semantics across all toggle endpoints, so that security review and debugging are straightforward.

### Acceptance Criteria
- [ ] A single shared CSRF dependency exists in `registry/auth/csrf.py` and is used by all six toggle endpoints.
- [ ] A bearer-token request (no session cookie) to ANY toggle endpoint is not rejected with a CSRF error.
- [ ] A request bearing a session cookie but no valid CSRF token is rejected with 403 on EVERY toggle endpoint (including `POST /api/servers/toggle` and `POST /api/virtual-servers/{path}/toggle`, which today have no CSRF check).
- [ ] A request bearing a session cookie and a valid `X-CSRF-Token` (or `csrf_token` form field) bound to that session succeeds on every toggle endpoint.
- [ ] The SPA flow is unchanged: `GET /api/auth/csrf-token` still mints a session-bound token and the SPA still sends it via `X-CSRF-Token`.
- [ ] Unit tests cover the browser path (cookie + missing/invalid/valid token) and the bearer-token path (no cookie) for the toggle endpoints.
- [ ] The strict `verify_csrf_token_flexible` dependency remains available unchanged for non-toggle session-form endpoints (logout, server edit form).

### Out of Scope
- Changing the session-cookie name, the token signing scheme, or token TTL.
- Adding CSRF to non-toggle endpoints (ANS admin endpoints, federation routes, logout, edit forms).
- Changing `nginx_proxied_auth`, `enhanced_auth`, or the nginx auth_request / X-User header wiring.
- Cors/origin-check based CSRF defenses (a separate hardening track).
- Running the target repo's test suite as part of this change delivery.

### Dependencies
- None. Uses only existing dependencies (`itsdangerous`, FastAPI).

### Related Issues
- #891
