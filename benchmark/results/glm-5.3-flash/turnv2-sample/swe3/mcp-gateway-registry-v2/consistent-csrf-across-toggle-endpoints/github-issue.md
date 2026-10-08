# GitHub Issue: Make CSRF protection consistent across all toggle endpoints and compatible with bearer-token M2M clients

## Title
Consistent, bearer-compatible CSRF protection across all `/toggle` endpoints (server, agent, skill, virtual server)

## Labels
- bug
- enhancement
- security
- api

## Description

### Problem Statement

CSRF protection on the registry's toggle endpoints is inconsistent, and where it is applied it breaks legitimate programmatic clients:

1. **Inconsistent coverage.** The registry exposes six POST toggle endpoints across the server, agent, skill, and virtual-server route modules. All of them authenticate with the same `nginx_proxied_auth` dependency (or `enhanced_auth` for the UI form route), yet only some of them also carry the `verify_csrf_token_flexible` CSRF dependency:

   | Toggle endpoint | File | CSRF dependency today |
   |---|---|---|
   | `POST /api/toggle/{service_path}` (UI form) | `registry/api/server_routes.py` | yes |
   | `POST /api/servers/toggle` (external API) | `registry/api/server_routes.py` | **no** |
   | `POST /api/internal/toggle` (internal JWT) | `registry/api/server_routes.py` | no (internal-only auth) |
   | `POST /api/agents/{path}/toggle` | `registry/api/agent_routes.py` | yes |
   | `POST /api/skills/{path}/toggle` | `registry/api/skill_routes.py` | yes |
   | `POST /api/virtual-servers/{path}/toggle` | `registry/api/virtual_server_routes.py` | **no** |

   A cookie-authenticated browser session can therefore be tricked into firing CSRF state changes on the virtual-server toggle and (for form-encoded requests) the `/api/servers/toggle` endpoint, because those two have no CSRF dependency at all.

2. **Bearer-token M2M clients are locked out of agent and skill toggles.** Agents and skills are registered disabled by default. An OAuth M2M client authenticated with a bearer token can register an agent or skill through `POST /api/agents/register` or `POST /api/skills/register`, but the follow-up enable call `POST /api/agents/{path}/toggle?enabled=true` or `POST /api/skills/{path}/toggle` fails with `403 CSRF validation failed: no token provided`.

   The failure is structural, not a misconfiguration: `verify_csrf_token_flexible` requires both a CSRF token and the `mcp_gateway_session` cookie it is signed against. A bearer-token client has no session cookie, so there is no valid way for it to satisfy the check. Every automated registration pipeline is broken at its last step (register succeeded, enable blocked).

### Proposed Solution

Introduce a single shared CSRF dependency that is **stateful-aware**: it enforces the full CSRF check (token from `X-CSRF-Token` header or form field, validated against the session cookie) only for requests that arrive authenticated via the session cookie, and skips the check for requests that carry no session cookie and are instead authenticated by a bearer credential validated end to end by nginx/auth-server (which is not a CSRF-able credential). Apply that one dependency to every toggle endpoint so coverage is uniform, keeping the internal `/api/internal/toggle` (which does not use session or bearer user auth at all) as the documented exception. No browser request loses protection: cookie-bearing requests are still CSRF-checked on all six toggle routes.

### User Stories

- As an M2M client (CI pipeline, SDK, agent runtime), I want to enable the agent or skill I just registered using my bearer token so that my registration pipeline completes end to end without manual UI intervention.
- As a browser user of the SPA, I want every toggle action I take to remain protected against cross-site request forgery so that a malicious page cannot silently enable or disable my registry assets.
- As a registry operator, I want one consistent CSRF rule applied to all toggle endpoints so that I can reason about and audit the security posture without per-route exceptions.
- As a developer adding a future toggle endpoint, I want a single importable dependency so that consistent protection is the default, not a per-endpoint decision.

### Acceptance Criteria

- [ ] Every toggle endpoint that authenticates end users (the five `nginx_proxied_auth`/`enhanced_auth` routes) applies the same shared CSRF dependency.
- [ ] A bearer-token M2M client (no session cookie) can successfully call `POST /api/agents/{path}/toggle` and `POST /api/skills/{path}/toggle` and receive 200.
- [ ] A cookie-authenticated SPA request WITHOUT a valid CSRF token is rejected with 403 on every toggle endpoint, including `/api/servers/toggle` and `/api/virtual-servers/{path}/toggle` where the check is newly added.
- [ ] A cookie-authenticated SPA request WITH a valid `X-CSRF-Token` (fetchable from `GET /api/auth/csrf-token`) succeeds on every toggle endpoint.
- [ ] The existing SPA code paths continue to work without frontend changes (the SPA already attaches `X-CSRF-Token` on all mutating requests via its axios interceptor).
- [ ] `POST /api/internal/toggle` continues to authenticate via the internal shared-secret JWT dependency and remains unaffected by the CSRF layer.
- [ ] The behavioral rule is documented in `docs/api-reference.md` for each affected endpoint.
- [ ] Unit tests cover both the browser path (cookie + token required; cookie without token rejected) and the bearer path (no cookie, no token, succeeds) for the agent, skill, server API, and virtual-server toggles.

### Out of Scope

- Changing the token format, signing, or expiry of CSRF tokens (`registry/auth/csrf.py` token generation stays as-is).
- Extending CSRF protection to non-toggle mutating endpoints (register, edit, delete, rating, ANS link/unlink) - that is a follow-up hardening effort and intentionally excluded to keep this change reviewable.
- Modifying the nginx reverse-proxy configuration or the auth-server `/validate` endpoint.
- Rewriting the SPA CSRF interceptor.
- SameSite or other cookie attribute changes on `mcp_gateway_session`.

### Dependencies

- None. Uses the existing `itsdangerous`-signed CSRF token infrastructure and the existing `X-Auth-Method` header contract between nginx and the registry API.

### Related Issues

- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/891
- Related context: #871 (static bearer token on Registry API paths introduced bearer M2M clients on these same endpoints), #779 (per-key scopes for network-trusted auth)
