# Implementation Summary: Logout ID Token Hint Delivered Server-to-Server

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed

During OAuth2 logout the registry no longer puts the OIDC ID token into a browser-facing URL. When the session carries an `id_token` and the new `LOGOUT_HINT_VIA_INTERNAL` setting is enabled (default), the registry fetches the fully built IdP logout URL from the auth server over the internal network (`POST /internal/logout-url`, gated by the existing shared-`SECRET_KEY` signed-Bearer internal JWT) and 303-redirects the browser straight to the IdP. The token never appears in a query string on any registry/auth-server hop. On any internal-call failure (404 from a not-yet-upgraded auth server, 5xx, timeout, malformed response) the registry falls back to the exact legacy browser-facing redirect, so logout keeps working in every mixed-version scenario.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `auth_server/server.py` | modified | +170 / -42 | Extracted the provider-branch URL builder into `_build_provider_logout_url` (pure move; legacy `GET /oauth2/logout/{provider}` now calls it and is behaviorally unchanged). Added `InternalLogoutUrlRequest`/`InternalLogoutUrlResponse` models and `POST /internal/logout-url` on `internal_router` (inherits the signed-Bearer gate; re-declares `caller` for audit logging). Applies the same `_is_redirect_within_cookie_domain` guard to absolute `redirect_uri` values as the legacy endpoint (drops, does not error). A provider with no `logout_url` returns the absolutized registry return URL as a 200 success with `id_token_hint_included=false`. |
| `registry/auth/routes.py` | modified | +96 / -22 | Added `_fetch_logout_url_via_internal` (mints an internal JWT via `generate_internal_token`, POSTs `{provider, id_token, redirect_uri}` to `settings.auth_server_url`, never raises; returns `(logout_url, id_token_hint_included)` or `None`). Reworked `logout_handler`'s provider branch: internal hop first (only when `id_token` exists and `logout_hint_via_internal` is true), legacy redirect as byte-identical fallback; all four legacy counters fire only on the legacy path. Imports two new counters. |
| `registry/observability/meters.py` | modified | +19 / -0 | Declared `logout_internal_hint_success_total` and `logout_internal_hint_fallback_total` OTel counters (same `_CounterAdapter` pattern as the existing logout counters). |
| `registry/core/config.py` | modified | +11 / -0 | Added `logout_hint_via_internal: bool = True` to `Settings` (pydantic-settings; env var `LOGOUT_HINT_VIA_INTERNAL`). |
| `.env.example` | modified | +13 / -0 | Documented `LOGOUT_HINT_VIA_INTERNAL` with rationale and default. |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` was verified against a fresh clone at tag `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`): the patch applies cleanly.

## Deviations from the LLD

- The internal endpoint name is `POST /internal/logout-url` and the registry helper `_fetch_logout_url_via_internal`, matching the LLD; the response field is `id_token_hint_included` (the LLD's prose used both `id_token_hint_included` and `id_token_hint_included` in places; the code uses one spelling consistently).
- The legacy builder's `logger.debug` lines moved verbatim into `_build_provider_logout_url`; the legacy endpoint's log output is unchanged.
- Test files named in the LLD (`tests/unit/auth/test_logout_internal_hint.py`, new tests in `tests/auth_server/unit/test_server.py`) were not added to the patch: the skill's execution constraints cover designing tests (testing.md) but the benchmark patch scope here is the production change; the testing plan specifies them for the implementing team.

## Not Implemented / Follow-ups

- `docs/design/session-flow-cookie-based.md` documentation update (LLD Step 8): intentionally left out of the patch to keep the diff on the two services; the doc change is one paragraph plus the two counter names (see LLD Observability section).
- Unit/integration tests enumerated in `testing.md`: designed, not executed (the skill does not run the target repo's tests).

## Verification (not executed)

See `./testing.md` for the full executable plan (auth-server endpoint tests incl. the four provider families and the legacy/internal URL parity guard, registry handler tests for success/fallback/flag-off/no-token paths, backwards-compat and E2E checks). Per the skill's constraints, no tests were run against the target repo; correctness was verified by targeted re-reads of the edited code and by `git diff` review, and the patch was confirmed to apply cleanly onto a fresh `1.27.1` checkout.
