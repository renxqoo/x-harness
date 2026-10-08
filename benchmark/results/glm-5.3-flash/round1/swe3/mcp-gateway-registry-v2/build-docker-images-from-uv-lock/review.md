# Expert Review: Reproducible Docker builds from uv lockfiles

*Created: 2026-09-29*
*Design reviewed: `./lld.md` (revised after this review) + `./github-issue.md`*

## Frontend Engineer (Pixel)

Focus: UI/UX, components, state, API integration.

### Strengths
- No frontend surface changes at all: the node build stage in `Dockerfile.registry` is untouched; the change is strictly in the Python dependency layers.
- Compose-based local dev improves: building fininfo or realserverfaketools now fails fast with an explicit uv error instead of building against silently drifted dependencies.

### Concerns
1. (Minor) A developer who edits `servers/fininfo/pyproject.toml` and forgets `uv lock` now gets a build failure where the old build silently resolved. That is the intent, but the uv error text should be discoverable. Mitigation: the Dockerfiles carry inline rationale comments, and the new CI workflow names the exact failing root.
2. (Minor) No UI impact from the workflow file or matrix; the check completes in seconds per root.

### New libraries / infra dependencies
None.

### Better alternatives considered
None from this seat.

### Recommendations
- When contributor docs are next touched, document the "edit pyproject.toml -> run uv lock" habit (follow-up).

### Questions for author
- None.

### Verdict: **APPROVED**

## Backend Engineer (Byte)

Focus: API design, data models, business logic, performance.

### Strengths
- Layer caching is preserved: manifest+lock are copied before source in every touched Dockerfile, so code-only changes still reuse the dependency layer.
- The torch problem is solved at the right layer: pinning the CPU index in the root manifest means the lock itself describes a CPU-only dependency set. Verified during design: the re-locked `uv.lock` contains zero `nvidia-*` entries and `torch 2.9.1+cpu`; the diff shows no unrelated version changes.
- Correctly distinguishes exact sync (`Dockerfile.auth`, `Dockerfile.mcp-server-light`) from `--inexact` sync (`Dockerfile.mcp-server`) based on whether a torch layer exists outside the lock.

### Concerns
1. **(Must-fix) `uv sync` prunes packages not in the lock.** In `Dockerfile.mcp-server`, the CPU torch pre-install is outside `servers/mcpgw/uv.lock` (mcpgw does not depend on torch; the copied-in `registry/` embeddings module consumes it). A plain exact sync would delete torch and break embeddings at runtime. Resolution: `--inexact` in that Dockerfile; incorporated in the revised LLD Step 5.
2. **(Must-fix) Root manifest's git dependency** (`cisco-ai-a2a-scanner @ git+...`): the locked install must not need to re-resolve it. The lock records the exact commit; the builder stage already installs `git` for the fetch at install time. Verified in the existing Dockerfile; no change needed.
3. **(Should-fix) `--frozen` vs `--locked`.** The issue allows either, but only `--locked` asserts lock freshness inside the build itself and fails loudly on a manifest/lock mismatch - the exact wording of the task. CI's `uv lock --check` is the second layer of the same guard. Resolution: `--locked` adopted everywhere; incorporated.
4. **(Should-fix) Dev group leakage.** The root manifest has a `[dependency-groups] dev` group that `uv sync` installs by default; the registry image must pass `--no-dev` to match today's contents (no pytest in prod images). The auth and server manifests have only optional extras, which sync does not install by default, so they need no flag. Incorporated as per-Dockerfile flags.
5. **(Should-fix) Version vintage of the four new locks**: they resolve current PyPI versions while the repo's existing locks are older. Not faithfully fixable (the original resolution environment is gone; back-dating would mean fabricating resolver output). Status quo for these four roots is fresh resolution at every build, so a committed, `--check`-clean resolution is strictly more reproducible. Accepted; documented in implementation.md.
6. (Minor) `uv sync` never builds the root project (`package = false` in every affected manifest), so the registry's editable install (`uv pip install -e .`) remains the sole provider of the `registry` package, exactly as today.

