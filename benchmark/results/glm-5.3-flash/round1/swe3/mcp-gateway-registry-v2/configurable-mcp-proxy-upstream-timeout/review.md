# Expert Review: Configurable /mcp-proxy upstream timeout (MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS)

*Created: 2026-09-30*
*Reviewed artifact: `./lld.md` (draft) against `./github-issue.md`*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | Admin UI / config surface rendering, field UX |
| Backend Engineer | Byte | API design, settings plumbing, httpx semantics, tests |
| SRE/DevOps Engineer | Circuit | Deployment surfaces, rollout, edge-proxy interaction |
| Security Engineer | Cipher | SSRF/abuse posture, resource limits, config injection |
| SMTS (Overall) | Sage | Architecture, pattern fidelity, maintainability |

---

## Frontend Engineer (Pixel)

**Strengths**
- The knob lands in the existing `auth` section of `CONFIG_SECTIONS`, so the admin UI picks it up through the same generic form machinery as `MCP Proxy Max Body Bytes` -- no bespoke rendering, no new UI code, consistent labels and masking semantics (`False` = not secret, correct for a numeric timeout).
- Label "MCP Proxy Upstream Timeout (seconds)" names the unit explicitly, which prevents the most common misconfiguration for time values.

**Concerns**
1. *(minor)* The admin UI displays the settings-file value but the effective value can differ when the env var is also set (settings wins in the reader cascade). This is pre-existing behaviour shared with the body-bytes knob, not introduced here, but the UI gives no hint which value is in effect.
2. *(minor)* There is no client-side range validation on the numeric field; an admin can type `0` or `-5` in the UI and only the server-side clamp saves them. Again shared with the existing pattern.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None worth the diff; a units-suffixed numeric input widget would be nice-to-have UI polish out of scope for a config-plumbing change.

**Recommendations**
- Keep the label unit-suffixed. Optionally add a short help text pointing at `docs/unified-parameter-reference.md` (nice-to-have, not blocking).

**Questions for author**
- Does the admin config PUT path validate numeric ranges server-side, or does it accept anything and let the reader clamp? (Clamping is acceptable; silent round-trip of an out-of-range value would be worth a follow-up.)

**Verdict:** APPROVED (two minor, non-blocking UX notes)

---

## Backend Engineer (Byte)

**Strengths**
- Correct seam: the helper re-reads per request exactly like `_read_mcp_proxy_max_body_bytes`, so tests can flip values with `patch.dict`/`patch.object` without re-importing modules, and operators get consistent semantics with the existing knob.
- Default 30.0 and the 504 mapping are untouched; error paths (`httpx.TimeoutException` -> 504, `httpx.HTTPError` -> 502) are unchanged, so the only delta is where the number comes from.

**Concerns**
1. **(must-fix) NaN propagation.** The body-bytes reader is integer-based; `float("nan")` parses fine and `max(nan, 1.0)` propagates NaN in Python. A `float` knob must guard NaN explicitly or a junk-but-parseable env value (`nan`) silently poisons the request path. `inf` is harmless (effectively no timeout) but should be a documented, deliberate outcome.
2. **(should-fix) Test observability of the timeout.** The existing `_patch_httpx_async_client` helper returns a patch object and discards the constructor call args. The plan must extend the helper (or add a sibling) so tests can assert on `AsyncClient(timeout=...)` kwargs; otherwise the tests cannot actually pin the wired value and would only exercise the reader in isolation.
3. *(minor)* `getattr(settings, "mcp_proxy_upstream_timeout_seconds", None)` returns None when the Settings fixture lacks the field; that path is correct, but the docstring should say the cascade explicitly so the next knob copied from this one keeps the contract.
4. *(minor)* The settings->env cascade order differs subtly from what an operator might expect (env loses to settings when both set). This matches the body-bytes knob exactly, so it is consistent -- just make sure docs say settings wins.

**New libraries / infra dependencies**
- None required; stdlib float parsing plus the existing pydantic-settings machinery.

**Better alternatives considered**
- `httpx.Timeout(connect=..., read=..., write=..., pool=...)`: rejected, over-broad (see LLD Alternatives).
- Caching the resolved value at import: rejected, breaks the established per-request read pattern and testability.

