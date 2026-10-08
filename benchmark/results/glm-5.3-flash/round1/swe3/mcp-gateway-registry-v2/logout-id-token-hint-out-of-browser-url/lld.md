# Low-Level Design: Logout ID Token Hint Delivered Server-to-Server (Out of Browser URLs)

*Created: 2026-09-30*
*Author: GLM (glm-5.3-flash run)*
*Status: Revised after expert review (Step 7.5); all must-fix findings from `review.md` are folded in (redirect-URI validation parity, consistent `redirect_uri` naming, no-logout_url = success, internal hop only when id_token present).*

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

`registry/auth/routes.py::logout_handler` currently builds a browser-facing redirect to the auth server:

```
{auth_external_url}/oauth2/logout/{provider}?redirect_uri={redirect_uri}&id_token_hint={urlencoded JWT}
```

The OIDC ID token JWT (1000-3000+ characters) therefore traverses a browser-facing URL. Two harms:

1. WAFs / reverse proxies with query-string size or injection rules reject the redirect with 403 before it reaches the auth server. Logout then fails silently: the local session cookie was already cleared, so the user appears logged out of the registry while the IdP SSO session survives.
2. The token lands in browser history and in proxy/CDN/load-balancer access logs while it is being revoked.

### Goals

- Remove `id_token_hint` from every browser-facing URL on our infrastructure (registry and auth server) during logout.
- Keep OIDC RP-Initiated Logout working: the IdP still receives `id_token_hint` (plus the provider-appropriate post-logout redirect parameter) so the SSO session terminates.
- Preserve the local-logout guarantees of the current code: server-side session record deleted and cookie cleared before any redirect.
- Stay backward compatible: deployments on older auth servers (no new endpoint) keep working via the existing browser-facing flow; a configuration flag can disable the new path.

### Non-Goals

