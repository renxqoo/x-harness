# Expert Review: Consistent CSRF Across Toggle Endpoints

*Created: 2026-09-30*
*Reviewed artifacts: `github-issue.md`, `lld.md` (draft)*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | SPA flows, axios interceptor, UX of toggles, error surfaces |
| Backend Engineer | Byte | API design, auth/CSRF composition, correctness, performance |
| SRE/DevOps Engineer | Circuit | Deployment, observability, scaling, rollback |
| Security Engineer | Cipher | CSRF threat model, bypasses, auth confusion, header trust |
| SMTS (Overall) | Sage | Architecture, maintainability, consistency guarantees |

---

## Frontend Engineer (Pixel)

**Strengths**
- Zero SPA changes required: the axios interceptor in `AuthContext.tsx` already attaches `X-CSRF-Token` to every mutating request, and the SPA always sends the session cookie, so every browser toggle call keeps satisfying the enforced path.
- Error messages and status codes (403 with the same `CSRF validation failed` details) are unchanged, so existing toast/error handling in `AgentCard`, `SkillCard`, `ServerCard`, and `VirtualServerList` keeps working verbatim.

**Concerns**
1. (Minor) If a user's session cookie expires mid-tab, the interceptor fetches a fresh CSRF token from `/api/auth/csrf-token` - but that endpoint requires a valid session, so the fetch fails and the toggle will now surface the CSRF 403 (previously on some routes it succeeded without any CSRF check, e.g. virtual servers). This is correct behavior (the auth layer should reject expired sessions anyway) but the user-visible path changes slightly on two previously-unprotected routes. Recommendation: no code change; verify the 403 toast copy in the SPA reads sensibly for this case.

**New libraries / infra dependencies required**
- None.

**Better alternatives considered**
- None from the frontend perspective; the wire contract for the SPA is intentionally unchanged.

