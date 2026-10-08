# Implementation Summary: Consistent, Bearer-Compatible CSRF Protection Across Toggle Endpoints

*Created: 2026-09-29*
*Baseline ref: `v1.0.20` (commit `2099caa8a3184765fa83975008d7fc8329d15dad`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md` (as revised by `./review.md` Step 7.5)*

## What Changed

The shared CSRF dependency `verify_csrf_token_flexible` is now session-cookie-conditional: requests carrying the `mcp_gateway_session` cookie must still present a valid CSRF token bound to it (unchanged browser protection), while requests without the cookie - bearer-token M2M clients and internal JWT callers - skip the check entirely, because a bearer credential is never attached ambiently by browsers and therefore cannot be forged cross-site. The dependency was applied to the two toggle endpoints that previously had no CSRF dependency at all (`POST /api/servers/toggle`, `POST /api/virtual-servers/{path}/toggle`), making coverage uniform across all six toggle routes (the internal `/api/internal/toggle` keeps its non-web `validate_internal_auth` credential by design). The repo's own federation docker script and the API docs were updated to match.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/auth/csrf.py` | modified | +18 / -10 | `verify_csrf_token_flexible` now returns early when no session cookie is present (bearer path) and only enforces token validation for cookie-bearing requests; documents the ambient-credential rationale and references issue #891 |
| `registry/api/virtual_server_routes.py` | modified | +2 / -0 | Adds the missing `_csrf` dependency to `toggle_virtual_server` (import + parameter, declared after `user_context`) |
| `registry/api/server_routes.py` | modified | +1 / -0 | Adds the missing `_csrf` dependency to `toggle_service_api` (`POST /api/servers/toggle`), after `user_context` |
| `scripts/test-peer-federation-docker.sh` | modified | +5 / -0 | Fetches a CSRF token with the session cookie jar and sends `X-CSRF-Token` on both `/api/servers/toggle` calls, keeping the repo's e2e script green |
| `docs/api-reference.md` | modified | +4 / -0 | CSRF paragraph on the Toggle Service (UI) and Toggle Server sections |
| `tests/unit/auth/test_csrf_dependency.py` | added | +112 / -0 | 8 dependency-level tests: cookie w/o token 403; cookie+header token 200; cookie+form token 200; invalid token 403; token for another session 403; header preferred over form; no-cookie skip with and without token |
| `tests/unit/api/test_toggle_csrf_consistency.py` | added | +230 / -0 | 12 route-level tests over agent/skill/virtual-server toggles through the real dependency: bearer path allowed (the reported bug), cookie-without-token rejected per endpoint, cookie+token 200, invalid token 403, form-encoded forgery shape 403 |

Totals: 5 files modified (+30 / -10), 2 test files added (+342 / -0); 7 files, +372 / -10 overall.

## How to Apply

```bash
git clone --branch v1.0.20 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` was verified against a fresh checkout of the baseline commit `2099caa`.

## Deviations from the LLD

1. **No new dependency function; the existing one was revised in place.** The LLD (draft) proposed adding `require_csrf_if_session_cookie` next to `verify_csrf_token_flexible` and re-pointing routes to it. During implementation this turned out to be strictly worse than revising `verify_csrf_token_flexible` itself: the function already sits on exactly the routes that needed the new semantics (plus logout and the edit form, which are always cookie-borne and behave identically under both semantics), and dozens of existing tests neutralize CSRF via `app.dependency_overrides[verify_csrf_token_flexible]` and would have needed no change either way - but a second function would have left two competing "canonical" CSRF dependencies, the exact inconsistency Sage's review flagged. In-place revision yields a smaller diff, uniform semantics on every call site, and zero churn in existing tests. The LLD's invariants (cookie presence as sole trigger; `_csrf` after `user_context`; one canonical dependency) are all satisfied by the implemented form.
2. **Route coverage via shared semantics instead of per-route edits.** Because the dependency was revised in place, the three routes that already carried it (agent, skill, UI toggle) gained the bearer-compatible behavior without individual edits; only the two unprotected routes needed new parameters. Net effect equals the LLD's endpoint table exactly.
3. **Docs scope narrowed to the two documented toggle sections.** The LLD mentioned a possible note in agent/skill/virtual-server docs; `docs/api-reference.md` documents only the UI toggle and `servers/toggle` endpoints, so the paragraph was added exactly there (agent/skill/virtual-server API reference lives in `docs/` elsewhere or not at all; no invented sections).

## Not Implemented / Follow-ups

- `SameSite`/`Secure` cookie attributes on `mcp_gateway_session` - defense-in-depth hardening, deliberately out of scope (LLD Open Questions).
- Extending the conditional CSRF dependency to the remaining mutating endpoints (register/edit/delete/rating/ANS link/unlink) - ANS routes call `verify_csrf_token_flexible` inline and therefore silently gain the same bearer compatibility; a deliberate sweep of those endpoints is a follow-up.
- Consolidating the overlapping `/api/toggle/{path}` and `/api/servers/toggle` surfaces - separate refactor, auth models differ.

## Verification (not executed)

Per the skill's constraints, no tests, linters, or builds were run against the target repo. The executable verification plan lives in `./testing.md` (dependency unit tests, per-endpoint route tests, curl recipes for browser/bearer/negative paths, federation-script check, rollout/rollback verification). The patch applies cleanly onto `v1.0.20`.