- Back-channel logout; removing `id_token_hint` from the final browser-to-IdP navigation (that hop is mandated by the RP-Initiated Logout spec).
- Changing the session store schema, cookie format, or login flow.
- Changing which providers support the hint (Cognito does not; unchanged).
- Any nginx/WAF configuration changes.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/auth/routes.py` | Registry auth routes incl. `logout_handler` (GET+POST `/logout`) | The code that today puts the JWT into the browser-facing redirect URL (lines ~288-314). Primary modification site. |
| `auth_server/server.py` | Auth server FastAPI app | Hosts `oauth2_logout` (`GET /oauth2/logout/{provider}`, lines ~5624-5731) which builds provider-specific IdP logout URLs; hosts `internal_router` (lines ~1810-1826). Both are modification sites. |
| `auth_server/internal_request_token.py` | Mint/verify short-lived HS256 internal JWTs for nginx->backend hops | Reuse of the pattern; `registry/auth/internal.py` is the module the registry uses to mint. |
| `registry/auth/internal.py` | `generate_internal_token` + `validate_internal_auth` (signed-Bearer internal JWT, single-use jti) | The exact mechanism the registry will use to authenticate to the new internal endpoint. |
| `registry/services/scope_service.py` (`_trigger_auth_server_reload`) | Existing registry->auth-server internal POST with Bearer token over `settings.auth_server_url` | The template for the new HTTP call (client, header, timeout, error handling). |
| `registry/auth/session_store.py` / `auth_server/session_store.py` | MongoDB session store; `resolve_session` returns `id_token` (decrypted); `delete_session` | Logout already resolves `id_token` server-side; no schema change needed. |
| `registry/core/config.py` | `Settings` (pydantic-settings): `auth_server_url`, `auth_server_external_url`, counters-adjacent fields | New `logout_hint_via_internal` flag goes here. |
| `registry/observability/meters.py` + `registry/observability/_compat.py` | OTel counters wrapped in `_CounterAdapter` (`.labels(...).inc()` shim) | New counters follow the same declaration pattern. |
| `docker/nginx_rev_proxy_http_and_https.conf`, `docker/nginx_rev_proxy_http_only.conf` | nginx locations `/oauth2/logout/` proxying to the auth server | Stays as-is: it serves the fallback path and not-yet-upgraded registries. |
| `docs/design/session-flow-cookie-based.md` | Logout sequence + counter documentation | Must be updated to describe the new flow. |
| `tests/unit/auth/test_build_external_url.py`, `tests/auth_server/unit/test_server.py` | Test conventions (monkeypatch/patch, TestClient, `_patch_httpx_async_client`) | New tests follow these conventions. |

### Existing Patterns Identified

1. **Internal service-to-service hop with signed-Bearer JWT**: `internal_router = APIRouter(prefix="/internal", dependencies=[Depends(validate_internal_auth)])` on the auth server; callers mint via `registry.auth.internal.generate_internal_token(subject=..., purpose=...)` and POST with `Authorization: Bearer <jwt>` to `settings.auth_server_url` (see `scope_service._trigger_auth_server_reload`). Tokens are single-use (jti replay store) with a 60-second TTL.
2. **Provider-specific logout URL construction**: `oauth2_logout` branches on Keycloak (`/realms/` path or name), Entra ID (`login.microsoftonline.com`), Okta (name or `*.okta.com`), else Cognito-shaped. Keycloak/Entra/Okta take `id_token_hint`; Cognito does not.
3. **Session resolution at logout**: `logout_handler` resolves the server-side session (`provider`, `id_token`, `session_id`), deletes the record, clears the cookie, then redirects. This ordering is preserved.
4. **Metrics via `_CounterAdapter`-wrapped OTel counters** declared in `registry/observability/meters.py`, asserted by name in `tests/unit/observability/test_meters.py`.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `internal_router` (auth server) | Extends | New `POST /internal/logout-url` inherits the router-level internal-JWT gate. |
| `logout_handler` (registry) | Modifies | Calls the new endpoint when enabled; falls back to the legacy browser-facing redirect on failure. |
| `oauth2_logout` (auth server) | Refactors | Extract the provider-branch URL builder into a module-level function used by both the legacy endpoint and the new internal endpoint. |
| Session store | Uses (read-only) | `id_token` already available from `resolve_session`; no schema change. |

### Constraints and Limitations Discovered

- **Shared `SECRET_KEY` requirement**: internal JWTs require both services to share `SECRET_KEY` (already a deployment invariant; the session crypto uses it too).
- **Single-use jti**: each call mints a fresh token; a retry after network failure must re-mint (the retry loop mints per attempt).
- **Namespace/collection sharing**: any new MongoDB collection gets the `<base>_<namespace>` convention via `get_collection_name` - not needed here (no new collection).
- **`redirect_uri` validation**: `oauth2_logout` validates absolute redirect URIs against the cookie domain; the extracted builder keeps that validation.
- **`registry/auth/routes.py` namespace aliasing**: the module imports counters with aliases (`logout_id_token_hint_present` etc.); new counters follow the same import style.

## Architecture

### System Context Diagram

```
                        BEFORE (today)
Browser --GET /logout--> Registry --303 Location: authserver/oauth2/logout/{prov}?>
                          ?redirect_uri=...&id_token_hint=<3000-char JWT>   <-- problem
        Browser --GET--> WAF/proxy --403 (query too big / injection rule)   <-- silent failure

                        AFTER
Browser --GET /logout--> Registry --POST /internal/logout-url (Bearer internal JWT,
                          JSON body {provider, id_token, redirect_uri}) over
                          internal network --> Auth Server
        Auth Server returns {logout_url} (IdP URL, hint embedded server-side)
Registry --303 Location: <IdP logout URL with id_token_hint> --> Browser --> IdP
        (fallback: any internal failure => legacy browser-facing redirect as today)
