# Expert Review: Logout ID Token Hint Delivered Server-to-Server

*Created: 2026-09-30*
*Reviewed artifacts: `github-issue.md`, `lld.md` (draft)*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | UI/UX, logout button flow, error surfaces |
| Backend Engineer | Byte | API design, data models, correctness, performance |
| SRE/DevOps Engineer | Circuit | Deployment order, monitoring, latency, rollback |
| Security Engineer | Cipher | AuthN, secret handling, redirects, replay, injection |
| SMTS (Overall) | Sage | Architecture, code quality, maintainability |

---

## Frontend Engineer (Pixel)

**Strengths**

- The logout UX is unchanged: same `GET/POST /logout` entry points, same 303 to the IdP, same landing on `/login`. No frontend code (`frontend/src/contexts/AuthContext.tsx` navigates to `/api/auth/logout`) needs to change.
- Failure mode for the user is strictly better than today: today a WAF 403 strands the user mid-redirect with the local session already gone; with the internal hop the browser goes straight to the IdP, and any internal failure still produces a working (legacy) redirect.

**Concerns**

1. **Minor - stale-auth-server 404 adds latency, not breakage.** A registry upgraded ahead of the auth server eats a round trip + fallback per logout until the auth server is upgraded. Users will not notice (logout is rare), but the WARNING log at WARNING level could be noisy during a long mixed-version window. Consider INFO-level for the 404 case specifically (known mixed-version state) and WARNING for other statuses.
2. **Minor - double navigation perception.** Legacy flow: browser visits auth server, gets second redirect. New flow: browser gets one redirect to the IdP. No user-visible difference, but worth one line in the design doc so nobody "fixes" the missing intermediate hop later.

**New libraries / infra dependencies**

- None.

**Better alternatives considered**

- None at the UX layer.

**Recommendations**

- Keep the redirect status 303 (matches today); do not switch to 302.
- Document the single-hop navigation change in the session-flow design doc (LLD Step 8 does this; keep it).

**Questions for author**

- None.

**Verdict: APPROVED** (minor logging-level suggestion only)

---

## Backend Engineer (Byte)

**Strengths**

- Extracting the provider-branch into `_build_provider_logout_url` and calling it from both endpoints removes the drift risk between legacy and internal URL construction; the four provider families keep byte-identical output.
- Registry-side error handling is total: any non-200 or exception falls back; the legacy path is byte-identical to today (counters included).
- Reuses `validate_internal_auth` (single-use jti, 60 s TTL, derived key) instead of inventing a new secret mechanism.

**Concerns**

1. **Must-fix - response-model/field mismatch in the LLD pseudo-code.** Step 3 sketch returns `InternalLogoutUrlResponse(logout_url=..., id_token_hint_included=included)` but one branch in the sketch writes `id_token_hint_included=False` while the model declares the field; fine - but another sketch line references a `_absolutize` helper that is never defined, and the model in the Data Models section uses `redirect_uri` in the request while the sequence diagram says `redirect_uri`. The final code must use one name (`redirect_uri`) consistently across the request model, the registry payload, and the endpoint. [Resolution recorded below; fixed in revised LLD Step 3/Step 4.]
2. **Must-fix - `id_token_hint` presence flag semantics for the "no logout_url" branch.** When the provider has no `logout_url`, the endpoint returns the absolutized registry return URL with `id_token_hint_included=false`. The registry must treat that response exactly like a success (it is a valid logout redirect), not like a fallback. The LLD says "treat that response exactly like a success" only implicitly; make it explicit in the endpoint docstring and registry code path. [Fixed in revised LLD.]
3. **Should-fix - timeout choice.** 5.0 s matches `get_oauth2_providers`' timeout, but logout is latency-sensitive UX; an auth server that hangs should not stall logout for 5 s. Consider 3.0 s. Not blocking; any value in the 2-5 s range with a fallback is acceptable.
4. **Should-fix - response.json() error handling.** A 200 with a malformed body (should be impossible with FastAPI, but a proxy could interleave) must fall back too - the broad `except Exception` in `_fetch_logout_url_via_internal` already covers this; add a test for it.
5. **Minor - `id_token=None` on the internal path.** When the session has no `id_token`, calling the internal endpoint still yields the provider URL without the hint, which is exactly what the legacy path does for that case. Simplest correct choice: only call the internal endpoint when `id_token` is present; otherwise go legacy directly (preserves the `..._missing_total` counter semantics). Make this explicit. [Fixed in revised LLD.]

