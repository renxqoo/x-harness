# Expert Review: Pass SSRF allowlist env vars to the registry container in every compose file

*Created: 2026-09-30*
*Reviewed artifacts: `github-issue.md`, `lld.md` (draft)*

## Frontend Engineer (Pixel)

**Focus:** UI/UX surfaces affected by the change.

**Strengths**
- Correctly scoped: the change has no UI surface at all. Health-check results shown in the registry UI (`url blocked by SSRF guard` vs a healthy status) are the only user-visible signal, and they improve purely as a consequence of the env reaching the process.

**Concerns**
- None. No frontend files, build config, or API response shapes are touched.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None relevant; a UI indicator for "allowlist configured" would be scope creep.

**Recommendations**
- None.

**Questions for author**
- None.

**Verdict:** APPROVED

## Backend Engineer (Byte)

**Focus:** API/settings plumbing, correctness of the Compose interpolation and pydantic-settings chain.

**Strengths**
- The variable chain is traced end to end and it checks out: `.env` -> Compose `${VAR:-}` substitution -> container env -> `Settings.ssrf_allowed_hosts/cidrs` (`registry/core/config.py:591-611`, no env prefix, so names must match exactly, and they do) -> `url_guard` allowlist.
- Correctly identifies that Compose never forwards undeclared variables, which is the root cause; the fix is the minimal, idiomatic one.
- Reusing the base file's comment verbatim keeps the three files grep-consistent.

**Concerns**
1. **(should-fix) Prebuilt insertion anchor ambiguity.** The draft LLD said "insert between `REGISTRY_CONTACT_URL` and `SECRET_KEY`" for `docker-compose.prebuilt.yml`, but that span contains the deliberate `BUILD_VERSION` rationale comment (lines 91-95). An implementer following the prose literally could insert after that comment and silently separate it from `SECRET_KEY`, muddying what it documents.
   - **Resolution:** `lld.md` Step 2 now pins the exact anchor: insert immediately after the `- REGISTRY_CONTACT_URL=...` line and before the `# BUILD_VERSION is NOT set here...` comment; the BUILD_VERSION comment stays attached to `SECRET_KEY`. `testing.md` includes a grep check that the BUILD_VERSION comment still directly precedes `- SECRET_KEY=`.
2. **(note) `${VAR:-}` yields an empty string, not an unset variable.** pydantic-settings will read `SSRF_ALLOWED_HOSTS=""`, which equals the field default, so behavior is identical. No action needed; documenting so nobody "fixes" it to `?:`-required syntax later.
3. **(note) No compose-parsing test exists in `tests/`.** Acceptable for this change (config-only), but the testing plan's `docker compose config` checks must be treated as the acceptance gate.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- `env_file: .env` passthrough: rejected (blast radius, inconsistent with the file family's explicit style). Agrees with the LLD's analysis.

**Recommendations**
- Keep the two entries adjacent to each other and to the comment, exactly as in the base file, so a future diff across the three files stays clean.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (anchor pinning incorporated into the LLD before implementation)

## SRE / DevOps Engineer (Circuit)

**Focus:** Deployment surfaces, rollout, rollback, operator workflow.

