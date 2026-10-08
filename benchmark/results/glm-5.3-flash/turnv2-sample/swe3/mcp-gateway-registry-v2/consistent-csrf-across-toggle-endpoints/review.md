# Expert Review: Consistent, Bearer-Compatible CSRF Protection Across Toggle Endpoints

*Created: 2026-09-29*
*Design under review: `./lld.md` (draft)*
*Issue: https://github.com/agentic-community/mcp-gateway-registry/issues/891*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | UI/UX, components, state, API integration |
| Backend Engineer | Byte | API design, data models, business logic, performance |
| SRE/DevOps Engineer | Circuit | Deployment, monitoring, scaling, infrastructure |
| Security Engineer | Cipher | AuthN/AuthZ, validation, OWASP, data protection |
| SMTS (Overall) | Sage | Architecture, code quality, maintainability |

---

## Pixel (Frontend Engineer)

**Strengths**
- Zero frontend changes required. Verified `frontend/src/contexts/AuthContext.tsx:76-88`: the axios request interceptor attaches `X-CSRF-Token` to every `post/put/delete/patch` once the token is fetched from `/api/auth/csrf-token` (:108-110). All four SPA toggle call sites (`Dashboard.tsx:1248,1306,1348`, `useVirtualServers.ts:107`) go through that interceptor, including the FormData one.
- The 403 detail strings are unchanged, so existing SPA error toasts and retry logic keep matching.

**Concerns**
1. **(should-fix) Token-fetch failure mode widens.** If the initial `/api/auth/csrf-token` fetch fails (interceptor catches and logs at `AuthContext.tsx:112-113`), today the SPA can still toggle servers and virtual servers (no CSRF dep on those). After this change those toggles fail with 403. That is the correct fail-closed behavior and it matches what agent/skill toggles already do, but it is a real behavior change for a degraded-login edge case.
2. (minor) `Dashboard.tsx:1250` hardcodes `'Content-Type': 'application/x-www-form-urlencoded'` for a `FormData` body; unaffected by this design, just noting the call site is odd.

**New libraries / infra dependencies:** none.

**Better alternatives considered:** none at this layer - the SPA side is already correct.

**Recommendations:** Ship as is; add the degraded-token-fetch case to the rollout notes so support knows a 403 toggle right after login means the CSRF token fetch failed (refresh fixes it).

**Questions for author:** None.

**Verdict: APPROVED WITH CHANGES** (behavioral note must land in the rollout/communication section of the LLD).

---

## Byte (Backend Engineer)

**Strengths**
- The dependency is a pure function of the request: one cookie lookup, at most one token extraction. No new state, no new models, response shapes untouched.
- Reusing `validate_csrf_token` keeps a single source of truth for token semantics; reusing the existing extraction order (header, then form) matches `verify_csrf_token_flexible` so both code paths behave identically for shared clients.
- Keeping `verify_csrf_token_flexible` (still used by logout at `registry/auth/routes.py:301`) instead of deleting it is the right call - it avoids touching an unrelated flow and keeps the unit-test `dependency_overrides` working.

**Concerns**
1. **(must-address) Dependency resolution order.** FastAPI resolves sub-dependencies in parameter order. The new `_csrf` parameter must be declared AFTER `user_context` in every handler signature so an unauthenticated request gets the 401 from auth, not a 403 from CSRF. The LLD says this in passing; it must be an explicit, checkable rule per route.
2. (minor) Starlette caches `request.form()`, so the later `Form()` parameters still work - correct in the LLD, but worth an assertion in the route-level tests (post a form toggle WITH a valid cookie+token and assert the handler still received `enabled`).
3. (minor) `toggle_service_route` (`/api/toggle/{path}`) reads `enabled: Annotated[str | None, Form()]`; with the CSRF check reading the form first, confirm no interaction. Form cache makes this safe.

**New libraries / infra dependencies:** none.

**Better alternatives considered:** deriving "browser vs bearer" from `user_context["auth_method"]` instead of the cookie. Rejected: `nginx_proxied_auth` falls back to cookie auth with no `X-Auth-Method` header, so that signal is unreliable - the LLD already documents this; agreeing with the cookie-presence trigger.

**Recommendations:** Codify the parameter-order rule in the LLD implementation steps; add the form-field round-trip test.

**Questions for author:** None - ordering addressed below.

**Verdict: APPROVED WITH CHANGES** (make the ordering rule explicit per route).

---

## Circuit (SRE/DevOps Engineer)