**New libraries / infra dependencies**

- None (httpx, pydantic, PyJWT all present).

**Better alternatives considered**

- Opaque logout ticket (rejected: extra collection/TTL machinery for no additional protection over the single-use internal JWT).

**Recommendations**

- Unify field naming (`redirect_uri` end to end).
- Only invoke the internal hop when `id_token` exists.
- Add the malformed-200 test.

**Questions for author**

- None.

**Verdict: APPROVED WITH CHANGES** (items 1, 2 must be addressed before implementation; they are)

---

## SRE/DevOps Engineer (Circuit)

**Strengths**

- Rolling-upgrade safe in both directions (new registry + old auth server falls back on 404; old registry + new auth server is unchanged). No coordinated deploy needed.
- `LOGOUT_HINT_VIA_INTERNAL=false` gives a one-knob rollback to the exact legacy behavior without redeploying code.
- The internal hop reuses the same network path (`settings.auth_server_url`) and auth mechanism as `/internal/reload-scopes`, so no new firewall/network-policy surface.

**Concerns**

1. **Should-fix - dashboard/alert note.** Two new counters exist; the design doc lists them, but operations teams need the pairing spelled out: `internal_hint_success_total` rising while `internal_hint_fallback_total` stays at 0 is healthy; sustained fallback > 0 with success == 0 means the registry is on the legacy path (mixed version or misconfig). Add this to the design doc's observability section.
2. **Should-fix - jti store dependency.** The internal JWT is single-use via the shared consumed-jti store; an outage of that store fails the internal hop closed, and logout falls back. That is correct behavior, but it means a Mongo degradation can silently push all logouts onto the WAF-visible legacy path. The fallback counter makes this visible; note it in the runbook/docs.
3. **Minor - timeout + retry budget.** One attempt, no retry, is the right call for logout (a retry doubles worst-case latency for marginal benefit; single-use jti requires re-mint anyway). Keep it.

**New libraries / infra dependencies**

- None.

**Better alternatives considered**

- None.

**Recommendations**

- Document the healthy/degenerate counter patterns (above) in the design doc.
- Keep default `LOGOUT_HINT_VIA_INTERNAL=true`; the fallback makes the default safe.

**Questions for author**

- None.

**Verdict: APPROVED WITH CHANGES** (docs items; folded into revised LLD)

---

## Security Engineer (Cipher)

**Strengths**

- The token leaves every browser-facing URL on our infrastructure: browser history, proxy/CDN logs, and WAF inspection of the auth-server hop all stop seeing the JWT. The remaining appearance (final IdP redirect) is spec-mandated.
- The internal endpoint inherits `internal_router`'s `validate_internal_auth`: HS256 with a key derived from `SECRET_KEY` (distinct from user-token keys), single-use `jti`, 60 s TTL, issuer/audience pinned. Replay and cross-token confusion are already handled.
- The 401-on-missing-auth property comes free from the router-level dependency; a new handler cannot ship unauthenticated.
- Fallback is fail-open only in the availability sense (logout still works) and fail-closed in the disclosure sense only insofar as the legacy path is exactly today's behavior - no new exposure is introduced by the fallback.

**Concerns**

1. **Must-fix - redirect URI validation parity.** The legacy `oauth2_logout` validates an absolute `redirect_uri` against the cookie domain (`_is_redirect_within_cookie_domain`) and nulls it otherwise. The internal endpoint MUST apply the same check, otherwise a compromised registry (or a bug) could feed an attacker-controlled absolute `post_logout_redirect_uri` to the IdP through the new path, bypassing the legacy guard. The LLD mentions this but the endpoint must be specced to drop `redirect_uri` on failed validation, not error. [Fixed in revised LLD Step 3.]
2. **Should-fix - logging discipline.** The JWT must never appear in logs on either side (registry WARNING/DEBUG messages must interpolate only status codes and exception classes; the auth server DEBUG messages already only log booleans). The LLD's logging section says this; keep the implementation honest.
3. **Should-fix - JWT format validation on the internal path.** The legacy registry path refuses non-JWT-shaped tokens (`_validate_jwt_format`). On the internal path the registry forwards the session's decrypted `id_token` verbatim and the auth server embeds it. The token originated from the encrypted session store (trusted at the same level as the legacy flow), so parity is acceptable; still, document the decision so the asymmetry is deliberate, not accidental.
4. **Minor - CRLF/header handling.** The hint travels in a JSON body (no header/query injection surface on the internal hop) and is URL-encoded by `urlencode` when embedded into the IdP URL. No new injection surface.

