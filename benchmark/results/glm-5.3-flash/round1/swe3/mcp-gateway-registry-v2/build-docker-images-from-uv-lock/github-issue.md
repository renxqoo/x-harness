# GitHub Issue: Make Docker image builds reproducible by installing from uv lockfiles

## Title
Docker builds resolve dependencies at build time; generate missing uv lockfiles and install from them

## Labels
- enhancement
- build/infra
- reproducibility
- ci

## Description

### Problem Statement
The container images installed Python dependencies with
`uv pip install --requirement pyproject.toml`, which resolves dependencies
fresh at build time. Two builds of the same commit can therefore ship
different dependency versions (a new upstream release of any
loose-versioned dependency silently lands in the next image build). This
defeats the point of the `uv.lock` files the repository already maintains
and makes builds non-reproducible, image diffs unexplainable, and rollbacks
unreliable.

On top of that, several project roots that are installed inside Docker
images had no lockfile at all:

- `auth_server/` (installed by `docker/Dockerfile.auth`)
- `servers/example-server/`
- `servers/fininfo/` (installed by `docker/Dockerfile.mcp-server-light`)
- `servers/realserverfaketools/` (installed by `docker/Dockerfile.mcp-server-light`)

There was also no CI gate: a `pyproject.toml` edit without a matching
re-lock was not detected anywhere.

### Proposed Solution
Close three gaps:

1. Generate the missing `uv.lock` files so every project root installed in a
   Docker image has one.
2. Change the Python Dockerfiles to install from the lock
   (`uv sync --frozen`), so a build fails loudly when the lock does not
   match the project instead of silently resolving something new. For the
   root registry project, additionally pin `torch` to the CPU-only wheel
   index in `[tool.uv.sources]` so the lockfile itself describes what the
   image should contain (CPU torch), replacing the fragile "pre-install CPU
   torch then install the rest" two-step.
3. Add a CI workflow running `uv lock --check` in every project root so a
   stale lock fails the PR before any image build is attempted.

Images must build and run exactly as before: same entrypoints, same ports,
same runtime behavior, CPU-only torch (no CUDA packages).

### User Stories
- As a maintainer, I want image builds to install exactly the locked
  dependency versions so that two builds of the same commit are identical.
- As an operator, I want a pyproject.toml edit without a re-lock to fail CI
  so that a stale lockfile never reaches an image build.
- As a release engineer, I want lockfiles for every project root baked into
  an image so that the image contents are auditable from source control.

### Acceptance Criteria
- [ ] `auth_server/uv.lock`, `servers/example-server/uv.lock`,
      `servers/fininfo/uv.lock`, and `servers/realserverfaketools/uv.lock`
      exist and pass `uv lock --check`.
- [ ] `docker/Dockerfile.auth` installs with `uv sync --frozen` (no
      `uv pip install --requirement`).
- [ ] `docker/Dockerfile.registry` installs with `uv sync --frozen`; the
      image remains CPU-only (lockfile pins torch to the
      `pytorch-cpu` index; no `nvidia-*` packages).
- [ ] `docker/Dockerfile.mcp-server` and `docker/Dockerfile.mcp-server-light`
      install from their server lockfiles with `uv sync --frozen`
      (`--inexact` in `mcp-server` to preserve the CPU torch pre-install).
- [ ] A CI workflow runs `uv lock --check` in all nine project roots on
      every PR touching a `pyproject.toml` or `uv.lock`.
- [ ] A deliberately stale lockfile (edit `pyproject.toml`, keep old lock)
      fails the CI check.
- [ ] Images still build and run exactly as before (same commands, ports,
      health checks); torch stays pinned at 2.9.1.

### Out of Scope
- Upgrading any dependency version (torch stays at 2.9.1; only its source
  index changes).
- Converting the legacy `-cpu` Dockerfile variants
  (`docker/Dockerfile.registry-cpu`, `docker/Dockerfile.mcp-server-cpu`),
  which have no CI or compose consumers.
- The `metrics-service` image, which installs the project itself
  (`uv pip install --system -e .`) and already has a lockfile.
- Frontend/npm lockfile handling.
- Running the target repo's test suite or building the images as part of
  this change (verification is described in `testing.md`).

### Dependencies
- `uv` (already used by every affected Dockerfile and by CI via
  `astral-sh/setup-uv@v4`).

### Related Issues
- #1022
