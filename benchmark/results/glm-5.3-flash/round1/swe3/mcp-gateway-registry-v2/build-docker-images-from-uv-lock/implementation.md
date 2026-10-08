# Implementation Summary: Reproducible Docker builds from uv lockfiles

*Created: 2026-09-29*
*Baseline ref: `1.23.0` (commit `0038b687d8c3b83395d13ea199134733ee707e7f`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Docker images now install their Python dependencies from the repository's uv lockfiles instead of resolving fresh at build time. The four missing `uv.lock` files were generated (`auth_server/` plus three `servers/*` roots); the root `uv.lock` was re-sourced so torch comes from the CPU-only wheel index (pinning `torch 2.9.1+cpu` in the lock and dropping all 15 CUDA `nvidia-*`/`triton` packages); the four Python Dockerfiles were switched to `uv sync --locked` (with `--no-dev` for the registry's dev group and `--inexact` for mcpgw to preserve its CPU torch pre-install); and a new CI workflow runs `uv lock --check` in all nine project roots. Image runtime behavior is unchanged: same entrypoints, ports, health checks, CPU-only torch at the same version.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `auth_server/uv.lock` | added | +1560 / -0 | New lock (71 packages), real `uv lock` resolution; passes `uv lock --check` |
| `servers/example-server/uv.lock` | added | +924 / -0 | New lock (38 packages) |
| `servers/fininfo/uv.lock` | added | +1329 / -0 | New lock (76 packages) |
| `servers/realserverfaketools/uv.lock` | added | +1235 / -0 | New lock (75 packages) |
| `pyproject.toml` | modified | +12 / -0 | `[tool.uv.sources]` + `[[tool.uv.index]]` pinning torch to the `pytorch-cpu` index (`explicit = true`) |
| `uv.lock` | modified | +47 / -178 | Re-sourced re-lock: torch `2.9.1+cpu` from `download.pytorch.org/whl/cpu`; 14 `nvidia-*` + `triton` removed; every other pin byte-preserved (verified: no unrelated version lines in the diff) |
| `docker/Dockerfile.auth` | modified | +8 / -6 | Copies both manifests; `uv sync --locked` replaces `uv pip install --requirement` |
| `docker/Dockerfile.registry` | modified | +11 / -13 | Copies both manifests; `uv sync --locked --no-dev` replaces the CPU-torch pre-install + fresh resolve (torch now comes from the lock); editable install untouched |
| `docker/Dockerfile.mcp-server` | modified | +6 / -2 | `uv sync --locked --inexact` inside the existing `if [ -f /app/pyproject.toml ]` guard; `--inexact` so the CPU torch pre-install (outside mcpgw's lock) is not pruned |
| `docker/Dockerfile.mcp-server-light` | modified | +4 / -5 | `uv sync --locked` replaces the fresh resolve |
| `.github/workflows/uv-lock-check.yml` | added | +62 / -0 | Matrix job: `uv lock --check` in all 9 project roots; pinned checkout SHA + `astral-sh/setup-uv@v4` per repo convention |
| `.github/workflows/build-registry.yml` | modified | +1 / -0 | Path filter adds `uv.lock` (a re-lock-only change now triggers the registry image rebuild) |

Totals: 12 files, +5196 / -204. Hand-written (non-lockfile) changes: ~105 lines. `build-auth-server.yml` and `build-mcpgw.yml` need no path-filter change: their `auth_server/**` and `servers/mcpgw/**` globs already cover the new locks.

## How to Apply

```bash
git clone --branch 1.23.0 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

Verified: `git apply --check` passes against a pristine `1.23.0` worktree (`git worktree add` at `0038b68`), re-run after every patch capture.

## Deviations from the LLD
None in substance - the patch implements the revised LLD as written (CPU-torch index pin + re-sourced lock, `uv sync --locked` in all four Dockerfiles with the per-image flag variations, the nine-root CI matrix, and the registry path-filter line). Two process notes:

1. **Lockfile provenance**: the skill forbids executing the target project, so the five locks were produced by `uv lock` on scratch copies of each manifest outside the repo, then placed into the tree. The root re-lock started from the pristine baseline lock and used `uv lock --upgrade-package "torch==2.9.1"` to re-source torch without upgrading anything. Reproducibility was verified: regenerating every lock from scratch copies produces byte-identical files (checked with `cmp`), and each passes `uv lock --check`.
2. **`--locked` instead of `--frozen`**: the issue permits either; `--locked` was chosen during implementation because it fails the build when the lock is stale, which is the exact "fails loudly" requirement. The LLD was updated to match before final capture (review.md, Byte concern 3).

## Not Implemented / Follow-ups
- **New-lock vintage**: the four new locks resolve current PyPI versions (e.g. newer `pydantic`/`fastmcp` than the repo's older committed locks). These four roots previously resolved fresh at every build, so their images already floated to latest; a committed, `--check`-clean resolution is strictly more reproducible. Back-dating pins was rejected because the original resolver environment is unavailable (shallow clone, no lock history) and fabricating lock entries would be worse.
- **Root lock torch bump**: none. torch stays at 2.9.1 (re-locked with `--upgrade-package "torch==2.9.1"`); only its wheel source changed from PyPI to the CPU index.
- **`registry-cpu` / `mcp-server-cpu` Dockerfiles**: still on the fresh-resolve pattern; legacy variants not built by CI or docker-compose (LLD Non-Goals).
- **`metrics-service/Dockerfile`**: installs the project itself (`uv pip install --system -e .`) rather than deps-from-manifest; already has a lock. Migrating it to `uv sync --locked` needs different project-install semantics; follow-up.
- **Hash-pinned installs** (export with hashes + `--require-hashes`): deferred; the root manifest's git dependency (`cisco-ai-a2a-scanner`) has no hashable artifact (review.md, Cipher).
- **uv version pinning in CI/images**: follow-up (review.md, Circuit).

## Verification (not executed)
Per skill constraints the target project was neither built nor run: no `docker build`, no `uv sync` against the repo trees, no pytest. The checks a reviewer can execute are in `testing.md`. The checks that WERE performed here:

- `uv lock --check` passes in all five touched roots (four new + root), and in the four pre-existing roots (unchanged, spot-checked before any edit).
- Lock regeneration determinism: scratch-copy regeneration of all five locks is byte-identical to the committed files (`cmp` clean).
- Root lock content: `grep -c "nvidia-" uv.lock` = 0; torch entries sourced from `download.pytorch.org/whl/cpu` at `2.9.1`/`2.9.1+cpu`; full `git diff` of `uv.lock` reviewed - only CUDA removals and the torch re-source, no unrelated version changes.
- `git apply --check` of `patch.diff` against a pristine `1.23.0` worktree.
- `.dockerignore` does not exclude `uv.lock` (verified by read), so locks reach the build context.
- Entrypoints and runtime stages of all four Dockerfiles reviewed post-edit: no runtime layer touched (venv copy, entrypoint scripts, ports, health checks, `USER`, `BUILD_VERSION` all unchanged).