**Recommendations**
- Add the browser-path integration cases (cookie + missing/invalid/valid token) to the test plan on every toggle route, not just agent/skill (they are in the LLD's Step 6 and testing.md Section 1.1 - confirmed).

**Questions for author**
- None.

**Verdict:** APPROVED

---

## Backend Engineer (Byte)

**Strengths**
- The core insight is correct and matches FastAPI/OWASP practice: CSRF mitigates ambient-credential (cookie) forgery; requests carrying only explicit credentials (Authorization header) are not CSRF-forgeable. Keying enforcement on cookie presence is the standard pattern (e.g. Django's session-based CSRF exemption discussions, SameSite=Strict semantics).
- Implementation shape is minimal and idiomatic: one dependency in `registry/auth/csrf.py` with the same signature/raise behavior as the existing ones, so `app.dependency_overrides` keeps working in all existing test fixtures.
- Reusing `verify_csrf_token_flexible` for the cookie path avoids a second copy of token parsing; error messages stay identical.

**Concerns**
1. (Must-fix) The draft LLD said the new dependency "checks the cookie, then delegates to strict validation" - as literally described it re-reads the cookie twice, which is fine, but if someone later reorders the steps (validate first, gate second) the "no token provided" branch would fire before the skip branch and re-break M2M. The code must gate FIRST and return before any token validation. The LLD's Step 1 code does this correctly; the design doc should state the ordering invariant explicitly so an implementer cannot invert it.
2. (Should-fix) `POST /api/servers/toggle` and `POST /api/virtual-servers/{path}/toggle` currently have NO CSRF check; adding the new dependency there means browser requests that previously succeeded without a token will now get 403. This is the intended hardening, but it is a behavior change for any cookie-based script hitting those endpoints. Call it out in testing.md as an explicit backwards-compat note (it is - Section 2 - confirmed).
3. (Minor) `internal_toggle_service` gains the dependency as defense in depth. Harmless (internal JWT callers send no cookie), but worth one line in the LLD explaining why it is included - present, confirmed.

**New libraries / infra dependencies required**
- None (existing `itsdangerous` signer and FastAPI only).

**Better alternatives considered**
- Origin/Referer validation as an additional layer: worthwhile future hardening, but a larger change touching all routes; does not replace the token check.
- Separate dependency per auth method: rejected - more symbols, same behavior, drifts back to inconsistency.

**Recommendations**
- State the ordering invariant (cookie gate before token validation, early return) as a MUST in the LLD. [Resolution: LLD Implementation Details Step 1 now states the ordering invariant explicitly with a behavior-notes bullet.]
- Keep the dependency's skip-path log at INFO so bearer traffic is auditable. [Resolution: kept, and specified in LLD Logging section.]

**Questions for author**
- Should `GET /api/auth/csrf-token` eventually mint tokens for non-session principals? (Out of scope; asking to confirm deferral.)

**Verdict:** APPROVED WITH CHANGES (both changes are doc-level and applied to the LLD before implementation)

---

## SRE/DevOps Engineer (Circuit)

**Strengths**
- Zero configuration surface change: no new env vars, no nginx/Terraform/Helm edits, no image bump. Deploy is just the next normal release; rollback is the previous image.
- Skip path is one dict lookup - no measurable latency or scaling impact; cookie path is identical crypto to today.

**Concerns**
1. (Minor) After deploy, bearer toggle traffic will log a new INFO line (`CSRF check skipped: no session cookie...`). At high M2M volume this adds log noise. Recommendation: keep INFO (auditability wins) and rely on the existing log level configuration to silence it if needed.
2. (Minor) The 403s on `/servers/toggle` and virtual-server toggle for cookie-bearing-but-tokenless callers are new. If any internal cookie-authenticated script exists, it will start failing. SRE mitigation: testing.md Section 2 includes the compat test; operators should grep access logs for cookie-bearing POSTs to those routes before upgrading. Not blocking - the registry's own SPA always sends the token.

**New libraries / infra dependencies required**
- None.

**Better alternatives considered**
- Feature flag to toggle enforcement on the two newly-protected routes. Rejected: doubles test matrix for a one-release risk; the failure mode is a 403 that the SPA never hits.

**Recommendations**
- None beyond the log-noise note.

**Questions for author**
- None.

**Verdict:** APPROVED

---

## Security Engineer (Cipher)

**Strengths**
- Threat model reasoning is sound and explicitly documented: an attacker cross-site cannot set Authorization headers (fetch/XHR with credentials mode restrictions; forms cannot carry arbitrary headers), so the only forgeable credential is the cookie. Gate on the cookie; enforce the signed session-bound token there. This is the correct CSRF doctrine.
- The design *closes* two real holes (`/servers/toggle`, virtual-server toggle had no CSRF for cookie sessions) while fixing the M2M breakage; net security posture improves.
- Strict `verify_csrf_token_flexible` remains for session-only form endpoints (logout, edit form) - no regression there.

**Concerns**
1. (Must-fix) Skip-path trust boundary: when the cookie is absent, the dependency returns without any identity check. Security of that path rests entirely on the route's auth dependency rejecting anonymous callers. All six routes have auth dependencies (`nginx_proxied_auth` x4, `enhanced_auth` x1, `validate_internal_auth` x1), so this holds today - but the LLD must record it as an invariant: the CSRF skip NEVER substitutes for authentication, and any future toggle route added without an auth dependency would be anonymous-writable. Add that invariant to the LLD. [Resolution: added as a behavior note and to Constraints in the LLD.]
2. (Should-fix) Hybrid requests carrying BOTH cookie and bearer header: the design enforces CSRF (cookie wins). Correct choice - stricter. Document it so it does not get "optimized" later. [Resolution: documented in LLD behavior notes.]
3. (Minor) `X-User` header spoofing: `nginx_proxied_auth` trusts nginx-set headers, but nginx sets them from `auth_request` subrequest results, and direct-to-app access is on 127.0.0.1. Pre-existing architecture, unchanged by this design; noted, not a finding against this change.
4. (Minor) No SameSite discussion: if the session cookie is `SameSite=Lax` (FastAPI default when set by the auth server), cross-site POSTs from forms would not carry it at all, making the token check a second layer. Either way the design holds. No change required.

**New libraries / infra dependencies required**
- None.

**Better alternatives considered**
- Binding CSRF tokens to bearer credentials: unnecessary; bearer requests are not forgeable, so there is nothing to bind.
- Encrypting CSRF tokens: they are signed (integrity) not secret-bearing (they encode the session id only under the signature); no need.

**Recommendations**
- Record the two invariants (authentication-is-never-skipped; cookie-wins-for-hybrid) in the LLD. [Resolution: both added.]

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (invariant documentation, applied)

---

## SMTS (Overall) (Sage)

**Strengths**
- The design converts an ad-hoc per-route decision into a single named, documented policy (`verify_csrf_token_if_session_cookie`). That is the difference between "fixed the four endpoints we noticed" and "the class of bugs is now prevented" - future toggle-style routes import one symbol and cannot reintroduce the inconsistency silently.
- Correct, minimal abstraction level: no new config, no new framework, no per-route branching; composition with the existing auth dependencies is left intact.
- The alternatives table honestly compares remove-all / M2M-cookie-gymnastics / origin-check options and rejects each for concrete reasons.

**Concerns**
1. (Should-fix) The module docstring of `csrf.py` says tokens are "bound to user sessions" - the new dependency relaxes that for non-session requests. Add one sentence to the module or function docstring clarifying the policy ("CSRF applies to cookie-authenticated requests; bearer-authenticated requests are exempt because they are not forgeable") so the next reader does not flag the exemption as a bug. [Resolution: LLD Step 1 includes the rationale in the docstring text.]
2. (Minor) Test naming: with tests spread across `tests/unit/auth/test_csrf.py` and route test files, keep names patterned `test_csrf_*` / `test_toggle_*_csrf_*` so CI failure grouping stays obvious.
3. (Minor) The LLD should explicitly state that the existing agent-route fixtures overriding `verify_csrf_token_flexible` must be updated to the new symbol for routes that switched, otherwise CI fails on import of the override target. [Resolution: stated in LLD Step 6 and File Changes.]

**New libraries / infra dependencies required**
- None.

**Better alternatives considered**
- None beyond those already in the LLD's alternatives section; the chosen alternative is the right one.

**Recommendations**
- Merge order: csrf.py + tests first (green), then the four route flips (already covered by tests). Single PR is fine given size.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (docstring clarification, applied)

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | Verify 403 toast copy on expired-session path (no code change) |
| Backend (Byte) | APPROVED WITH CHANGES | 0 must-fix after LLD revision | Enforce gate-before-validate ordering invariant; note compat change on newly-protected routes |
| SRE (Circuit) | APPROVED | 0 | Expect new INFO skip logs; grep logs for tokenless cookie callers pre-upgrade |
| Security (Cipher) | APPROVED WITH CHANGES | 0 must-fix after LLD revision | Record invariants: CSRF skip never replaces authentication; hybrid cookie+bearer = enforced |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 must-fix after LLD revision | Document the exemption policy in csrf.py docstring; update test override symbols |

**Triage outcome:** Two must-fix and several should-fix items were raised, all documentation-level (ordering invariant, authentication invariant, hybrid-request rule, docstring policy, override-symbol note). Per the mandatory feedback loop, all have been incorporated into `lld.md` (Implementation Details Step 1 behavior notes, Constraints, and Step 6), and the resolutions are recorded inline above. No reviewer requested an architecture change; the session-conditional dependency stands.

**Next Steps**
- Proceed to `testing.md` and implementation per the revised LLD.
