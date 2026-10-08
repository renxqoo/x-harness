# Expert Review: Honour MCP_CLOUD_PROVIDER override in the UI telemetry-detection endpoint

*Created: 2026-09-29*
*Reviewed artifacts: `github-issue.md`, `lld.md` (revision of 2026-09-29)*

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
- Correct diagnosis of the surface: `UptimeDisplay.tsx` is a dumb renderer for `{cloud, cloud_detection_method}`; fixing the backend contract fixes the UI with zero frontend edits and zero rebuild risk.
- The tooltip already renders arbitrary strings (`via {method}`), so the new `explicit` / `operator_declared` labels display correctly with no formatting work.

**Concerns**
- Minor (cosmetic): the tooltip title reads "Detected via {method}". With an override, "Detected via explicit" reads slightly off, since nothing was detected; it was declared. Suggested follow-up (out of scope here): render "Set via MCP_CLOUD_PROVIDER" when method is `explicit`. The LLD explicitly scopes frontend changes out; acceptable for this patch.
- Minor: the component fetches once per mount with no refresh. If an operator changes the override, the tooltip stays stale until a page reload. Pre-existing behaviour (the cascade is process-cached anyway), not a regression from this change.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None at this layer; the alternative (adding a separate override-aware endpoint and branching in the component) would be strictly worse.

**Recommendations**
- Keep the response contract frozen at exactly the two keys; the component has no schema tolerance beyond them.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Byte (Backend Engineer)

**Strengths**
- The chosen fix is the minimal-diff, maximal-correctness option: replace one call (`_detect_cloud_provider_with_method()` -> `await _resolve_cloud()`). Single source of truth for the priority cascade; the UI path can never drift from the telemetry path again.
- Reusing the resolver also picks up the operator-hint tier, so hint-set installs (banner answers) get the same consistency win, not just override-set ones.
- The await is free: the handler is already `async def`, and `get_banner_state` in `registry/api/registry_routes.py` is existing precedent for a route consuming the async resolver.

**Concerns**
1. **Should-fix (test hygiene):** the regression tests must control *both* resolver inputs, not just settings. If the override-unset test doesn't stub `_get_operator_cloud_hint` (or clear `_hint_cache`), a hint left over from another test in the same process could flip the assertion. The LLD's test section already calls for stubbing the hint tier and the cascade; implement exactly that.
2. **Minor (latency):** the endpoint now performs a repository read (hint tier) on cache miss when no override is set. Bounded by the existing 60s TTL (`_HINT_CACHE_TTL_SECONDS`), same budget the banner endpoint already pays. Acceptable.
3. **Minor (side effect):** each resolution logs the `[telemetry] cloud_detection:` line and increments `CLOUD_DETECTION_TOTAL`. On an override-set install this happens once per process (override tier returns before the cascade; note the explicit tier is *not* itself lru_cached, so the line can repeat per call). Harmless; do not add dedup logic.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Inline override check in the endpoint: rejected, duplicates priority logic and misses the hint tier (see LLD Alternatives).
- Caching the endpoint response: rejected, second staleness window.

**Recommendations**
- Update the endpoint docstring to enumerate the widened method set (`explicit/operator_declared/operator_declined`), since it currently documents only cascade methods. The LLD includes this; keep it in the patch.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (implement the tests exactly as specified in the LLD: stub settings, hint tier, and cascade together)

---

## Circuit (SRE/DevOps Engineer)

**Strengths**
- Zero deploy-surface change: no new env var, no Compose/Helm/Terraform edits, no migration. Rollforward = apply patch; rollback = reverse patch.
- Operator documentation already claims `MCP_CLOUD_PROVIDER` "overrides cloud auto-detection"; this patch makes the code match the docs. No doc updates required, which is the right outcome.

**Concerns**
1. **Minor (dashboards):** `CLOUD_DETECTION_TOTAL{cloud,method}` will now also count UI-triggered resolutions, and after this change an override-set install emits `method=explicit` from the display path too. Existing dashboards that assumed only cascade methods may see the new label; the telemetry-collector allowlist already accepts these values (verified in `terraform/telemetry-collector/lambda/collector/schemas.py` reference in telemetry.py comments), so ingestion is safe.
2. **Minor (perf):** one extra potential repository read per UI page load per minute (hint TTL). Negligible; not worth caching.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None; any infra-side workaround (fixing the env var in deployment templates) would treat the symptom and keep the code wrong.