**Strengths**
- No new env vars, no infra surface changes, no migration. Rollback is "revert the patch" - genuinely true because nothing else changes.
- Failure modes are 401/403 only, no new 5xx paths. Log events are greppable and stable (`CSRF validation failed: ...`).

**Concerns**
1. **(critical, must-fix) The repo's own automation breaks.** `scripts/test-peer-federation-docker.sh:208-211` POSTs `/api/servers/toggle` with `-b "$COOKIE_A"` (session cookie) and NO CSRF token. Under the new rule these calls 403, so the federation e2e script fails after this change. The design must update that script: fetch a token via `GET /api/auth/csrf-token` with the same cookie jar and send it as `X-CSRF-Token`. (`scripts/test-peer-federation.sh:178-186` is fine - it authenticates with `X-Username` headers and no cookie, so the check is skipped.)
2. (should-fix) Communication: any customer running cookie-authenticated automation against `/api/servers/toggle` or `/api/virtual-servers/*/toggle` breaks the same way. The rollout section needs an explicit "who must change what" list (bearer clients: nothing; cookie clients: send the token).
3. (minor) Health of the feature in prod: suggest watching the rate of `CSRF validation failed: no token provided` warnings post-deploy as the canary signal for broken cookie clients.

**New libraries / infra dependencies:** none.

**Better alternatives considered:** feature flag to phase the newly-protected endpoints. Rejected for this size of change - two flags' worth of complexity for a behavior the SPA already complies with.

**Recommendations:** Fix the script in this patch (it is part of "consistent"), add the rollout communication list.

**Questions for author:** Confirm no other cookie+toggle call sites exist. (Checked: grep for `servers/toggle` and `-b "` across `scripts/` finds only the two call sites above.)

**Verdict: NEEDS REVISION** until the script update is added to the design.

---

## Cipher (Security Engineer)

**Strengths**
- The core security reasoning is sound and conservative: CSRF is a threat against *ambient* credentials. The session cookie is ambient; a bearer token is not (browsers never attach `Authorization` headers cross-site, and custom headers like `X-CSRF-Token` are not CORS-safelisted so cross-site forgeries cannot set them without a preflight the attacker cannot pass). Exempting cookie-less, bearer-authenticated requests therefore does not widen the browser attack surface.
- Coverage improves: `/api/servers/toggle` and `/api/virtual-servers/*/toggle` gain protection they lacked. The inconsistency being fixed is itself a vulnerability (the unprotected virtual-server toggle is admin-gated and state-changing).
- Triggering on cookie presence rather than on `X-Auth-Method` is the safer of the two signals: a request that authenticates via cookie always HAS the cookie, including direct-to-app access that bypasses nginx (where the header would be absent and spoofable).

**Concerns**
1. **(must-document, address in LLD)** The design must state explicitly that `X-Auth-Method` is treated as advisory only and the cookie is the sole trigger - otherwise a future maintainer may "optimize" by trusting the header and reintroduce the direct-access hole. The LLD draft has this in Constraints; elevate it to the implementation section as an invariant.
2. (should-fix) Form-field fallback consideration: a cross-site `text/plain` form POST can deliver JSON-shaped bodies without a preflight, so the virtual-server/skill toggles (JSON endpoints) are forgeable *in shape*. The design handles this correctly (cookie present -> token required, and the attacker cannot know the token), but add a test proving a form-encoded POST with a garbage `csrf_token` field is rejected - that is the actual attack shape.
3. (note) Token-present-but-no-cookie now returns success-skip instead of the legacy `no session` 403 on protected routes. This is correct (bearer clients may send junk headers) and leaks nothing; just confirm the legacy `no session` message remains only on the logout route, so log-based alerting is not surprised.
4. (note, out of scope) No `SameSite` attribute is set on `mcp_gateway_session` anywhere in `registry/`. This change does not depend on it (good - a design must not), but it belongs on the hardening backlog with `Secure` too.

**New libraries / infra dependencies:** none.

**Better alternatives considered:** `SameSite=Strict` as the primary fix - rejected as primary (Lax fallback on older clients, and it does nothing for the already-issued cookie population), correct as defense-in-depth later.

**Recommendations:** Elevate the trigger invariant; add the garbage-form-field negative test; keep SameSite as a filed follow-up.

**Questions for author:** None.

**Verdict: APPROVED WITH CHANGES** (documentation invariant + negative test).

---

## Sage (SMTS, Overall)

