# Expert Review: Configurable UI Title (UI_TITLE)

*Reviewed: 2026-09-30*
*Design under review: `./lld.md` (initial draft)*
*Issue: `./github-issue.md`*

---

## Frontend Engineer (Pixel)

**Focus:** UI/UX, components, state, API integration.

### Strengths
- Reuses the existing `useRegistryConfig` hook instead of inventing a second config fetch. One cache, one request, consistent with how `deployment_mode` reaches components today.
- Defensive `config?.ui_title ?? 'AI Gateway & Registry'` fallback means the components never crash or render `undefined` if the API is old or the request fails.
- Correctly leaves the pre-first-render `<title>` in `index.html` alone (out of scope), avoiding the FOUC-worse variant where the tab flashes a custom title before hydration.

### Concerns
1. **First-paint mismatch in registry-only mode (should fix, accepted as consistent):** while `/api/config` is in flight, `DEFAULT_CONFIG.ui_title = 'AI Gateway & Registry'` renders for a registry-only pod, then swaps to `AI Registry`. This is exactly how `deployment_mode`-driven UI already behaves (e.g. DeploymentModeIndicator), so it is consistent, but reviewers should not call it "no visual change" for registry-only. Mitigation (deferred): persist last-known config in `localStorage`.
2. **`Logout.tsx` and `Login.tsx` must each call the hook** - `Logout` currently imports no config hook and `Login` fetches auth config separately. Minor state addition; no request duplication because the hook caches at module level. Verified `useRegistryConfig.ts:32` (`cachedConfig` module global).
3. **Alt-text consistency (nit):** `Layout.tsx:92` logo `alt="AI Gateway & Registry Logo"` stays hardcoded per the LLD. Acceptable, but if an operator sets `UI_TITLE="Acme"`, screen readers still announce the old brand on the logo image. Suggest a follow-up issue, not a blocker.

### New libraries / infra dependencies
None. Hook and axios already in use.

### Better alternatives considered
Persisting the resolved title into `document.title` after load (tab title). Rejected for this patch: the static pre-render tab title is explicitly out of scope, and setting `document.title` post-load is a behavior change not requested.

### Recommendations
- Keep the fallback literal identical across all four components (single canonical string).
- Do not introduce a separate `useUiTitle` hook; extend the existing interface.

### Questions for author
- Should `UptimeDisplay`'s tooltip keep the "and" spelling fallback or the canonical "&"? (LLD says canonical `&`; fine.)

### Verdict: APPROVED WITH CHANGES
(Non-blocking: first-paint note; fallback consistency required.)

---

## Backend Engineer (Byte)

**Focus:** API design, data models, business logic, performance.

### Strengths
- `effective_ui_title` as a `@property` mirrors `nginx_updates_enabled`; derivation logic lives in one place and both endpoints share it.
- Blank-string guard (`ui_title.strip()`) handles the compose `:-` empty-default case correctly; this was the likeliest correctness bug and the design catches it.
- Public endpoint change is additive: one new key, no key removed or reshaped, so existing consumers (ServerConfigModal, DeploymentModeIndicator) are untouched.

### Concerns
1. **`/api/config/full` shows effective, not configured, value (must clarify, design acceptable):** the deployment group reads `settings.ui_title` via `_get_field_value`, which returns `None` when unset - the panel would show `(not set)` while the UI displays a derived default. The LLD says the panel shows the *effective* value, but the field-tuple mechanism pulls the raw attribute. To realize the LLD, the tuple entry alone is insufficient; either (a) accept `(not set)` display for unset (honest, but the operator cannot see the derived value), or (b) display effective. **Resolution adopted:** implement (b) by making the shown value effective - simplest is to keep the tuple pulling `ui_title` raw (shows `(not set)` when deriving) and add the effective title to the deployment group via a second tuple bound to a property. `effective_ui_title` as a `@property` is picked up by `_get_field_value` verbatim (plain string, no enum unwrap needed), so adding `("effective_ui_title", "UI Title (Effective)", False)` alongside `("ui_title", "UI Title", False)` gives operators both facts with zero new machinery. Accepted with this adjustment.
2. **Sensitive-field pattern check (verified safe):** `_is_sensitive_field` matches patterns like `key`, `token`, `secret`, `password`. `"ui_title"` contains none; `"effective_ui_title"` contains none. No accidental masking.
3. **Enum handling (verified):** `_get_field_value` unwraps `.value` when present; `effective_ui_title` is `str`, so it passes through unchanged.
4. **`/api/config` 60s cache:** applies only to `/api/config/full` (verified `_get_cached_config_response` usage); the public endpoint is uncached, so no stale-title window. Non-issue.