```

### Sequence Diagram

```
User                Registry                        Auth Server                    IdP
 |  GET /logout       |                                  |                           |
 |------------------->| resolve session (id_token,       |                           |
 |                    | provider, session_id)            |                           |
 |                    | delete server-side session       |                           |
 |                    | clear cookie                     |                           |
 |                    | POST /internal/logout-url        |                           |
 |                    |   Authorization: Bearer <intJWT> |                           |
 |                    |--------------------------------->| validate internal JWT     |
 |                    |                                  | build provider logout URL |
 |                    |   200 {logout_url: "https://idp/...?id_token_hint=..."}      |
 |                    |<---------------------------------|                           |
 |  303 Location: <IdP logout URL>                       |                           |
 |<-------------------|                                  |                           |
 |------------------------------------GET---------------------------------------------->|
 |                    |                        IdP validates hint, terminates SSO    |
```

### Component Diagram

```
registry/auth/routes.py                auth_server/server.py
+------------------------+             +--------------------------------------+
| logout_handler         |             | oauth2_logout (legacy, GET, browser) |
|  - resolve/delete sess |             |   uses _build_provider_logout_url()  |
|  - NEW: _request_logout|  httpx      | +------------------------------------+
|    _url_via_internal() |------------>| POST /internal/logout-url            |
|  - fallback: legacy URL|  Bearer JWT |   (internal_router, validate_        |
|  - 303 -> IdP URL      |             |    internal_auth)                    |
+------------------------+             |   uses _build_provider_logout_url()  |
                                       +--------------------------------------+
would-be shared helper: _build_provider_logout_url(provider, provider_config,
                       id_token_hint, full_redirect_uri, request) -> str
```

## Data Models

### New Models (auth server)

```python
class InternalLogoutUrlRequest(BaseModel):
    """Body for POST /internal/logout-url."""

    provider: str = Field(..., min_length=1, description="OAuth2 provider key as configured in OAUTH2_CONFIG")
    id_token: str | None = Field(default=None, description="OIDC ID token to pass as id_token_hint; may be None")
    redirect_uri: str | None = Field(default=None, description="Registry URL to return to after IdP logout")


class InternalLogoutUrlResponse(BaseModel):
    """Response for POST /internal/logout-url."""

    logout_url: str = Field(..., min_length=1, description="Fully built IdP logout URL for a browser redirect")
    id_token_hint_included: bool = Field(..., description="Whether the hint was embedded (False for Cognito-shaped providers)")