**Strengths**
- Correct problem decomposition: one defect (inconsistent coverage) plus one defect (credential-incompatible enforcement), solved with one shared dependency rather than two hacks.
- The chosen design is the minimal one that satisfies both the M2M requirement and the non-weakening constraint, and it is the design a security reviewer can verify in five lines: "cookie present -> enforce; absent -> the credential cannot be CSRF'd."
- API discovery for future contributors improves: a single canonical CSRF dependency to reach for.

**Concerns**
1. (should-fix) **Naming and duplication discipline.** Two CSRF dependencies now coexist (`verify_csrf_token_flexible` on logout/edit, the new one on toggles). That is acceptable transitionally, but the LLD must state which one new endpoints should use, and the new dependency's docstring should say it supersedes the flexible one for dual-credential endpoints. Otherwise the codebase accumulates a third inconsistency.
2. (should-fix) The patch must update the federation script per Circuit, or the repo fails its own e2e - "the patch leaves the repo self-consistent" is the acceptance bar.
3. (minor) Tests: the behavioral tests should live in a dedicated file (e.g. `tests/unit/api/test_toggle_csrf_consistency.py`) rather than being sprinkled into the existing route test files whose fixtures deliberately disable CSRF; mixing them in would be confusing.
4. (minor) Line-number anchors in the LLD will drift; file+symbol anchors are what the implementer should trust.

**New libraries / infra dependencies:** none.

**Better alternatives considered:** consolidating `/api/toggle/{path}` and `/api/servers/toggle` into one endpoint family first - tempting, but it balloons the diff and the auth models differ (cookie-only vs dual); keep this patch single-purpose.

**Recommendations:** State the canonical-dependency rule; keep behavioral tests in their own file; include the script fix.

**Questions for author:** None beyond the above.

**Verdict: APPROVED WITH CHANGES**

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Document the degraded csrf-fetch 403 behavior in rollout notes |
| Backend (Byte) | APPROVED WITH CHANGES | 0 | Make `_csrf`-after-`user_context` ordering an explicit per-route rule; test form round-trip |
| SRE (Circuit) | NEEDS REVISION | 1 | Update `scripts/test-peer-federation-docker.sh` to fetch + send the CSRF token; add rollout communication list |
| Security (Cipher) | APPROVED WITH CHANGES | 0 | Elevate cookie-presence invariant; add garbage-form-field negative test; SameSite follow-up |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | State the canonical CSRF dependency for new endpoints; keep behavioral tests in a dedicated file; script fix in-patch |

**Blocking findings to resolve before implementation:**
1. (Circuit, critical) Federation docker script uses cookie auth against `/api/servers/toggle` without a CSRF token and would break. **Resolution: the LLD now includes updating `scripts/test-peer-federation-docker.sh` (fetch `GET /api/auth/csrf-token` with the session cookie jar, send `X-CSRF-Token` on both toggle calls) and `testing.md` covers it; the patch carries the script fix so the repo stays self-consistent.**
2. (Cipher) Cookie-presence trigger must be the stated invariant, `X-Auth-Method` advisory only. **Resolution: LLD Implementation Details now leads with this invariant; the dependency docstring states it.**
3. (Byte) `_csrf` parameter must follow `user_context` in every signature so 401 precedes 403. **Resolution: codified per route in the LLD step-by-step plan.**
4. (Sage) Canonical-dependency rule for future endpoints. **Resolution: the LLD states the (cookie-conditional) `verify_csrf_token_flexible` is the canonical CSRF dependency for dual-credential endpoints going forward; the design was refined during implementation to revise that function in place rather than add a differently-named second dependency, so the codebase keeps exactly one canonical CSRF dependency.**
5. (Cipher/Sage) Negative test for form-encoded CSRF forgery shape; behavioral tests in a dedicated file. **Resolution: both reflected in `testing.md` and the LLD file-changes table.**
6. (Pixel) Degraded csrf-fetch now 403s on newly protected endpoints. **Resolution: accepted as correct fail-closed behavior; documented in Rollout Plan as a communication item, no frontend change.**

No blocking findings remain; the LLD has been revised accordingly and implementation may proceed.

## Next Steps

1. Implement per the revised LLD (Step 8.5 of the run): shared dependency, four route files, docs, script fix, two new test files.
2. Execute `testing.md` in a environment with the repo's normal toolchain (not part of this benchmark run).
3. File follow-ups: `SameSite`/`Secure` cookie attributes; extend the shared dependency to register/edit/delete/rating/ANS mutating endpoints.
