# Testing Plan: Logout ID Token Hint Delivered Server-to-Server

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing

Verifies that (a) the auth server's new internal endpoint builds provider-correct IdP logout URLs behind the internal JWT gate, (b) the registry's logout uses the internal hop when available and falls back to the legacy browser-facing redirect on any failure, and (c) the legacy flow is byte-identical to its pre-change behavior.

### Prerequisites

- [ ] Both services importable in the test environment (`registry`, `auth_server` packages on the repo checkout at tag `1.27.1` + patch).
- [ ] `SECRET_KEY` set in the test environment (the shared `tests/auth_server/conftest.py::auth_env_vars` fixture provides it).
- [ ] No live MongoDB, IdP, or network required: unit tests mock the session store and httpx layer per existing conventions (`tests/auth_server/unit/test_server.py::_patch_httpx_async_client`, `unittest.mock.patch`/`MagicMock`).

### Shared Variables

```bash
export SECRET_KEY="test-secret-key-for-pytest-only-not-production"
# IdP logout endpoints used in assertions (from auth_server/oauth2_providers.yml style configs):
KEYCLOAK_LOGOUT="https://idp.example.com/realms/mcp/protocol/openid-connect/logout"
ENTRA_LOGOUT="https://login.microsoftonline.com/common/oauth2/v2.0/logout"
OKTA_LOGOUT="https://example.okta.com/oauth2/v1/logout"
COGNITO_LOGOUT="https://example.auth.us-east-1.amazoncognito.com/logout"
```

## 1. Functional Tests

### 1.1 Auth server: internal logout-URL endpoint (unit)

New test class in `tests/auth_server/unit/test_server.py` (mirrors `TestOAuth2CallbackTokenStorage` conventions):

- **1.1.1 Keycloak URL**: `POST /internal/logout-url` with a valid internal Bearer JWT, body `{provider: keycloak-ish, id_token: <jwt>, redirect_uri: "https://reg.example.com/logout"}`, `OAUTH2_CONFIG["providers"]` patched with a Keycloak-style entry (`logout_url` containing `/realms/`). Expect 200; `logout_url` starts with the configured `logout_url`, contains `client_id=`, `post_logout_redirect_uri=` (urlencoded), and `id_token_hint=<the jwt>`; `id_token_hint_included` is `true`.
- **1.1.2 Entra ID URL**: provider with `logout_hostname == "login.microsoftonline.com"`. Expect `post_logout_redirect_uri` + `id_token_hint`; no `client_id` param.
- **1.1.3 Okta URL**: provider name containing `okta`. Expect `post_logout_redirect_uri` + `id_token_hint`.
- **1.1.4 Cognito-shaped URL**: any other provider. Expect `client_id` + `logout_uri` params and **no** `id_token_hint`; `id_token_hint_included` is `false`.
- **1.1.5 Unknown provider**: expect 404 with detail `Provider nope not found` (same wording as the legacy endpoint).
- **1.1.6 No logout_url configured**: expect 200 with the absolutized `redirect_uri` echoed as `logout_url` and `id_token_hint_included=false` (success, not an error).
- **1.1.7 Unauthenticated**: no `Authorization` header -> 401. Wrong/garbage/expired/replayed token -> 401 (existing `validate_internal_auth` semantics; one representative test is enough since the router-level gate is shared).
- **1.1.8 Legacy/internal parity**: for each of the four provider families, the URL built by the legacy `GET /oauth2/logout/{provider}?...&id_token_hint=...` handler (asserted from its 302 `Location` header via `TestClient(allow_redirects=False)`) equals the `logout_url` returned by the internal endpoint for the same inputs. This is the drift guard.
- **1.1.9 Unsafe redirect_uri dropped**: absolute `redirect_uri` outside the cookie domain -> the returned `logout_url` must not contain that URI (falls back to the `/login`-derived default), mirroring the legacy guard.

### 1.2 Registry: logout handler behavior (unit)

New file `tests/unit/auth/test_logout_internal_hint.py` (patterns from `tests/unit/auth/test_build_external_url.py`: `patch.object` on `registry.auth.routes`, `AsyncMock`):

- **1.2.1 Internal success path**: session cookie resolves to an OAuth2 session with `id_token`; `settings.logout_hint_via_internal` true; `_fetch_logout_url_via_internal` mocked to return `(IDP_URL, True)`. Expect: 303 whose `Location` is exactly `IDP_URL` (not an auth-server URL, no `id_token_hint` query param on any registry/auth-server hop), `Set-Cookie` deleting `mcp_gateway_session`, and the internal-success counter incremented.
- **1.2.2 Fallback on 404 (old auth server)**: internal fetch mocked to return `None`; id_token present and JWT-shaped. Expect 303 `Location` == the legacy URL `{auth_external}/oauth2/logout/{provider}?redirect_uri=...&id_token_hint=<urlencoded jwt>`, fallback counter incremented, `logout_id_token_hint_present` counter incremented (legacy semantics preserved).
- **1.2.3 Fallback on exception/timeout**: `_fetch_logout_url_via_internal` raises (simulate `httpx.ConnectError` inside) -> same legacy redirect as 1.2.2.
- **1.2.4 Fallback on malformed 200**: `_fetch_logout_url_via_internal` gets a 200 whose body is not the expected schema -> same legacy redirect (broad `except` covers `response.json()` failures).
- **1.2.5 Flag off**: `settings.logout_hint_via_internal` false; assert the internal fetch is never called (patch it with a spy) and the legacy redirect is produced.
- **1.2.6 No id_token in session**: internal fetch never called; legacy redirect without `id_token_hint`; `logout_id_token_hint_missing` incremented (unchanged legacy semantics).
- **1.2.7 Non-JWT-shaped id_token on legacy path**: `logout_jwt_validation_failed` incremented; redirect has no hint (unchanged legacy semantics).
- **1.2.8 Session invalidation invariant**: in every path above (internal success, fallback, flag off, no token), the server-side session delete fires before the redirect and the `Set-Cookie` deletion header is present.
- **1.2.9 No token material in logs**: with `caplog` at DEBUG, assert the raw id_token string never appears in any record on either the success or fallback path.