```

### Model Changes

None. The session store schema is untouched.

## API / CLI Design

### New Endpoint: `POST /internal/logout-url` (auth server)

**Description:** Builds the provider-specific IdP logout URL for the given provider and returns it. Gated by the router-level `validate_internal_auth` dependency on `internal_router`; the handler re-declares `caller: str = Depends(validate_internal_auth)` for audit logging (cached per request by FastAPI).

**Request / Invocation** (from the registry):

```python
token = generate_internal_token(subject="registry-service", purpose="logout-url")
POST {settings.auth_server_url}/internal/logout-url
Authorization: Bearer <token>
{"provider": "keycloak", "id_token": "<jwt>", "redirect_uri": "https://registry.example.com/logout"}
```

**Expected Response:**

```json
{ "logout_url": "https://idp.example.com/realms/mcp/protocol/openid-connect/logout?client_id=...&post_logout_redirect_uri=...&id_token_hint=<jwt>", "id_token_hint_included": true }
```

**Error Cases:**

- 401: missing/invalid/expired/replayed internal JWT (existing `validate_internal_auth` semantics).
- 404: unknown provider (`HTTPException(404, "Provider {provider} not found")`, matching `oauth2_logout`).
- 422: body validation (pydantic).
- 500: `SECRET_KEY` unset for token verification (existing behavior of the validator).

The registry treats every non-200 (and any `httpx` exception) as "internal path unavailable" and falls back.

### Modified Endpoint: `GET /oauth2/logout/{provider}` (auth server, unchanged contract)

Behavior is identical to today; the provider-branch logic moves into `_build_provider_logout_url` and the endpoint calls it. Query-parameter `id_token_hint` continues to be accepted for old registries.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `LOGOUT_HINT_VIA_INTERNAL` | bool | `true` | No | When true, the registry fetches the IdP logout URL from the auth server over the internal network instead of redirecting the browser with the hint in the URL. Any internal-call failure falls back to the legacy redirect. Set `false` to disable the internal hop entirely. |

### Settings / Config Class Updates

```python
# registry/core/config.py (Settings)
logout_hint_via_internal: bool = Field(
    default=True,
    description=(
        "Deliver the OIDC id_token_hint to the auth server over the internal "
        "network (POST /internal/logout-url) during logout instead of putting "
        "it into the browser-facing /oauth2/logout redirect URL. Falls back to "
        "the legacy redirect when the internal call fails. Disable to force "
        "the legacy browser-facing flow."
    ),
)
```

### Deployment Surface Checklist

- [x] `.env.example` - add `LOGOUT_HINT_VIA_INTERNAL=true` with a comment (near the other auth settings).
- [ ] Docker Compose - not required: pydantic-settings reads environment; no compose file hardcodes the new flag (default is fine).
- [ ] Helm charts - not required for default; operators may set the env var as with other `Settings` fields.
- [ ] Docs - `docs/design/session-flow-cookie-based.md` logout section and counter list.

## New Dependencies

None. This change uses only existing dependencies (`httpx`, `pydantic`, PyJWT via `registry.auth.internal`).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Extract the provider logout-URL builder (auth server)

**File:** `auth_server/server.py`
**Lines:** new module-level function placed just above `oauth2_logout` (~line 5620)

```python
def _build_provider_logout_url(
    provider: str,
    provider_config: dict,
    id_token_hint: str | None,
    full_redirect_uri: str,
    request: Request | None = None,
) -> tuple[str, bool]:
    """Build the provider-specific IdP logout URL.

    Returns (logout_redirect_url, id_token_hint_included). The branch conditions
    and parameters are moved verbatim from oauth2_logout so the legacy browser
    endpoint and the new internal endpoint stay behaviorally identical.
    """
    logout_url = provider_config.get("logout_url")
    if not logout_url:
        return ("", False)

    parsed_logout_url = urlparse(logout_url)
    logout_hostname = parsed_logout_url.hostname or ""
    logout_path = parsed_logout_url.path or ""
    provider_name = provider.lower()

    if "keycloak" in provider_name or "/realms/" in logout_path:
        logout_params = {
            "client_id": provider_config["client_id"],
            "post_logout_redirect_uri": full_redirect_uri,
        }
        if id_token_hint:
            logout_params["id_token_hint"] = id_token_hint
        included = bool(id_token_hint)
        logger.debug(f"Keycloak logout params built: has_id_token_hint={bool(id_token_hint)}")
    elif logout_hostname == "login.microsoftonline.com" or "entra" in provider_name:
        logout_params = {"post_logout_redirect_uri": full_redirect_uri}
        if id_token_hint:
            logout_params["id_token_hint"] = id_token_hint
        included = bool(id_token_hint)
        logger.debug(f"Entra ID logout params built: has_id_token_hint={bool(id_token_hint)}")
    elif "okta" in provider_name or (logout_hostname and logout_hostname.endswith(".okta.com")):
        logout_params = {"post_logout_redirect_uri": full_redirect_uri}
        if id_token_hint:
            logout_params["id_token_hint"] = id_token_hint
        included = bool(id_token_hint)
        logger.debug(f"Okta logout params built: has_id_token_hint={bool(id_token_hint)}")
    else:
        # Cognito-shaped: no id_token_hint support
        logout_params = {
            "client_id": provider_config["client_id"],
            "logout_uri": full_redirect_uri,
        }
        included = False
        logger.debug("Cognito logout params built (no id_token_hint)")

    return (f"{logout_url}?{urllib.parse.urlencode(logout_params)}", included)
```

Note the original `oauth2_logout` reads `provider.lower()` in the Entra branch - the helper passes the provider name in, so behavior is preserved.

#### Step 2: Rewire `oauth2_logout` to use the helper

**File:** `auth_server/server.py`
**Lines:** ~5624-5731 (`oauth2_logout`)

Keep the endpoint signature, the `redirect_uri` safety validation, the `registry_base` derivation and the "no logout_url" early return exactly as-is; replace the inline branch block with a call to `_build_provider_logout_url` and use its first return value for the redirect. No contract change.

#### Step 3: Add the internal endpoint (auth server)

**File:** `auth_server/server.py`
**Lines:** new handler placed near the other `@internal_router` handlers (e.g. after `/internal/reload-scopes`, ~line 4405-4442)

```python
class InternalLogoutUrlRequest(BaseModel):
    provider: str = Field(..., min_length=1)
    id_token: str | None = Field(default=None)
    redirect_uri: str | None = Field(default=None)