### New libraries / infra dependencies
None.

### Better alternatives considered
Return `ui_title` inside a nested `branding` object to future-proof for logo/favicon params. Rejected: breaks the flat-shape convention of the endpoint for zero current need; additive evolution can nest later with a versioned field if branding grows.

### Recommendations
- Adopt the two-tuple display from Concern 1.
- Keep `ui_title` position in the payload stable (after `nginx_updates_enabled`) for diff readability across models/environments.

### Questions for author
- None.

### Verdict: APPROVED WITH CHANGES
(One must-apply adjustment: deployment-group display of the effective title as specified above.)

---

## SRE/DevOps Engineer (Circuit)

**Focus:** deployment, monitoring, scaling, infrastructure.

### Strengths
- All three deployment surfaces covered with the same empty-means-derived semantics; operators get one mental model.
- Conditional rendering (Helm `{{- with }}`, Terraform concat) keeps unset deployments byte-identical - no spurious rollout noise on upgrade.
- `docker-compose.dhi.yml` correctly left untouched (no registry env there).

### Concerns
1. **Helm env-index test brittleness (must fix in tests):** `charts/registry/tests/extra_env_test.yaml` asserts `env[6] = KEYCLOAK_ADMIN_PASSWORD` under the keycloak preset. Inserting a *static* UI_TITLE entry would break these asserts; the LLD's conditional placement avoids that for default values, and the test file must gain a set-value variant asserting the new indices. The LLD already specifies this; calling it out so it is not skipped.
2. **Reserved-name addition is a behavior change (accepted, flag it):** adding `UI_TITLE` to `reservedEnvNames` means a deployment that today injects `UI_TITLE` via `extraEnv` (why would they, but possible) fails at template time after upgrade. That is the chart's documented philosophy ("over-rejection is preferred"), so accepted; note it in release notes.
3. **Terraform plan noise (minor):** adding a variable with default `""` produces no diff; the concat-conditional env entry produces no diff until set. Verified approach matches existing optional-entry idioms in `ecs-services.tf`.
4. **Rollback (verified trivial):** unset the variable / value and redeploy; no state migration, no data semantics.
5. **Observability (none needed, agreed):** a startup log line was considered; correctly rejected. The title is introspectable via `/api/config`.

### New libraries / infra dependencies
None. `helm unittest` already in the chart's test setup.

### Better alternatives considered
A ConfigMap-mounted branding file (title, logo, footer) for future branding needs. Rejected now: over-engineered for one string; env-var-per-param matches every adjacent parameter's pattern.

### Recommendations
- Add the helm-unittest cases exactly as the LLD specifies (absent by default, present+indices when set, reserved-name rejection).
- Mention the reserved-name addition in release notes.

### Questions for author
- None.

### Verdict: APPROVED WITH CHANGES
(Must fix: helm test updates must land with the template change.)

---

## Security Engineer (Cipher)

**Focus:** AuthN/AuthZ, validation, OWASP, data protection.

### Strengths
- Served through the existing allow-listed `/api/config` rather than a new unauthenticated surface.
- No injection surface: the title is rendered as a React text node (`{uiTitle}`), which HTML-escapes; not `dangerouslySetInnerHTML`. An operator-controlled string, but still worth stating.
- No secrets involved; `is_sensitive=False` is correct and the name-based pattern check confirms no accidental masking or leakage class change.

### Concerns
1. **Unauthenticated information disclosure (accepted, minimal):** `/api/config` is public by design (mode filter). The title adds minor fingerprinting detail (custom brand reveals the operator). Accepted: the value is cosmetic, and registry deployments behind auth still expose this endpoint today for `deployment_mode`.
2. **Header injection via env (non-issue, verified):** env vars cannot contain newlines in Docker/K8s; ECS and Helm quote the value (`| quote`). No CRLF vector.
3. **Terraform/Helm value handling:** `value = var.ui_title` and `{{ . | quote }}` - both safe for arbitrary strings including quotes and spaces. Compose `${UI_TITLE:-}` in list syntax is shell-word-safe (compose interpolates, no shell).
4. **No validation requirement:** free text is the point (product names can contain `&`, quotes, unicode). Do not add length limits beyond sanity; suggest documenting a soft limit in the description only if the team wants one. Not a blocker.