**New libraries / infra dependencies**

- None.

**Better alternatives considered**

- None beyond the LLD's alternatives table.

**Recommendations**

- Enforce redirect-URI validation parity (must-fix above).
- Keep token material out of logs; add a grep-style check to the test plan.

**Questions for author**

- None.

**Verdict: APPROVED WITH CHANGES** (item 1 blocking; addressed in revised LLD)

---

## SMTS (Overall) (Sage)

**Strengths**

- The design removes an entire class of operational failure (WAF-size rejections) and an information-disclosure channel with one well-bounded change, and it reuses the codebase's strongest existing pattern (internal signed-Bearer hops) rather than inventing machinery.
- The refactor of the provider branch into a shared helper is the right kind of opportunistic cleanup: it is required for correctness of the new path (identical URL bytes) and reduces long-term drift.
- Fallback design is honest: new path degrades to exactly today's behavior, never to something worse.

**Concerns**

1. **Should-fix - keep the diff surgical.** `auth_server/server.py` is a 6900-line module; the extraction must be a pure move of the branch block (same conditions, same params, same log lines), not an improvement pass. Any behavior change in the legacy path should be a separate PR in real life; here it must simply not happen.
2. **Should-fix - test the seams, not the frames.** The high-value tests are: (a) legacy and internal construction produce identical URLs for the same inputs, (b) registry fallback triggers on 404/exception/malformed-200, (c) unauthenticated internal call is 401, (d) flag-off path never opens an httpx client. Everything else is incidental.
3. **Minor - naming.** `logout_hint_via_internal` reads well; counters `..._internal_hint_success_total` / `..._internal_hint_fallback_total` match the existing naming grammar. No change.

**New libraries / infra dependencies**

- None.

**Better alternatives considered**

- None; the alternatives table in the LLD is complete and the rejections are sound.

**Recommendations**

- Pure-move refactor discipline for the provider branch.
- Prioritize the four seam tests above.

**Questions for author**

- None.

**Verdict: APPROVED** (with the diff-discipline note)

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendation |
|----------|---------|----------|--------------------|
| Frontend (Pixel) | APPROVED | 0 | Keep 303; document single-hop navigation. |
| Backend (Byte) | APPROVED WITH CHANGES | 2 | Unify `redirect_uri` naming; treat no-logout_url response as success; only call internal hop when `id_token` exists. |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | Document healthy vs degenerate counter patterns; note jti-store degradation side effect. |
| Security (Cipher) | APPROVED WITH CHANGES | 1 | Enforce `_is_redirect_within_cookie_domain` parity on the internal endpoint (drop `redirect_uri` on failure). |
| SMTS (Sage) | APPROVED | 0 | Pure-move refactor; test the four seams. |

### Consolidated must-fix list (addressed in revised `lld.md` before implementation)

1. **(Byte)** Consistent field naming: request model and registry payload both use `redirect_uri`; response model `logout_url` + `id_token_hint_included`. LLD revised.
2. **(Byte)** No-`logout_url` providers: internal endpoint returns the absolutized return URL as a success response; registry uses it as the logout redirect. Made explicit in revised LLD.
3. **(Byte)** Registry invokes the internal hop only when the session carries an `id_token`; the missing-token case goes straight to legacy so `..._missing_total` semantics are preserved. Revised LLD Step 5.
4. **(Cipher)** Redirect-URI validation parity on the internal endpoint: absolute URIs outside the cookie domain are dropped (falling back to `/login` derivation), exactly like the legacy endpoint. Revised LLD Step 3.

### Next Steps

No blocking findings remain; all must-fix items above are folded into the revised LLD and the implementation follows it. Proceed to `testing.md` and the patch.