class InternalLogoutUrlResponse(BaseModel):
    logout_url: str = Field(..., min_length=1)
    id_token_hint_included: bool


@internal_router.post("/logout-url", response_model=InternalLogoutUrlResponse)
async def internal_logout_url(
    body: InternalLogoutUrlRequest,
    caller: str = Depends(validate_internal_auth),
):
    """Build the IdP logout URL for the given provider (internal hop).

    Called by the registry during RP-initiated logout so the OIDC id_token_hint
    never has to traverse a browser-facing URL on our infrastructure (issue
    #1503). The registry redirects the browser straight to the returned IdP URL.
    """
    if body.provider not in OAUTH2_CONFIG.get("providers", {}):
        raise HTTPException(status_code=404, detail=f"Provider {body.provider} not found")

    provider_config = OAUTH2_CONFIG["providers"][body.provider]
    logout_url = provider_config.get("logout_url")
    if not logout_url:
        # No IdP logout endpoint configured: hand back the registry return URL
        # so the caller can finish the local-only logout as today.
        fallback = body.redirect_uri or OAUTH2_CONFIG.get("registry", {}).get("success_redirect", "/login")
        if not fallback.startswith("http"):
            fallback = _ absolutize(fallback, ...)  # same registry_base logic as oauth2_logout
        return InternalLogoutUrlResponse(logout_url=fallback, id_token_hint_included=False)

    full_redirect_uri = _absolutize_redirect(body.redirect_uri, ...)  # same as oauth2_logout lines 5662-5675
    logout_redirect_url, included = _build_provider_logout_url(
        body.provider, provider_config, body.id_token, full_redirect_uri
    )
    return InternalLogoutUrlResponse(logout_url=logout_redirect_url, id_token_hint_included=included)
```

(The `_absolutize_redirect` bits are inlined in the final implementation, mirroring `oauth2_logout`'s `registry_base` derivation; the pseudo-code above marks where.)

Redirect-safety: `oauth2_logout` validates absolute `redirect_uri` values against the cookie domain before use. The internal endpoint applies the same `_is_redirect_within_cookie_domain` check and, on failure, **drops `redirect_uri` silently** (yielding `/login` behavior downstream) exactly like the legacy guard - it does not error, so a caller-supplied absolute URI outside the trust boundary can never reach the IdP through the new path (Security review must-fix item).

#### Step 4: Registry side - request the logout URL over the internal network

**File:** `registry/auth/routes.py`
**Lines:** new helper near `logout_handler` (~line 236), plus modifications inside `logout_handler`

```python
async def _fetch_logout_url_via_internal(
    provider: str,
    id_token: str | None,
    redirect_uri: str,
) -> tuple[str, bool] | None:
    """Fetch the IdP logout URL from the auth server over the internal hop.

    Returns (logout_url, id_token_hint_included) on success, or None when the
    internal path is unavailable (caller falls back to the legacy redirect).
    Never raises.
    """
    try:
        from .internal import generate_internal_token

        token = generate_internal_token(subject="registry-service", purpose="logout-url")
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{settings.auth_server_url}/internal/logout-url",
                json={"provider": provider, "id_token": id_token, "redirect_uri": redirect_uri},
                headers={"Authorization": f"Bearer {token}"},
                timeout=5.0,
            )
        if response.status_code != 200:
            logger.warning(
                "Internal logout-url fetch failed: HTTP %s (falling back to legacy redirect)",
                response.status_code,
            )
            logout_internal_fallback.inc()
            return None
        data = response.json()
        return (data["logout_url"], bool(data.get("id_token_hint_included")))
    except Exception as e:
        logger.warning(f"Internal logout-url fetch failed: {e} (falling back to legacy redirect)")
        logout_internal_fallback.inc()
        return None