### 1.3 CLI / curl tests

**Not Applicable** - the change adds no CLI command; the HTTP surfaces are covered by 1.1/1.2 and the browser-facing behavior by Section 3/5.

## 2. Backwards Compatibility Tests

- **2.1 Legacy endpoint unchanged**: `GET /oauth2/logout/{provider}?redirect_uri=...&id_token_hint=...` on the patched code returns the same 302 + Location as tag `1.27.1` for all four provider families (covered by parity test 1.1.8 and by 1.1.5's 404 wording check).
- **2.2 Old-registry/new-auth-server**: an old registry keeps calling the browser-facing endpoint; covered by 2.1 (endpoint contract untouched).
- **2.3 New-registry/old-auth-server**: internal endpoint absent -> auth server returns 404 -> registry falls back (covered by 1.2.2).
- **2.4 Flag-off deployment**: `LOGOUT_HINT_VIA_INTERNAL=false` produces pre-change behavior for every input (covered by 1.2.5).
- **2.5 Existing logout counters**: `logout_id_token_hint_present/missing`, `logout_jwt_validation_failed`, `logout_url_length_warning` still registered and still incremented only on the legacy path (`tests/unit/observability/test_meters.py` name checks still pass; behavior covered in 1.2.2/1.2.6/1.2.7).

## 3. UX Tests

**Not Applicable** - no UI surface changes. The React frontend calls `GET /api/auth/logout` (frontend/src/contexts/AuthContext.tsx:140), whose response contract (303 redirect) is unchanged; logout button behavior is covered end-to-end by Section 5. One manual check is worth keeping:

- **3.1 (manual)** Click logout in the UI with the internal path enabled: browser navigates to the IdP logout page in one hop (no intermediate auth-server URL flash), lands back on `/login?...` or the registry home per IdP post-logout config.

## 4. Deployment Surface Tests

### 4.1 Docker wiring

- **4.1.1** Confirm no compose file needs the new variable to boot with defaults: `docker compose config` succeeds without `LOGOUT_HINT_VIA_INTERNAL` set (the field has a code-level default; nothing to assert beyond pydantic loading - covered by all unit tests importing `Settings`).

### 4.2 Terraform / ECS wiring

**Not Applicable** - no new required infra inputs; the optional env var follows the standard Settings->container-env pattern already used for e.g. `INTERNAL_TOKEN_TTL_SECONDS`.

### 4.3 Helm / EKS wiring

**Not Applicable** - same rationale as 4.2; charts pass through arbitrary env already.

### 4.4 Deploy and verify (manual, staged)

- **4.4.1** Deploy new auth server only; legacy registry continues logging out (2.1).
- **4.4.2** Deploy new registry; observe `mcpgw_registry_logout_internal_hint_success_total` incrementing and `..._fallback_total` flat.
- **4.4.3** Set `LOGOUT_HINT_VIA_INTERNAL=false`; verify the registry stops calling the internal endpoint (success counter flat; legacy counters resume) without a restart race.

### 4.5 Rollback verification

- **4.5.1** Rolling back the registry alone: old registry + new auth server = unchanged legacy behavior (2.1).
- **4.5.2** Rolling back the auth server alone: new registry + old auth server = 404 -> fallback, logout still works (1.2.2).
- **4.5.3** `LOGOUT_HINT_VIA_INTERNAL=false` as an in-place pin without code rollback.

## 5. End-to-End API Tests

Full-flow tests (run in `tests/integration/` with the Mongo store mocked/faked; no live IdP):

- **5.1 Happy path**: login-created session (via the store fixtures) -> `GET /api/auth/logout` -> assert single 303 to an IdP-shaped URL (host matches the configured `logout_url`, not the auth server), `id_token_hint` present **in the IdP URL only**, session record deleted, cookie cleared.
- **5.2 WAF simulation**: front the legacy path with a proxy that rejects query strings > 2048 bytes; verify the legacy redirect fails (reproduces the incident) while the new path's registry response is unaffected (its browser-facing Location is built server-side; the auth-server hop no longer exists).
- **5.3 Mixed-version soak**: run 5.1 against an auth server stripped of the new route; every logout must still complete via fallback with `..._fallback_total` incrementing.

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/auth/` and `tests/auth_server/unit/`
- [ ] `pytest tests/unit/auth/test_logout_internal_hint.py tests/auth_server/unit/test_server.py tests/unit/observability/test_meters.py` passes with no regressions