**Recommendations**
- Add the NaN guard in both the settings branch and the env branch of the reader (return default / fall through respectively).
- Extend `_patch_httpx_async_client` to capture constructor kwargs; write the default/override/floor/junk tests against the wired handler, not just the helper.

**Questions for author**
- Should a value that fails Settings validation (e.g. `-3` reaching pydantic with `ge=1.0`) crash startup? Current design: pydantic `ge=1.0` rejects it at instantiation. Is that acceptable for a direct `Settings(...)` misuse, given the env path clamps? (Yes -- the settings path only ever holds a validated value in production; the clamp is defence in depth.)

**Verdict:** APPROVED WITH CHANGES (NaN guard and test-observability extension are required before implementation)

---

## SRE/DevOps Engineer (Circuit)

**Strengths**
- Full surface parity with the existing knob: compose x3, Helm (values/secret/reserved names), Terraform root+module+task-def+tfvars example, `.env.example`, unified parameter reference. Nothing an operator uses will be missing the knob.
- Default 30 means a no-op upgrade; the knob is opt-in, so no rollback plan beyond "unset the variable" is needed.

**Concerns**
1. **(should-fix) Edge-proxy idle timeouts.** Raising this value past the ALB idle timeout or nginx `proxy_read_timeout` moves the 504 from the gateway to the edge, where it looks like a different failure. The docs row must call this out explicitly (the draft docs row does; keep it through implementation).
2. *(minor)* Helm secret.yaml uses `toString | b64enc` for the new value in the plan, while the body-bytes line uses bare `b64enc` (values are pre-quoted strings). Either is fine because the value is quoted in values.yaml, but `toString` is the safer template if an operator supplies a number; keep `toString`.
3. *(minor)* Reserved-env-names placement is cosmetic (alphabetical); a wrong position breaks nothing but review tooling may flag ordering.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Also adding the value to the registry chart for symmetry: rejected; the registry chart deliberately does not carry `mcpProxyMaxBodyBytes` because the auth-server is the only consumer of the proxy hop. Symmetry with the *right* chart matters more than symmetry with both charts.

**Recommendations**
- Keep the edge-proxy caveat in the docs row verbatim.
- In ECS/compose, the env var passes through untouched; no health-check or task-definition changes needed. Confirm no hard-coded `30` exists anywhere else in the deploy tree (grep during implementation).

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (docs caveat is must-keep; template `toString` choice should match the plan)

---

## Security Engineer (Cipher)

**Strengths**
- The change does not touch the security-critical parts of the hop: token verification, sub-path append, header allowlist, and body cap are all untouched. Only the timeout scalar changes provenance.
- The 1-second floor is a real control: it prevents "set it to 0 to disable" misconfigurations that would let a stuck or malicious upstream hold gateway connections and worker slots indefinitely.