```

#### Step 5: Wire the fallback-preserving logic into `logout_handler`

**File:** `registry/auth/routes.py`
**Lines:** inside `logout_handler`, replacing the `if provider:` block (~lines 288-322)

```python
if provider:
    auth_external_url = settings.auth_server_external_url
    redirect_uri = _build_external_url(request, "/logout")
    legacy_logout_url = f"{auth_external_url}/oauth2/logout/{provider}?redirect_uri={redirect_uri}"

    logout_url: str | None = None
    if settings.logout_hint_via_internal and id_token:
        # Only invoke the internal hop when the session actually carries an
        # id_token; the no-token case goes straight to legacy so the
        # logout_id_token_hint_missing_total counter keeps its meaning.
        fetched = await _fetch_logout_url_via_internal(provider, id_token, redirect_uri)
        if fetched is not None:
            logout_url = fetched[0]
            logout_internal_success.inc()
            logger.debug("Logout hint delivered via internal hop, has_id_token=True")

    if logout_url is None:
        # Legacy browser-facing flow (also used when the session had no id_token,
        # preserving today's behavior and counters on that path).
        if id_token:
            if not _validate_jwt_format(id_token):
                logger.debug("id_token failed JWT format validation, not forwarding")
                logout_jwt_validation_failed.inc()
            else:
                encoded_token = urllib.parse.quote(id_token, safe="")
                legacy_logout_url = f"{legacy_logout_url}&id_token_hint={encoded_token}"
                if len(legacy_logout_url) > 2000:
                    logger.debug(f"Logout URL length ({len(legacy_logout_url)}) exceeds recommended limit (2000)")
                    logout_url_length_warning.inc()
                logger.debug("id_token extracted and forwarded, has_id_token=True")
                logout_id_token_hint_present.inc()
        else:
            logger.debug("id_token not present in session, has_id_token=False")
            logout_id_token_hint_missing.inc()
        logout_url = legacy_logout_url

    logger.debug(f"Redirecting to {provider} logout")
    response = RedirectResponse(url=logout_url, status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(
        settings.session_cookie_name,
        path="/",
        domain=settings.session_cookie_domain,
    )
```

Behavioral notes:

- The `id_token` present/missing counters only fire on the legacy path, preserving their meaning ("the hint was put into / was absent from the browser-facing URL").
- When the internal path returns a URL, that URL already embeds the hint (or, for Cognito-shaped providers, legitimately has none); the legacy counters would be misleading there, so the new success/fallback counters (below) cover it.
- The 2000-character URL-length warning only applies to the legacy URL.
- The JWT format validation gate stays on the legacy path only. On the internal path the auth server embeds whatever it is given into the IdP URL exactly as the legacy auth-server endpoint would have; the same trust boundary applies (the token came from the encrypted session store).

#### Step 6: New counters

**File:** `registry/observability/meters.py` (declaration) and `registry/auth/routes.py` (imports)

```python
_logout_internal_hint_success_counter = _meter.create_counter(
    name="mcpgw_registry_logout_internal_hint_success_total",
    description="Logouts where the id_token_hint was delivered via the internal hop",
    unit="1",
)
logout_internal_hint_success_total = _CounterAdapter(_logout_internal_hint_success_counter)

_logout_internal_hint_fallback_counter = _meter.create_counter(
    name="mcpgw_registry_logout_internal_hint_fallback_total",
    description="Logouts where the internal hint hop failed and the legacy browser-facing redirect was used",
    unit="1",
)
logout_internal_hint_fallback_total = _CounterAdapter(_logout_internal_hint_fallback_counter)
```

(Import in `routes.py` with the same alias style as the existing four counters.)

#### Step 7: Config flag

**File:** `registry/core/config.py` - add `logout_hint_via_internal: bool = Field(default=True, ...)` as shown under Configuration Parameters.

**File:** `.env.example` - document the variable next to the other auth-related settings.

#### Step 8: Documentation

**File:** `docs/design/session-flow-cookie-based.md` - update the logout section: describe the internal hop, the fallback, the two new counters, and why the hint no longer transits a registry/auth-server URL.

### Error Handling

- **Registry internal call**: never raises. Any exception / non-200 => log WARNING, bump `logout_internal_hint_fallback_total`, use the legacy redirect. Logout can never fail *worse* than today because of this change.
- **Auth server internal endpoint**: 404 on unknown provider (same message as legacy), 401 via the router gate, 422 on malformed body. Unexpected exceptions propagate as 500; the registry falls back.
- **Fallback semantics on "no logout_url" providers**: preserved. The internal endpoint returns an absolutized plain URL (no IdP params) with `id_token_hint_included=false` as a **200 success** response, and the registry uses it as the logout redirect exactly as if the IdP URL had been returned; it is NOT treated as a fallback (Backend review must-fix item).

### Logging

- Registry: WARNING on internal-call failure (includes the HTTP status or exception class, never the token); DEBUG on success (no token material). A 404 from an auth server predating this change is the known mixed-version state; logging it at WARNING is acceptable but operators should expect it during rolling upgrades.
- Auth server: INFO `POST /internal/logout-url call from '<caller>'` (mirrors `/internal/tokens`); DEBUG the same provider-param messages the legacy path already emits. Never log the JWT.
- Browser-facing navigation is single-hop in the new flow (registry straight to the IdP) instead of the legacy two-hop chain through the auth server; this is intentional and documented here so it is not "fixed" later.

## Observability

- New counters: `mcpgw_registry_logout_internal_hint_success_total`, `mcpgw_registry_logout_internal_hint_fallback_total`.
- Existing counters unchanged in meaning: `...logout_id_token_hint_present_total` and `..._missing_total` now strictly measure the legacy/fallback path; `..._jwt_validation_failed_total` and `..._url_length_warning_total` likewise.
- Healthy vs degenerate patterns (for dashboards/alerts): success rising with fallback at 0 = internal path healthy; sustained fallback > 0 with success == 0 = registry is on the legacy path (mixed-version deploy, `LOGOUT_HINT_VIA_INTERNAL` misconfig, shared consumed-jti store unreachable, or auth-server unreachable). Because the consumed-jti store lives in MongoDB, a Mongo degradation can push logouts onto the legacy (WAF-visible) path while logout itself keeps working; the fallback counter is the signal.
- The internal hop appears in existing OTel HTTP server/client spans (FastAPI + httpx auto-instrumentation), so latency and failure rates are observable without new tracing code.

## Scaling Considerations

- Load profile is unchanged in count (one extra internal POST per OAuth2 logout, a low-frequency operation); latency added is one internal round trip (single-digit milliseconds in-cluster, 5 s timeout).
- The auth-server endpoint is stateless; it scales horizontally exactly like the rest of the app.
- Internal JWTs are single-use with a 60 s TTL; the jti replay store is already sized for per-request minting patterns (used by every `/internal/*` call).
- No new DB collection, no caching needed (the URL build is pure string work).

## File Changes

### New Files

None. (The change fits naturally into existing modules; a new module would be over-engineering for two small additions.)

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `auth_server/server.py` | ~5620-5731, ~4405+ | Extract `_build_provider_logout_url`; rewire `oauth2_logout`; add `InternalLogoutUrlRequest`/`InternalLogoutUrlResponse` models and `POST /internal/logout-url` handler on `internal_router`. |
| `registry/auth/routes.py` | ~1-30 (imports), ~236+ | Add `_fetch_logout_url_via_internal`; rework `logout_handler`'s provider branch with internal-first + legacy-fallback; import the two new counters. |
| `registry/core/config.py` | ~200 (Settings) | Add `logout_hint_via_internal` field. |
| `registry/observability/meters.py` | ~415+ | Declare the two new counters. |
| `.env.example` | near auth settings | Document `LOGOUT_HINT_VIA_INTERNAL`. |
| `docs/design/session-flow-cookie-based.md` | Logout section | Update sequence + counters. |
| `tests/auth_server/unit/test_server.py` | new class | Tests: internal endpoint builds provider URLs (all four families), 404 unknown provider, 401 unauthenticated, legacy endpoint unchanged. |
| `tests/unit/auth/test_logout_internal_hint.py` | new file | Registry tests: internal success path (no hint in browser URL), fallback on 404/exception, flag-off behavior, counters. |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~200 |
| New tests | ~250 |
| Modified code | ~80 (net) |
| **Total** | **~530** |

## Testing Strategy

See `testing.md` for the full executable plan. Summary: unit tests for the URL builder (all four provider families), the internal endpoint (auth gate, 404, no-logout_url fallback), the registry handler (internal success, fallback on failure, flag off, session/cookie invariants), and metric name registration; manual curl/WAF-style checks for the browser-facing behavior.

## Alternatives Considered

### Alternative 1: Back-channel logout (registry calls IdP token endpoint / back-channel)

**Description:** Terminate the IdP session server-side without any browser hop.
**Pros / Cons:** Removes the hint from all browser URLs, but requires per-IdP back-channel support (most don't implement it), IdP-side session cookies aren't reachable, and the browser's IdP session survives anyway in most deployments.
**Why Rejected:** Not portable; out of scope per the issue.

### Alternative 2: POST the hint to the auth server from the browser (form auto-submit)

**Description:** Registry returns an HTML page that form-POSTs `id_token_hint` to the auth server.
**Pros / Cons:** Keeps the token out of query strings but keeps it in the browser context and breaks the simple redirect semantics (GET /logout must now return HTML); still fails behind strict WAFs inspecting bodies.
**Why Rejected:** More browser-facing complexity for less protection than the internal hop.

### Alternative 3: Short-lived opaque logout ticket (server-side, single-use)

**Description:** Registry stores the hint server-side under a random ticket; auth server redeems it.
**Pros / Cons:** Removes the token from URLs with a single-use secret, but adds a new MongoDB collection, TTL/index management, and cross-service cleanup for a problem the internal hop already solves with existing, proven machinery.
**Why Rejected:** More moving parts than the internal call; the ticket would need its own replay/TTL story that `validate_internal_auth` already provides for free.

### Alternative 4 (chosen): internal service-to-service logout-URL exchange

**Description:** As designed above.
**Pros / Cons:** Reuses the existing internal-JWT gate and httpx patterns; single round trip; clean fallback story.
**Why Chosen:** Simplest design that removes the token from every browser-facing URL on our infrastructure while keeping RP-initiated logout intact.

### Comparison Matrix

| Criteria | Chosen (internal hop) | Alt 1 (back-channel) | Alt 2 (form POST) | Alt 3 (ticket) |
|----------|-----------------------|----------------------|-------------------|----------------|
| Complexity | Low | High | Medium | Medium |
| Token out of our browser URLs | Yes | Yes | Partial | Yes |
| Portable across IdPs | Yes | No | Yes | Yes |
| New infra/state | None | IdP-dependent | None | New collection |
| Fallback story | Trivial | Hard | Awkward | Medium |

## Rollout Plan

- Phase 1: Implementation (this change; flag defaults to on with automatic fallback).
- Phase 2: Testing (see `testing.md`).
- Phase 3: Deployment - rolling upgrade safe: old registry + new auth server = old behavior; new registry + old auth server = 404 => fallback to old behavior. Operators may set `LOGOUT_HINT_VIA_INTERNAL=false` to pin the legacy flow at any time.

## Open Questions

- None blocking. (If a deployment terminates the auth server behind a proxy that also WAFs internal traffic, the internal hop is not affected because it is a POST with a JSON body over the internal network; confirm network policy allows registry->auth-server POSTs, which `/internal/reload-scopes` already requires.)

## References

- OIDC RP-Initiated Logout 1.0: https://openid.net/specs/openid-connect-rpinitiated-1_0.html
- Internal-hop authentication design: `docs/design/internal-hop-authentication.md`
- Session flow design: `docs/design/session-flow-cookie-based.md`
- Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1503