### New libraries / infra dependencies
None.

### Better alternatives considered
- `uv export --frozen | uv pip install -r -` with a sed filter on `^torch==` lines: keeps the old pre-install but needs a textual filter and leaves the lock recording CUDA wheels for non-Docker consumers. Superseded by the manifest-level index pin, which fixes the lock for every consumer.

### Recommendations
- Keep the per-Dockerfile comments explaining `--inexact` at the point of use (adopted).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (both must-fix items incorporated in the revised LLD)

## SRE / DevOps Engineer (Circuit)

Focus: deployment, monitoring, scaling, infrastructure.

### Strengths
- Cache strategy preserved (manifest-first COPY); CI image build times should not regress, and the registry actually drops a network-heavy torch layer.
- New workflow reuses the repo's conventions (`astral-sh/setup-uv@v4`, pinned checkout SHA, concurrency group).
- No runtime surface change: same entrypoints, ports, health checks; compose/ECS consumers see identical image behavior.

### Concerns
1. **(Must-fix) CI path filters**: the registry build workflow lists `pyproject.toml` but not `uv.lock` in its path filters, so a re-lock-only change would silently skip the registry image rebuild while the dependency layer key changes underneath. Resolution: `uv.lock` added to `build-registry.yml`; incorporated in the revised design. (`build-auth-server.yml` and `build-mcpgw.yml` use directory globs that already cover the locks.)
2. **(Should-fix) Matrix drift**: the workflow hardcodes its root list. If a new project root appears, the check silently misses it. Resolution: a maintainer comment in the workflow telling contributors to extend the matrix when adding a project root; incorporated. (Discovery via `find` was considered and rejected: the explicit list matches repo precedent in `scripts/validate-dockerfiles.sh` and keeps the workflow self-describing.)
3. **(Should-fix) uv version pinning**: `setup-uv@v4` unpinned matches the existing repo convention. A future uv major version changing lock format (locks are `revision = 3`) would fail `--check` loudly, which is the correct behavior; pinning is a documented follow-up.
4. (Minor) GHA build cache keys do not change; the first build after this lands rebuilds the dependency layer once (expected).
5. (Minor) `release-images.yml` has no path filters (tag-triggered), so it needs no edit.

### New libraries / infra dependencies
None (reuses setup-uv).

### Better alternatives considered
- Per-build-workflow lock checks instead of a dedicated workflow: duplicates the matrix in three places; rejected.
- `--build-arg UV_VERSION` pinning in images: follow-up.

### Recommendations
- Keep the maintainer comment in the workflow (adopted).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (path-filter fix incorporated)

## Security Engineer (Cipher)

Focus: AuthN/AuthZ, validation, OWASP, data protection.

### Strengths
- Closes a real supply-chain gap: today a build of a pinned commit resolves "latest matching" from PyPI, so a newly published or compromised release of any loose dependency changes image contents silently. With a locked install, the build installs exactly what the reviewed lock diff shows.
- The torch CPU-index pin also removes the multi-GB CUDA wheel set from the lock, which reduces the artifact surface from third-party indexes.
- No new packages, no new secrets; the workflow needs only `contents: read`.

### Concerns
1. **(Must-fix, documented limitation) No hash-verified installs.** `uv sync` does not verify artifacts against the lock's recorded sha256 hashes the way `uv pip install --require-hashes` would. A full fix requires exporting with hashes, which fails on the unhashable git dependency (`cisco-ai-a2a-scanner`). Resolution: accepted as a documented limitation; mitigations are (a) the lock-diff review gate, (b) the CI lock check, (c) the existing `attest-build-provenance` step in the image workflows. Recorded in the LLD rollout plan as a follow-up.
2. (Minor) `uv lock --check` in CI performs metadata reads only; no packages are installed in that workflow.
3. (Minor) The four new locks embed only `https://pypi.org/simple` URLs; the git dep stays pinned to a commit ref in the root manifest (unchanged). No new unpinned sources.
4. (Minor) The `pytorch-cpu` index is declared `explicit = true`, so only torch can come from it; no silent index redirection for other packages.

