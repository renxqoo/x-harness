# Low-Level Design: Reproducible Docker builds from uv lockfiles

*Created: 2026-09-29*
*Author: glm-5.3-flash (swe3 single-agent run)*
*Status: Draft (revised after expert review)*

## Table of Contents
1. [Overview](#overview)
2. [Codebase Analysis](#codebase-analysis)
3. [Architecture](#architecture)
4. [Data Models](#data-models)
5. [API / CLI Design](#api--cli-design)
6. [Configuration Parameters](#configuration-parameters)
7. [New Dependencies](#new-dependencies)
8. [Implementation Details](#implementation-details)
9. [Observability](#observability)
10. [Scaling Considerations](#scaling-considerations)
11. [File Changes](#file-changes)
12. [Testing Strategy](#testing-strategy)
13. [Alternatives Considered](#alternatives-considered)
14. [Rollout Plan](#rollout-plan)

## Overview

### Problem Statement
Docker builds resolve dependencies at build time instead of installing from the repository's uv lockfiles. `docker/Dockerfile.auth`, `docker/Dockerfile.registry`, `docker/Dockerfile.mcp-server`, and `docker/Dockerfile.mcp-server-light` all install with `uv pip install --requirement pyproject.toml`, so two builds of the same commit can ship different dependency versions. Four project roots that are installed into Docker images have no lockfile at all: `auth_server/`, `servers/example-server/`, `servers/fininfo/`, `servers/realserverfaketools/`. Nothing in CI verifies lock freshness, so a `pyproject.toml` edit without a re-lock goes undetected.

### Goals
- Every project root that is installed into a Docker image has a committed `uv.lock` that passes `uv lock --check`.
- Image installs come from the lock via `uv sync --locked` (which fails the build when the lock does not match the manifest), never from a fresh resolve.
- A CI workflow runs `uv lock --check` in every Python project root and fails the build on a stale or missing lock.
- Images build and run exactly as before: same entrypoints, ports, health checks, and CPU-only torch (no CUDA `nvidia-*` wheels). torch stays at 2.9.1.

### Non-Goals
- Upgrading any dependency version anywhere (the re-lock preserves existing pins; only torch's source index changes).
- Converting the legacy `docker/Dockerfile.registry-cpu` and `docker/Dockerfile.mcp-server-cpu` variants (no CI or docker-compose consumers; noted as follow-up).
- Changing `metrics-service` (installs itself with `uv pip install --system -e .`, already has a lock, outside the named build path).
- Pinning the `uv` version inside images (follow-up hardening).
- Making builds fully offline / vendored.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `docker/Dockerfile.auth` | Auth-server image from `auth_server/` | Installs with `uv pip install --requirement pyproject.toml` (line 26); deps layer copies only `pyproject.toml`. Primary target. |
| `docker/Dockerfile.registry` | Registry image from repo root | Pre-installs CPU torch from `download.pytorch.org/whl/cpu` (lines 37-40), then fresh-resolves the rest (line 48), then editable install (line 58). Runtime copies `.venv` + `pyproject.toml` from the builder. |
| `docker/Dockerfile.mcp-server` | Generic MCP-server image (CI builds `servers/mcpgw` with it) | Fresh-resolve pattern inside an `if [ -f /app/pyproject.toml ]` guard; pre-installs CPU torch; supports `SERVER_DIR` build arg. |
| `docker/Dockerfile.mcp-server-light` | Light MCP-server image (currenttime, fininfo, realserverfaketools in docker-compose and publish_containers.sh) | Same fresh-resolve pattern, no torch layer. |
| `pyproject.toml` (root) | Root manifest; `requires-python >=3.14`, ~50 runtime deps including a git dependency and `litellm==1.83.0`; `[tool.uv] package = false`; a `[dependency-groups] dev` group | The lock source for the registry image. Not a uv workspace (no `[tool.uv.workspace]`), so each sub-project locks independently. |
| `auth_server/pyproject.toml` | Auth manifest, 18 runtime deps, `package = false`, optional dev extras | Needs a new lock. |
| `servers/{example-server,fininfo,realserverfaketools}/pyproject.toml` | Server manifests, 4-6 deps each, `package = false` | Need new locks. |
| Root `uv.lock` (existing) | 235 packages; resolves `torch 2.9.1` from PyPI with 14 `nvidia-*` CUDA packages plus `triton` (linux x86_64 markers) | Proof that a plain frozen sync against it would bloat the registry image by gigabytes; must be re-sourced to the CPU index. |
| `servers/currenttime/uv.lock`, `servers/mcpgw/uv.lock`, `agents/a2a/uv.lock`, `metrics-service/uv.lock` | Existing committed locks, `version = 1`, `revision = 3`, `requires-python = ">=3.14"` | Prove the per-root locking convention; new locks follow it. |
| `.github/workflows/build-{auth-server,registry,mcpgw}.yml`, `release-images.yml` | Image CI | Repo-root build contexts; path filters (`auth_server/**`, `servers/mcpgw/**`) already cover new lockfiles. |
| `.github/workflows/{registry,auth-server,metrics-service}-test.yml` | Test workflows | House CI convention: `astral-sh/setup-uv@v4`, `uv sync`, pinned `actions/checkout` SHA. |
| `docker-compose.yml` | Local compose builds | Builds exactly the four Dockerfiles this change touches, with `SERVER_DIR` for the servers. |
| `scripts/publish_containers.sh` | Release builds | Confirms the same four image paths are the supported set; `-cpu` variants absent. |
| `.dockerignore` | Build-context pruning | Contains no `uv.lock` exclusion (verified by grep), so locks reach the build context. |
| Entrypoints (`docker/auth-entrypoint.sh`, `docker/registry-entrypoint.sh`) | Runtime startup | Neither invokes `uv` at runtime; the change is build-time only, so runtime behavior is untouched. |

### Existing Patterns Identified
1. **One lock per project root**: locks are committed next to each `pyproject.toml` that has one, all with `version = 1`, `revision = 3`, `requires-python = ">=3.14"`.
   - Files: `uv.lock`, `servers/currenttime/uv.lock`, `servers/mcpgw/uv.lock`, `agents/a2a/uv.lock`, `metrics-service/uv.lock`
   - How a future implementer should follow this: add the new `uv.lock` files next to the existing manifests; do not introduce a uv workspace.
2. **Deps-first COPY for layer caching**: multi-stage Dockerfiles copy the dependency manifests before the source so the dependency layer rebuilds only when manifests change.
   - Files: `docker/Dockerfile.auth` (lines 21-26), `docker/Dockerfile.registry` (lines 42-48)
   - How a future implementer should follow this: keep the two-phase copy; `uv sync` needs `pyproject.toml` + `uv.lock`, so cache granularity is preserved by copying both.
3. **CPU-torch pre-install**: registry and mcp-server images install CPU torch from `https://download.pytorch.org/whl/cpu` before the main install so the CUDA build never lands.
   - Files: `docker/Dockerfile.registry` (lines 36-40), `docker/Dockerfile.mcp-server` (lines 36-40)
   - How a future implementer should follow this: preserve the CPU-only property; for the registry this design moves the pin into the lockfile itself and deletes the pre-install; for mcpgw it keeps the pre-install and protects it with `--inexact`.
4. **CI setup-uv convention**: workflows install uv via `astral-sh/setup-uv@v4` and pin `actions/checkout` by SHA.
   - Files: `.github/workflows/registry-test.yml` (line 44), `auth-server-test.yml` (line 45), `metrics-service-test.yml` (line 43)
   - How a future implementer should follow this: the new lock-check workflow uses the same action and the same pinned checkout SHA the image workflows use.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `docker/Dockerfile.auth` | Extends | Installs `auth_server` deps from the new `auth_server/uv.lock`. |
| `docker/Dockerfile.registry` | Extends | Installs root deps from the re-sourced root `uv.lock`; torch now comes from the lock (CPU index), replacing the pre-install step. |
| `docker/Dockerfile.mcp-server` (mcpgw) | Extends | Installs `servers/mcpgw` deps from its existing lock; `--inexact` protects the CPU torch pre-install. |
| `docker/Dockerfile.mcp-server-light` (currenttime, fininfo, realserverfaketools) | Extends | Installs each server's deps from its lock (three locks are new; currenttime's exists). |
| `.github/workflows/uv-lock-check.yml` | New | Matrix job over all nine Python project roots. |
| Editable registry install (`uv pip install -e .`) | Unchanged | Root project is `package = false`, so `uv sync` never builds the project; the editable step keeps providing `registry/` on the path. |
| `docker-compose.yml` / `scripts/publish_containers.sh` | Consumers | Same invocation as before; no flags or contexts change. |

### Constraints and Limitations Discovered
- **Root lock resolved CUDA torch**: the committed root lock pulled `torch 2.9.1` from PyPI, which on linux x86_64 carries 14 `nvidia-*` wheels and `triton` (multi-GB). A naive `uv sync --locked` would have regressed the registry image to CUDA. The design pins torch to the CPU index in the manifest so the lock itself describes a CPU-only dependency set; verified: re-locked root lock contains zero `nvidia-*` entries and `torch 2.9.1+cpu`.
- **`uv sync` makes the venv match the lock exactly**: it removes packages not in the lock. In `Dockerfile.mcp-server` the CPU torch pre-install is intentionally outside the server's lock (mcpgw does not depend on torch; the copied-in `registry/` embeddings module needs it), so that Dockerfile must pass `--inexact` to keep it. All other images either have torch inside the lock (registry) or no torch at all (auth, light servers).
- **Dev dependency group**: the root manifest declares a `[dependency-groups] dev` group, which `uv sync` installs by default. The registry image must pass `--no-dev` to keep pytest/factory-boy/etc. out, matching today's contents. The auth and server manifests have only optional extras (not installed by default), so they need no flag.
- **Git dependency in the root manifest** (`cisco-ai-a2a-scanner @ git+...`): the root lock contains a git-sourced package; the registry builder stage already installs `git`, so the locked install resolves it the same way the old fresh resolve did.
- **Version drift from re-locking the root**: re-locking with the CPU index bump-free (`uv lock --upgrade-package "torch==2.9.1"`) preserved every existing pin except the CUDA packages that no longer have markers to satisfy; verified via `git diff` that no unrelated version changed. The four new locks resolve current PyPI versions; that is strictly more reproducible than the status quo for those roots, which floated freely at build time.
- **`requires-python = ">=3.14"`**: images use `python:3.14-slim` and `uv venv --python 3.14`; `uv sync` targets the pre-created `.venv` in `/app`.

## Architecture

### System Context Diagram
```
                      repo root (build context = .)
                                 |
       +-------------------------+---------------------------+
       |                         |                           |
 auth_server/              root project              servers/* (SERVER_DIR)
  pyproject.toml           pyproject.toml            */pyproject.toml
  uv.lock (NEW)            uv.lock (re-sourced       uv.lock (3 NEW,
       |                  to CPU torch index)         1 exists)
       v                         |                           v
 Dockerfile.auth                 v                    Dockerfile.mcp-server (mcpgw)
  uv sync --locked        Dockerfile.registry           uv sync --locked --inexact
       |                   uv sync --locked --no-dev   (keeps CPU torch layer)
       |                         |                           |
       +------------+------------+--------------+------------+
                    v                           v
          images ship exactly the locked, CPU-only dependency sets
                    |
                    v
   .github/workflows/uv-lock-check.yml (NEW)
     uv lock --check in all 9 project roots on every PR
```

### Sequence Diagram
```
Image build (auth example):
  COPY auth_server/pyproject.toml + uv.lock -> /app/
  RUN uv sync --locked
       |-- lock matches manifest -> install exactly locked versions
       |-- lock stale or missing -> uv exits nonzero -> BUILD FAILS LOUDLY

Root re-lock (one time, in this change):
  add [tool.uv.sources] torch -> pytorch-cpu index in pyproject.toml
  uv lock -> torch 2.9.1+cpu recorded, all nvidia-* entries dropped

CI (every PR touching any manifest or lock):
  checkout -> setup-uv -> matrix over 9 roots: uv lock --check
       |-- stale/missing lock -> job fails before any image build
```

### Component Diagram
```
[pyproject.toml] --[tool.uv.sources: torch -> pytorch-cpu]--> [uv.lock (CPU torch)]
      |                                        |
      +--> uv lock --check (CI, 9 roots)       +--> uv sync --locked (4 Dockerfiles)
```

## Data Models

No application data models change. The only new artifacts are lockfiles:

| File | Format | Packages | Produced By |
|------|--------|----------|-------------|
| `auth_server/uv.lock` | uv lock v1, revision 3, `requires-python = ">=3.14"` | 71 | `uv lock` in `auth_server/` |
| `servers/example-server/uv.lock` | same format | 38 | `uv lock` in `servers/example-server/` |
| `servers/fininfo/uv.lock` | same format | 76 | `uv lock` in `servers/fininfo/` |
| `servers/realserverfaketools/uv.lock` | same format | 75 | `uv lock` in `servers/realserverfaketools/` |
| `uv.lock` (root, modified) | same format | 220 (was 235) | `uv lock` after adding the CPU torch source; every existing pin preserved, 15 CUDA packages removed, `torch 2.9.1+cpu` added |

Every affected project is `[tool.uv] package = false`, so `uv sync --locked` installs only third-party dependencies and never builds the project itself.

## API / CLI Design

No new endpoints or user-facing CLI. The changed build/developer surface:

**Docker build (invocations unchanged):**
```bash
docker build -f docker/Dockerfile.auth .
docker build -f docker/Dockerfile.registry .
docker build -f docker/Dockerfile.mcp-server --build-arg SERVER_DIR=servers/mcpgw .
docker build -f docker/Dockerfile.mcp-server-light --build-arg SERVER_DIR=servers/fininfo .
```

**Lock maintenance (new habit for maintainers):**
```bash
cd auth_server && uv lock && git add uv.lock   # after editing auth_server/pyproject.toml
```

**New CI command per root:** `uv lock --check` (exit 1 when the lock is missing or not up to date).

**Error Cases:**
- Lock missing in the build context: `uv sync --locked` fails with "Unable to find lockfile"; the build fails loudly (desired).
- Manifest edited without re-lock: `uv sync --locked` and `uv lock --check` fail with the lockfile-not-up-to-date error and a `run uv lock` hint; the build fails loudly (desired).

## Configuration Parameters

### New Environment Variables
None. No runtime configuration changes; the change is build-time only.

### Settings / Config Class Updates
None.

### Deployment Surface Checklist
No new parameters on any surface. Deployment surfaces that must keep working unchanged (verified in testing.md):
- [ ] `docker-compose.yml` (four build stanzas, unchanged)
- [ ] `docker-compose.dhi.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml` (image consumers, unchanged)
- [ ] `.github/workflows/build-{registry,auth-server,mcpgw}.yml` and `release-images.yml` (path filters already cover `**` lockfile additions; verified)
- [ ] `terraform/aws-ecs` (pulls prebuilt images; unaffected)

## New Dependencies
This change uses only existing dependencies: `uv` (already installed in every touched image) and `astral-sh/setup-uv@v4` (already the CI convention). The new `download.pytorch.org/whl/cpu` index declaration in the root manifest codifies an index the Dockerfiles were already using.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Generate the four missing lockfiles
**Files:** `auth_server/uv.lock`, `servers/example-server/uv.lock`, `servers/fininfo/uv.lock`, `servers/realserverfaketools/uv.lock` (all new)

```bash
cd auth_server && uv lock && cd ..
cd servers/example-server && uv lock && cd ../..
cd servers/fininfo && uv lock && cd ../..
cd servers/realserverfaketools && uv lock && cd ../..
```

Each directory must then pass `uv lock --check`. None of these four manifests depends on torch, so no index pinning is needed for them. `.gitignore` does not exclude `uv.lock` (verified), so the files are committable.

#### Step 2: Pin CPU torch in the root manifest and re-source the root lock
**File:** `pyproject.toml` (in the `[tool.uv]` section, around line 171)

```toml
[tool.uv.sources]
torch = { index = "pytorch-cpu" }

[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true
```

Then re-lock without upgrading anything:

```bash
git checkout uv.lock               # discard the first (upgrading) attempt if made
uv lock --upgrade-package "torch==2.9.1"
uv lock --check                    # must pass
```

Verification performed for this design:
- `git diff uv.lock` shows only: 15 removed packages (all `nvidia-*` plus `triton`), the torch entry re-sourced to `https://download.pytorch.org/whl/cpu` as `2.9.1` (darwin) / `2.9.1+cpu` (other platforms). Zero unrelated version changes.
- `grep -c "nvidia-" uv.lock` returns 0 after the re-lock (was 14+ markers and wheels before).

This single manifest change is what makes a plain frozen sync safe for the registry image: the lock now describes exactly what the image should contain.

#### Step 3: Switch `docker/Dockerfile.auth` to the lock
**File:** `docker/Dockerfile.auth` (lines ~21-28)

```dockerfile
# Copy ONLY the dependency manifests first to leverage Docker layer caching.
# Dependencies are reinstalled only when the manifests change, not on every code change.
COPY auth_server/pyproject.toml auth_server/uv.lock /app/

# Install exactly the locked dependency versions. --locked fails the build
# when uv.lock is out of sync with pyproject.toml instead of silently
# resolving fresh (and possibly different) versions.
RUN uv sync --locked
```

Notes:
- `--locked` asserts the lock is up to date with the manifest (fails otherwise) and then installs without re-resolving. This is the issue's "fails loudly" requirement, one notch stricter than `--frozen` (which skips the freshness check).
- No `--no-dev` needed: the auth manifest has only optional extras, which `uv sync` does not install by default.
- No `--no-install-project` needed: `auth_server` is `[tool.uv] package = false`, so sync installs only third-party deps, matching the old `uv pip install --requirement pyproject.toml` behavior. The runtime stage's `COPY auth_server/ /app/` continues to ship the source.
- `uv sync` targets `/app/.venv`, the venv created two layers earlier; the runtime stage still copies `/app/.venv` out of the builder. No downstream layer changes.

#### Step 4: Switch `docker/Dockerfile.registry` to the lock and drop the torch pre-install
**File:** `docker/Dockerfile.registry` (lines ~36-46)

```dockerfile
# Copy ONLY the dependency manifests to leverage Docker layer caching.
# This layer only rebuilds when pyproject.toml or uv.lock change.
COPY pyproject.toml uv.lock /app/

# Install exactly the locked dependency versions in one step. torch comes
# from the CPU-only wheel index pinned in pyproject.toml, so the image
# stays CPU-only without a separate pre-install step. --locked fails the
# build when uv.lock is out of sync with pyproject.toml instead of
# silently resolving fresh (and possibly different) versions. --no-dev
# keeps the dev dependency group (pytest, etc.) out of the image.
RUN uv sync --locked --no-dev
```

The old "Install CPU-only PyTorch first" `RUN` block is deleted: torch (2.9.1+cpu, with the CPU index recorded in the lock) is now installed as part of the single locked sync. The editable install step (`RUN . .venv/bin/activate && uv pip install -e .`) and every later layer are unchanged. Net effect on the builder: one fewer network-heavy layer, strictly pinned versions, and the CUDA package set structurally cannot reappear (it is not in the lock).

#### Step 5: Switch `docker/Dockerfile.mcp-server` (mcpgw) to the lock, preserving the torch layer
**File:** `docker/Dockerfile.mcp-server` (lines ~69-77)

```dockerfile
# Install dependencies from the lockfile (copied from SERVER_DIR). --locked
# fails the build when uv.lock is out of sync with pyproject.toml instead of
# silently resolving fresh (and possibly different) versions. --inexact keeps
# the CPU-only torch pre-installed above, which is required by the registry
# embeddings module but is not part of the server's own lockfile.
RUN . .venv/bin/activate && \
    if [ -f /app/pyproject.toml ]; then \
        uv sync --locked --inexact; \
    fi
```

Why `--inexact`: plain `uv sync` removes any package not in the lock, which would strip the CPU torch pre-installed earlier in this Dockerfile (mcpgw's own manifest has no torch dependency; the torch consumer is the `registry/` module copied in for embeddings support). `--inexact` installs the locked set without removing extras, matching the old `uv pip install` semantics. `servers/mcpgw/uv.lock` already exists and passes `--check`; its copy arrives via the existing `COPY ${SERVER_DIR:-.}/ /app/` layer, so no new COPY line is needed.

#### Step 6: Switch `docker/Dockerfile.mcp-server-light` to the lock
**File:** `docker/Dockerfile.mcp-server-light` (lines ~47-50)

```dockerfile
# Install dependencies from the lockfile. --locked fails the build when
# uv.lock is out of sync with pyproject.toml instead of silently resolving
# fresh (and possibly different) versions.
RUN uv sync --locked
```

These images have no torch layer, so the strict exact sync is safe. The server directory COPY (`${SERVER_DIR:-.}/ /app/`) already ships `pyproject.toml` + `uv.lock` (for fininfo and realserverfaketools the lock is new; for currenttime it exists). Like auth, no dev-group or project flags are needed (optional extras only, `package = false`).

#### Step 7: Add the lock-check CI workflow
**File:** `.github/workflows/uv-lock-check.yml` (new)

Follows the house conventions observed in `metrics-service-test.yml` / `registry-test.yml`: `astral-sh/setup-uv@v4`, and the same pinned `actions/checkout` SHA used by the image workflows (`de0fac2e...` # v6.0.2). Path filters limit runs to PRs that touch a manifest, a lock, or the workflow itself. The matrix covers all nine Python project roots (the issue says "each project root"); the two roots outside the Docker path (`agents/a2a`, `metrics-service`) already have green locks, so including them costs nothing and prevents future drift.

```yaml
name: UV Lock Check

on:
  push:
    branches: [main]
    paths: ['**/pyproject.toml', '**/uv.lock', '.github/workflows/uv-lock-check.yml']
  pull_request:
    branches: [main]
    paths: ['**/pyproject.toml', '**/uv.lock', '.github/workflows/uv-lock-check.yml']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lock-check:
    name: "uv lock --check (${{ matrix.project }})"
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        project:
          - '.'
          - auth_server
          - agents/a2a
          - metrics-service
          - servers/currenttime
          - servers/example-server
          - servers/fininfo
          - servers/mcpgw
          - servers/realserverfaketools
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - name: Install uv
        uses: astral-sh/setup-uv@v4
      - name: Check lockfile is up to date
        run: uv lock --check
        working-directory: ${{ matrix.project }}
```

### Error Handling
- Every failure mode surfaces as a nonzero exit in the layer that caused it: missing lock ("Unable to find lockfile"), stale lock ("the lockfile is not up-to-date ... run `uv lock`"), unreachable git dependency (same as the old fresh resolve).
- CI fails the specific matrix leg whose root drifted, naming the exact directory.

### Logging
- Build logs print uv's own output; a stale lock prints the explicit remediation hint, which is the "fails loudly" requirement. No additional logging added.

## Observability
- CI: the new `UV Lock Check` workflow gives per-root pass/fail visibility on every manifest/lock PR; a red leg names the drifting root before any image build runs.
- Images: `uv pip freeze` inside a built image now equals the lock; two builds of one commit cannot differ, which is the observable guarantee. Image size stays CPU-only (no `nvidia-*` wheels), verifiable with `uv pip freeze | grep -c nvidia` = 0 inside the registry image.

## Scaling Considerations
- Layer caching is preserved or improved: manifest+lock copies stay ahead of source copies, and the registry drops an entire torch-download layer from cache invalidation consideration (torch changes only when the lock changes).
- The freshness assertion of `--locked` adds a sub-second check per build; negligible against the 30-45 minute CI timeouts.
- Lockfiles are text (largest new one ~1,560 lines / ~150 KB); repo size impact is trivial.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `auth_server/uv.lock` | Lock for the auth server image deps (71 packages) |
| `servers/example-server/uv.lock` | Lock for the example server (38 packages) |
| `servers/fininfo/uv.lock` | Lock for fininfo (76 packages) |
| `servers/realserverfaketools/uv.lock` | Lock for realserverfaketools (75 packages) |
| `.github/workflows/uv-lock-check.yml` | CI matrix running `uv lock --check` in all 9 project roots |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `pyproject.toml` | ~171-186 | Add `[tool.uv.sources]` + `[[tool.uv.index]]` pinning torch to the CPU wheel index |
| `uv.lock` | re-generated | torch re-sourced to CPU index (2.9.1+cpu), 15 CUDA packages removed, all other pins unchanged |
| `docker/Dockerfile.auth` | ~21-28 | COPY both manifests; `uv sync --locked` replaces `uv pip install --requirement` |
| `docker/Dockerfile.registry` | ~36-46 | COPY both manifests; `uv sync --locked --no-dev` replaces the torch pre-install + fresh resolve |
| `docker/Dockerfile.mcp-server` | ~69-77 | `uv sync --locked --inexact` inside the existing guard |
| `docker/Dockerfile.mcp-server-light` | ~47-50 | `uv sync --locked` replaces the fresh resolve |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New hand-written code (Dockerfile edits + workflow) | ~105 |
| New lockfiles (generated) | ~5,050 |
| New tests | 0 (the CI workflow is the check; see testing.md) |
| Modified code (manifest + re-sourced lock) | ~60 |
| **Total (hand-written)** | **~165** |

## Testing Strategy
See `testing.md` for the full plan: per-image build + run checks, stale-lock negative tests (build and CI), the `uv lock --check` matrix, torch-channel assertions (`uv pip freeze` inside the registry image shows CPU torch and zero `nvidia-*` wheels), and backwards-compat checks (same entrypoints, ports, health checks, compose flows).

## Alternatives Considered

### Alternative 1: `uv export --frozen | uv pip install -r -` with a torch-line filter
**Description:** Keep the torch pre-install in the torch images, export the lock to requirements.txt at build time, delete the `torch==` lines with sed, and pip-install the rest over the pre-installed torch.
**Pros / Cons:** No manifest change / keeps two install mechanisms, needs a textual filter whose safety depends on the lock's line format, and the lock still records CUDA wheels for non-Docker consumers.
**Why Rejected:** Pinning the index in the manifest achieves the same image contents with one install mechanism and fixes the lock for every consumer, not just Docker.

### Alternative 2: Plain `uv sync --frozen` everywhere against the unmodified root lock
**Description:** One command in every Dockerfile; let the lock decide torch (PyPI, CUDA on linux).
**Pros / Cons:** Simplest possible Dockerfiles / installs the CUDA wheel set into every registry image (multi-GB bloat) and contradicts the images' explicit CPU-only design.
**Why Rejected:** "Images must still build and run exactly as before" - image size and wheel channel are behavior.

### Alternative 3: `--frozen` instead of `--locked`
**Description:** Use `uv sync --frozen`, which installs from the lock without checking whether the lock is up to date.
**Pros / Cons:** Marginally faster / silently installs a stale lock's versions when someone edits the manifest and forgets to re-lock, which is precisely the failure mode the issue asks to eliminate.
**Why Rejected:** `--locked` provides the loud-failure semantics the task requires; the CI lock-check is the second layer of the same guard, not a substitute.

### Comparison Matrix

| Criteria | Chosen (CPU-torch lock + `uv sync --locked`) | Alt 1 (export + filter) | Alt 2 (plain sync, PyPI torch) | Alt 3 (`--frozen`) |
|----------|----------------------------------------------|--------------------------|-------------------------------|--------------------|
| Reproducible | Yes | Yes | Yes | Yes, but can ship stale lock |
| Fails loudly on stale lock | Yes (`--locked` + CI) | Partially | Partially | No |
| Image stays CPU-only | Yes (in the lock) | Yes (via filter) | No (+GB CUDA) | Yes |
| Single install mechanism | Yes | No | Yes | Yes |
| Scope of manifest change | One index pin | None | None | None |

## Rollout Plan
- Phase 1: Land locks + Dockerfile changes + workflow (this patch). `UV Lock Check` goes green on the nine roots.
- Phase 2: The next `pyproject.toml` edit in any root demonstrates the guard (forgetting `uv lock` fails CI and the image build with an explicit remediation message).
- Phase 3 (follow-ups): convert the legacy `-cpu` Dockerfile variants; pin the `uv` version in images; consider hash-verified installs (requires solving the unhashable git dep); migrate `metrics-service/Dockerfile` to `uv sync --locked` (needs `--no-install-project` semantics vs its current `pip install -e .` flow).

## Open Questions
- None. The version-drift question (new locks resolving current PyPI versions) is settled: those roots floated freely at build time before, so a committed, check-clean resolution is strictly more reproducible; documented in implementation.md.

## References
- uv CLI: `uv lock`, `uv lock --check`, `uv sync --locked`, `uv sync --inexact`, `uv lock --upgrade-package <spec>`
- uv index pinning: `[tool.uv.sources]` + `[[tool.uv.index]]` with `explicit = true`
- Upstream issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1022
- Existing per-root locks in this repo (`uv.lock`, `servers/currenttime/uv.lock`, `servers/mcpgw/uv.lock`)