**Concerns**
1. **(should-fix) Slow-loris-style resource exposure.** A larger timeout widens the window for connection-holding abuse through the proxy hop. This is an operator's deliberate trade-off (they opt in), but the docs should say: raise it only as far as your longest legitimate call, and pair it with edge-level concurrency/rate limits. The LLD's Scaling section says this; mirror a one-liner in the docs row.
2. *(minor)* `inf` accepted from the env string means an operator can effectively disable the cap. It parses as `float("inf")` and passes the NaN guard. Acceptable as an explicit operator choice, but worth one doc sentence; alternatively reject non-finite values. Recommend: reject non-finite in the env branch (warn + default), so "no timeout" is never reachable from config -- bounded caps are a security invariant here.
3. **(must-fix) NaN, again, from the security angle:** NaN in the timeout would make every upstream call fail unpredictably (httpx comparison semantics), which is an availability bug triggered by one bad env var; guard it (aligns with Byte's must-fix).

**New libraries / infra dependencies**
- None. (Deliberately not pulling in `math.isfinite` avoidance debates -- use it, it's stdlib.)

**Better alternatives considered**
- Rejecting values above an upper bound (e.g. 3600): rejected as arbitrary; operators legitimately run multi-hour batch tools. The floor is the invariant; the ceiling is the operator's risk acceptance.

**Recommendations**
- Guard NaN; recommend treating non-finite env values (nan/inf) as invalid -> warn + default, keeping the timeout always bounded. If `inf` support is kept, document it explicitly.
- Keep the 1s floor; do not add a 0-means-disabled mode.

**Questions for author**
- Confirm the reader never returns 0 or a negative (clamp floor guarantees it) -- yes by construction.

**Verdict:** APPROVED WITH CHANGES (NaN/non-finite handling required; docs caveat recommended)

---

## SMTS (Overall) (Sage)

**Strengths**
- The design is a faithful, complete extension of an existing, well-proven pattern rather than a novel mechanism. Pattern fidelity is the whole game in a 17-file config-plumbing change: reviewers and operators can pattern-match the new knob against the old one with zero learning cost.
- Scope discipline is excellent: no per-server schema, no granular timeouts, no error-path changes; the issue is solved with a scalar and its fan-out.
- The test plan drives the real handler end-to-end with the established mock conventions, which pins the actual wiring, not just the helper.

**Concerns**
1. **(must-fix, consolidating)** Non-finite float handling is the only place the design deviates from a verbatim pattern copy, and it must be settled in the LLD before implementation: NaN must never reach the handler; recommend rejecting all non-finite env values (warn + default) and letting the settings path rely on pydantic validation. `inf` as "no timeout" is a footgun; bounded caps are the invariant.
2. **(should-fix)** The tests must assert the timeout reaches `httpx.AsyncClient` through the real request path (extend the mock helper to expose constructor call args). Reader-only tests would leave the actual wiring unpinned -- the exact class of bug this feature could silently regress into (reverting to `30.0` inline while the helper still exists).
3. *(minor)* Seventeen files is the honest cost of surface parity here; resist the temptation to skip "just the docs" or "just the tfvars example" -- partial fan-out is what makes future knobs untrustworthy.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Config-object refactor passing a shared "proxy options" struct into the handler: right instinct for the long term, wrong diff for this issue; the reader-helper pattern is the codebase's current idiom.

**Recommendations**
- Amend the LLD reader to reject non-finite values in both branches (settings branch: treat non-finite as parse failure falling through to env; env branch: warn + default).
- Extend `_patch_httpx_async_client` for constructor-kwargs capture and write the four tests (default / override / floor / junk-env) against the wired handler.
- Proceed to implementation only after the LLD reflects both.

**Questions for author**
- None; the revised LLD should record these as design decisions, not open questions.

**Verdict:** APPROVED WITH CHANGES

---

## Review Summary

| Reviewer | Verdict | Blocking Findings | Key Recommendations |
|----------|---------|-------------------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | Unit-suffixed label; optional help text |
| Backend (Byte) | APPROVED WITH CHANGES | 2 (NaN guard; test observability via extended mock helper) | Guard NaN; assert timeout through wired handler |
| SRE (Circuit) | APPROVED WITH CHANGES | 1 (edge-proxy caveat must stay in docs) | Keep docs caveat; `toString` in Helm template |
| Security (Cipher) | APPROVED WITH CHANGES | 1 (non-finite handling) | Reject non-finite env values; keep 1s floor; no 0=disabled mode |
| SMTS (Sage) | APPROVED WITH CHANGES | 2 (consolidates NaN/non-finite; wired-handler tests) | Settle non-finite semantics in LLD; resist partial fan-out |

### Next Steps
Per the mandatory feedback loop, the LLD was revised before implementation:
1. Reader helper now rejects non-finite values: settings branch treats `nan`/`inf` as a parse failure and falls through to env; env branch warns and returns the default for `nan`/`inf`/junk. The timeout is therefore always a finite float >= 1.0. (Resolves Byte #1, Cipher #1/#3, Sage #1.)
2. `_patch_httpx_async_client` in the test plan was extended to capture `httpx.AsyncClient` constructor kwargs, and all four tests (default 30.0, override 120.0, floor clamp 0.25 -> 1.0, junk "banana" -> 30.0) assert through the wired `/mcp-proxy` handler. (Resolves Byte #2, Sage #2.)
3. The docs row keeps the edge-proxy idle-timeout caveat and adds the "raise only as far as your longest legitimate call" sentence. (Resolves Circuit #1, Cipher #2 documentation half.)

No blocking findings remain; proceeding to testing plan and implementation on the revised LLD.