### New libraries / infra dependencies
None.

### Better alternatives considered
- `--require-hashes` installs: strictly stronger; deferred because of the git dep (see above).
- `pip-audit` in the new workflow: valuable, separate concern; follow-up.

### Recommendations
- Track hash-pinned installs and pip-audit as follow-ups in the rollout plan (done).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES** (hash limitation documented; no code change required)

## SMTS (Sage)

Focus: architecture, code quality, maintainability.

### Strengths
- The design extends the repo's real convention (one lock per project root, `package = false`, no workspace) instead of inventing a new mechanism.
- The hard part (torch channel) is solved in the manifest rather than worked around in the Dockerfile, so the lock is truthful for every consumer, not just Docker. That is the difference between a pin and a filter.
- Fail-loud by construction: missing/stale lock aborts the build in the dependency layer before any source is copied, and CI catches it even earlier.

### Concerns
1. **(Must-fix) Design/code parity**: the LLD is the plan of record; the implementation must match it exactly, and any deviation discovered while implementing must loop back into the LLD before capture. Resolution: enforced by self-review; the patch and LLD were cross-checked after capture.
2. **(Should-fix) Two sync idioms** (exact vs `--inexact`) is a maintainability cost. Justified by image contents, but the "why" must live in the Dockerfile comments at the point of use, or a future simplification will silently prune torch from mcpgw or reintroduce CUDA. Resolution: comments are part of the implementation steps; verified present in the patch.
3. **(Should-fix) Lock vintage**: the four new locks are a newer vintage than the repo's existing locks. Must be stated plainly in the docs rather than implied away. Resolution: stated in LLD constraints and implementation.md deviations.
4. (Minor) Keeping the `if [ -f /app/pyproject.toml ]` guard in the generic server Dockerfiles preserves the contract that servers without manifests still build.
5. (Minor) `--locked` over `--frozen` is the right call: the freshness assertion inside the build is the feature the issue asks for; CI is the backstop, not the substitute.

### New libraries / infra dependencies
None.

### Better alternatives considered
- A uv workspace unifying all roots: cleaner long-term, but re-keys every lock and changes contributor workflow; rejected for this patch, sensible follow-up epic.
- Back-dating the new locks to the old vintage: rejected as fabrication.

### Recommendations
- Keep the torch-index follow-up (retiring nothing today; the pin already made the filter approach unnecessary) visible in the rollout plan.
- Keep the maintainer comment in the lock-check workflow matrix (adopted).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES**

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | Document the `uv lock` habit in contributor docs next time they are touched |
| Backend (Byte) | APPROVED WITH CHANGES | 2 (both incorporated) | `--inexact` for mcpgw; verify git dep installs from lock without re-resolution; `--locked` over `--frozen` |
| SRE (Circuit) | APPROVED WITH CHANGES | 1 (incorporated) | `uv.lock` in build-registry.yml path filters; maintainer comment in the matrix; uv pinning follow-up |
| Security (Cipher) | APPROVED WITH CHANGES | 1 (documented limitation) | Hash-verified installs deferred (git dep unhashable); keep limitation documented; pip-audit follow-up |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 (process, resolved) | LLD/code parity enforced in self-review; per-Dockerfile "why" comments; lock vintage stated plainly |

**No blocking findings remain unaddressed; proceeding to implementation.** Disposition of every blocker:

- mcpgw `--inexact`: incorporated (LLD Step 5; patch `docker/Dockerfile.mcp-server`).
- Registry path filter: incorporated (`build-registry.yml` gains `uv.lock`).
- Git dependency: verified in design (lock pins the commit; builder installs git).
- Hash enforcement: deferred with rationale (rollout plan Phase 3; documented limitation).
- LLD/code parity: enforced in self-review after patch capture.

## Next Steps
1. Write testing.md against the revised LLD.
2. Implement the four Dockerfile edits, the manifest index pin, the re-sourced root lock, four new lockfiles, one new workflow, and the registry path-filter line.
3. Capture patch.diff; document the lock-vintage deviation in implementation.md.