**Strengths**
- Deployment-surface checklist is complete and honest: base compose already wired, DHI is an override-only file with no registry service (verified against the file's service list), chart already wired.
- Rollout plan is right: env changes require `docker compose up -d registry` (container recreate), no image rebuild, no state migration, rollback = revert the file.

**Concerns**
1. **(should-fix) Operator recreate step not called out prominently enough for prebuilt/podman users.** Setting the variable in `.env` alone does nothing to a running container; the registry service must be recreated.
   - **Resolution:** `lld.md` Rollout Plan Phase 3 and `testing.md` Section 4/5 now state explicitly that `docker compose up -d registry` (recreate) is required after editing `.env`, for both edited files.
2. **(note) Podman compatibility.** `docker-compose.podman.yml` is consumed by podman-compose / `podman compose`; `${VAR:-}` default-value interpolation is standard Compose spec and supported by current podman-compose, and the file already uses the same syntax extensively (e.g. `DEPLOYMENT_MODE=${DEPLOYMENT_MODE:-with-gateway}`), so no new compatibility risk is introduced.
3. **(note) ECS/Terraform not touched.** The equivalent ECS task definition wiring is out of scope for this compose-scoped issue; nothing regresses there because this change only adds declarations.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Adding a CI `docker compose config` smoke step: good future hardening, but new CI wiring is out of scope for this fix.

**Recommendations**
- When verifying, render all three files with `docker compose config` and diff the registry environment sections; they should now agree on the two SSRF keys.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (recreate-after-.env-change guidance added to LLD/testing before implementation)

## Security Engineer (Cipher)

**Focus:** SSRF posture, fail-closed behavior, injection surface.

**Strengths**
- The change does not alter guard logic: default remains deny-by-default with empty allowlists; only the delivery mechanism of already-documented operator input is fixed.
- Preserves the documented invariant that the metadata address (169.254.169.254) is never allowlisted (comment copied verbatim; enforced in `url_guard`, untouched).
- Empty default keeps today's behavior byte-identical for operators who never set the variables.

**Concerns**
1. **(note) Allowlisting widens attack surface only when an operator opts in.** `SSRF_ALLOWED_HOSTS` names are operator-controlled, not request-controlled; the guard's rebinding-safe resolution still applies. No new risk introduced by this diff.
2. **(should-fix, documentation-level) Make sure the copied comment does not overpromise.** The comment says the bypass is for "internal MCP-server / A2A-agent upstreams"; since the same env now also reaches podman/prebuilt deployments unchanged, that is still accurate. No change required; verified rather than edited.
3. **(note) No secret exposure.** Both variables are non-secret allowlists; printing them via `docker compose config` in the testing plan is safe.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- None; narrowing scope (e.g. per-service allowlists) would be a guard redesign, out of scope.

**Recommendations**
- None for this diff.

**Questions for author**
- None.

**Verdict:** APPROVED

## SMTS (Sage)

**Focus:** Architecture, consistency, maintainability of the file family.

**Strengths**
- Right-sized fix: ~14 lines of YAML across two files, no abstraction, no new mechanism. The simplest design that makes the documented variables work everywhere the registry runs under Compose.
- Explicitly closes the "which files?" question with evidence: three files define `registry` (grep-verified), DHI defines none; the a2a compose files are unrelated demos. Future implementers will not wonder whether something was missed.
- File-family consistency is treated as a first-class requirement, matching how these three files have evidently been maintained (near-copy siblings).

**Concerns**
1. **(should-fix) Keep the LLD's per-file anchors verbatim-checkable.** Prose line references drift; the implementer should anchor edits on unique existing lines (`- REGISTRY_CONTACT_URL=${REGISTRY_CONTACT_URL:-}` in each file), which the LLD now does for both files.
   - **Resolution:** Both implementation steps state the unique anchor line and the relative position of neighboring lines (BUILD_VERSION comment in prebuilt); the patch review step in `testing.md` Section 6 re-checks the result with grep.
2. **(note) Consider a follow-up upstream: a tiny test asserting the three files' registry env key sets match.** Genuinely useful regression guard, but adding a new test harness for compose files exceeds this task's scope; noted as a follow-up, not a blocker.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Generating the shared registry env block from a single source (YAML anchors across files or templating): would prevent this class of drift permanently, but restructures three deployment files users copy verbatim; too invasive for a passthrough bugfix. Worth an upstream discussion.

**Recommendations**
- Land as-is; pursue the env-key-parity test as a separate upstream proposal.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (anchor discipline incorporated into the LLD before implementation)

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | None; no UI surface |
| Backend (Byte) | APPROVED WITH CHANGES | 0 | Pin prebuilt insertion anchor before the BUILD_VERSION comment |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | State the `up -d` recreate requirement for .env changes |
| Security (Cipher) | APPROVED | 0 | None; fail-closed default preserved |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | Anchor edits on unique lines; propose env-key-parity test upstream later |

No blocking findings. Three should-fix items, all documentation/anchor clarifications in the LLD, were applied before implementation; no design change was required.

**Next Steps:** Proceed to `testing.md`, then implement the two compose edits exactly as pinned in `lld.md` Steps 1-2.
