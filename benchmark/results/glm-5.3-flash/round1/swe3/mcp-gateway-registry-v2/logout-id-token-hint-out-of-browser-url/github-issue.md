# GitHub Issue: Keep the OIDC id_token_hint out of browser-facing URLs during logout

## Title

Logout: carry `id_token_hint` over an internal service-to-service hop instead of a browser redirect URL

## Labels

- `enhancement`
- `security`
- `bug`
- `area:auth`

## Description

### Problem Statement

During OAuth2 (RP-initiated) logout the registry redirects the browser to the auth server's `/oauth2/logout/{provider}` endpoint with the full OIDC ID token appended to the query string as `id_token_hint` (`registry/auth/routes.py`, `logout_handler`). That JWT is typically 1000-3000+ characters. Routing it through a browser-facing URL has two consequences:

1. **Silent logout failures behind WAFs / reverse proxies.** Any WAF or proxy inspecting inbound requests applies query-string length limits and injection rules. A multi-kilobyte JWT in the query string is commonly rejected with a 403 before the request reaches the auth server. Because the registry has already cleared the local session cookie and deleted the server-side session record by that point, the user is logged out locally but the SSO session at the identity provider survives, and nothing tells the user anything went wrong.
2. **Information disclosure of a live credential.** The token lands in browser history and in the access logs of every proxy, CDN, and load balancer in front of the deployment, for a credential that is in the middle of being revoked.

The provider still needs the hint: OIDC RP-Initiated Logout uses `id_token_hint` so the IdP can identify the session being terminated and validate the `post_logout_redirect_uri`. The fix must keep RP-initiated logout working; what changes is the transport of the hint on every hop of our infrastructure before the browser is sent to the IdP.

### Proposed Solution

Exchange the browser-facing registry-to-auth-server hop for an authenticated internal service-to-service call:

- Add `POST /internal/logout-url` to the auth server on the existing `internal_router` (gated by the shared-`SECRET_KEY` signed-Bearer internal JWT, exactly like `/internal/tokens` and `/internal/reload-scopes`). The JSON body carries `{provider, id_token, redirect_uri}`; the response returns the fully built, provider-specific IdP logout URL (with `id_token_hint` embedded for the providers that support it, per the OIDC spec).
- The registry's `logout_handler` resolves the session as today, then calls that endpoint over the internal network (`settings.auth_server_url`) and 303-redirects the browser straight to the returned IdP logout URL. The token never appears in a query string on a browser-facing hop of our deployment: the browser only ever receives the final IdP logout URL as a `Location` response header.
- If the internal call fails for any reason (auth server too old and returns 404, network segmentation, 5xx, timeout), the registry falls back to the legacy browser-facing `/oauth2/logout/{provider}?...&id_token_hint=...` redirect, which is kept unchanged. A `LOGOUT_HINT_VIA_INTERNAL` setting (default `true`) lets an operator disable the new path entirely.
- The existing browser-facing `GET /oauth2/logout/{provider}` endpoint continues to accept `id_token_hint` as a query parameter for older registries (backward compatibility).

### User Stories

- As an operator running the gateway behind a WAF, I want logout to work regardless of my WAF's query-string rules so that users are fully logged out, including at the identity provider.
- As a user logging out, I want my SSO session terminated everywhere in one click so that I do not remain signed in at the identity provider.
- As a security engineer, I do not want live credentials in URLs that browser history and proxy/CDN access logs capture so that the disclosure surface of the ID token stays minimal.

### Acceptance Criteria

- [ ] With the internal path active, the browser-facing redirect issued by the registry during OAuth2 logout contains no `id_token_hint` parameter and is not a URL on the auth server; it goes directly to the IdP logout endpoint.
- [ ] RP-initiated logout still works: the IdP receives `id_token_hint` (and the provider-appropriate `post_logout_redirect_uri` / `logout_uri`) exactly as before.
- [ ] The new auth-server endpoint is gated by the existing internal JWT authentication (`validate_internal_auth`) and rejects unauthenticated calls with 401.
- [ ] Provider-specific logout URL construction (Keycloak, Entra ID, Okta, Cognito-shaped fallback) is shared between the legacy endpoint and the new internal endpoint, with no behavior change to the legacy endpoint.
- [ ] On any internal-call failure the registry falls back to the legacy browser-facing redirect, so logout keeps working against an auth server that does not have the new endpoint (rolling upgrades, mixed versions).
- [ ] A `LOGOUT_HINT_VIA_INTERNAL=false` deployment behaves exactly as before the change (no internal call attempted).
- [ ] The local session is still invalidated (server-side record deleted and cookie cleared) before any redirect, in both paths.
- [ ] New observability counters record internal-hint success and fallback outcomes, and the existing `logout_id_token_hint_*` counters keep their meaning on the fallback path.

### Out of Scope

- Back-channel logout (OIDC Back-Channel Logout 1.0) and any IdP-specific admin/session-termination APIs.
- Eliminating `id_token_hint` from the final browser-to-IdP navigation; that hop is mandated by the RP-Initiated Logout spec ("the provider still needs the hint") and terminates the IdP's own browser session.
- Changes to nginx routing: the `/oauth2/logout/` location stays for the fallback path and for not-yet-upgraded registries.
- Changes to session storage, cookie handling, or login flows.
- Changing which providers support `id_token_hint` (Cognito does not; that is unchanged).

### Dependencies

- None. Uses only existing dependencies (`httpx`, `pydantic`, the shared internal-JWT module).

### Related Issues

- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1503
- Related design: `docs/design/session-flow-cookie-based.md` (logout section)
- Prior related work: server-side session store with encrypted `id_token`; internal-hop signed-Bearer authentication.