**Recommendations**
- When releasing, note in the changelog that the UI Cloud row now reflects `MCP_CLOUD_PROVIDER` and the operator hint.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Cipher (Security Engineer)

**Strengths**
- AuthN surface untouched: the `nginx_proxied_auth` dependency stays, so the 401-on-anonymous guarantee is preserved (and the existing regression test stays).
- No new inputs, no user-controlled data introduced into the response; the values come from validated settings and internal constants. The `mcp_cloud_provider` validator already rejects/ignores invalid values server-side (`registry/core/config.py`), so no injection surface opens up; the UI renders the strings as text.

**Concerns**
1. **Minor (information exposure):** the endpoint (authenticated) now reveals whether an operator override is in effect. That is the point of the endpoint ("lets operators verify how their instance was classified"), the caller must already be authenticated, and the same information was already available via telemetry events and the banner-state endpoint. No new exposure class.
2. **Minor:** the hint tier adds a registry-card repository read inside a request handler. The repository layer is the same one every other authenticated route already uses; error paths are swallowed by `_get_operator_cloud_hint()`, so no stack-trace leakage.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None.

**Recommendations**
- None beyond keeping the existing auth tests green.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Sage (SMTS, Overall)

**Strengths**
- The design removes a forked truth source instead of patching around it. Before: two call sites answered "what cloud is this?" differently. After: one resolver, two consumers. That is the correct shape, and it is achieved with a ~6-line production diff.
- The LLD's alternatives section is honest about why inline override logic (the tempting quick fix) would have reintroduced drift and missed the hint tier.
- Tests are specified at the right level: through the FastAPI route with the auth dependency overridden, resolver inputs stubbed individually, covering override-set and override-unset.

**Concerns**
1. **Must-address (process):** per the review loop, the Byte should-fix item is folded into the LLD's test specification before implementation. (Addressed: LLD "New Test Coverage" and testing.md both specify stubbing settings + hint + cascade together.)
2. **Minor (future):** `_resolve_cloud()`'s explicit tier calls `_log_detection_result` on every invocation, while the cascade is lru_cached to log once. If UI polling ever gets chatty, the log line could repeat. Not worth fixing now (endpoint is fetched once per mount); noted for a future pass if cadence changes.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- A versioned `/v2` endpoint: rejected, unnecessary API surface growth for a bug fix with a compatible in-place contract.

**Recommendations**
- Land the docstring widening with the code change so the contract is discoverable at the definition site.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (the single must-address item is the test-specification tightening, already reflected in the LLD)

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Themes |
|----------|---------|----------|------------|
| Frontend (Pixel) | APPROVED | 0 | No frontend change needed; contract freeze |
| Backend (Byte) | APPROVED WITH CHANGES | 0 (1 should-fix) | Tests must stub settings + hint + cascade together |
| SRE (Circuit) | APPROVED | 0 | No deploy-surface change; changelog note on release |
| Security (Cipher) | APPROVED | 0 | AuthN unchanged; no new exposure |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 (1 process item) | Fold test tightening into LLD before implementing |

### Blocking-finding triage (Step 7.5 loop)

- No critical / NEEDS REVISION findings were raised.
- The two "with changes" items (Byte should-fix on test stubbing; Sage process item pointing at the same thing) were folded back into the LLD before implementation: the "New Test Coverage" section and testing.md now explicitly require stubbing `settings.mcp_cloud_provider`, the hint tier, and the cascade in each regression test. No LLD architecture/data-model sections required revision.

**No blocking findings remain; proceeding to implementation.**

### Next Steps

1. Implement the endpoint change per LLD Step 1.
2. Add the two regression tests exactly as specified (stub all three resolver inputs).
3. Capture `patch.diff`; verify it applies onto a clean `1.24.7` checkout.