### New libraries / infra dependencies
None.

### Better alternatives considered
None; the transport and rendering paths are the existing, already-reviewed ones.

### Recommendations
- Keep React text-node rendering; forbid any future switch to `dangerouslySetInnerHTML` for this value.
- No CSP or sanitization changes required.

### Questions for author
- None.

### Verdict: APPROVED

---

## SMTS (Sage)

**Focus:** architecture, code quality, maintainability.

### Strengths
- The design follows the repo's strongest existing grain: env var -> pydantic Settings -> derived property -> flat `/api/config` -> hook -> components. Nothing new is invented; every seam already exists.
- Single source of truth for derivation (the property) means backend admin panel, public endpoint, and all four frontend surfaces cannot drift.
- Additive API evolution with a real backwards-compat story (unset == today's behavior, byte-identical infra rendering).

### Concerns
1. **Effective-vs-raw display in the admin panel (same as Byte's Concern 1, agreed with the two-tuple resolution):** exposing both `UI Title` (configured) and `UI Title (Effective)` is more honest than overwriting one, and costs one tuple entry. Adopt.
2. **Frontend fallback duplication (acceptable, bounded):** the literal `'AI Gateway & Registry'` appears as fallback in four components plus `DEFAULT_CONFIG`. A `constants.ts` export would centralize it, but the repo has no such constants module for UI strings today and creating one for one string is churn. Accept duplication; note for future maintainers.
3. **Scope discipline (good):** out-of-scope list is explicit (i18n, favicon, static index.html tab title). The static `registry/static/index.html` also contains the old title - correctly untouched since it is the built artifact of `frontend/public/index.html`.
4. **Test coverage asymmetry (fix in patch):** the backend property and endpoint additions are cheap to unit test and the repo has clear homes for them; the design's test step covers both. The frontend has jest infrastructure; if adding component tests there is disproportionate for this change, at minimum the hook's `DEFAULT_CONFIG` typing keeps TS honest. Acceptable.

### New libraries / infra dependencies
None.

### Better alternatives considered
A generalized `branding` settings object (`ui_branding.title`, etc.). Rejected: YAGNI for one field; a flat `ui_title` matches the flat field convention throughout `Settings`. Revisit if branding grows beyond two parameters.

### Questions for author
- None.

### Verdict: APPROVED WITH CHANGES
(Adopt Byte's Concern 1 resolution; otherwise as designed.)

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Consistent fallback literal; first-paint swap documented; alt-text follow-up |
| Backend (Byte) | APPROVED WITH CHANGES | 1 | Show effective title in admin panel via second tuple (`effective_ui_title` property) |
| SRE (Circuit) | APPROVED WITH CHANGES | 1 | Helm unittest updates must land with the template change; release-note the reserved-name addition |
| Security (Cipher) | APPROVED | 0 | Keep React text-node rendering; no new exposure beyond existing endpoint |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 | Adopt Byte's resolution; accept bounded fallback duplication |

### Next Steps

**Blocking findings addressed in the LLD before implementation (Step 7.5 loop):**

1. **[Byte/Must-fix] Admin panel effective-title display.** The single tuple `("ui_title", "UI Title", False)` shows `(not set)` when the title is derived, hiding the effective value from operators. **Resolution (applied to lld.md):** add a second tuple `("effective_ui_title", "UI Title (Effective)", False)` to the deployment group. The existing `@property` is read by `_get_field_value` as a plain string (no enum unwrap needed), requires no new machinery, and displays the mode-derived default. The LLD's Step 2 and API section are updated accordingly.
2. **[Circuit/Must-fix] Helm test updates are part of the change, not a follow-up.** **Resolution (applied to lld.md):** Step 7 explicitly includes the `extra_env_test.yaml` cases: `UI_TITLE` absent by default, present with correct indices when `app.uiTitle` is set, and `extraEnv` rejection via the reserved list. Implemented in the same patch.

**Non-blocking, recorded as deferred/accepted:**
- First-paint title swap in registry-only mode (consistent with existing hook behavior; localStorage caching deferred).
- Logo alt-text remains static (follow-up issue candidate).
- `UI_TITLE` added to Helm reserved env names is an intentional, philosophy-consistent breaking change for `extraEnv` users; release notes should mention it.
- Fallback-literal duplication across frontend components accepted (no existing constants module; churn not justified for one string).

No NEEDS REVISION verdicts; design proceeds to testing plan and implementation with the two must-fix items incorporated.
