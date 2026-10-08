# Testing Plan: Reproducible Docker builds from uv lockfiles

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verify that (1) every project root installed in a Docker image has a valid, fresh `uv.lock`; (2) all four touched Dockerfiles install from the lock and fail loudly on a stale or missing lock; (3) images build and run exactly as before (same entrypoints, ports, health checks, CPU-only torch at 2.9.1); and (4) CI runs `uv lock --check` across all nine roots and catches drift.

### Prerequisites
- [ ] Docker installed and running (`docker info` succeeds)
- [ ] `uv` installed locally (tests 1.x): `uv --version`
- [ ] Working tree = this patch applied to a fresh checkout of tag `1.23.0`
- [ ] Network access to pypi.org, download.pytorch.org, and github.com (the root lock includes a git dependency)

### Shared Variables
```bash
export REPO=/tmp/swe-clone-build-docker-images-from-uv-lock/mcp-gateway-registry
cd "$REPO"
```

## 1. Functional Tests

### 1.1 Lockfile presence and freshness (CLI)

Every project root that is installed into a Docker image must pass `uv lock --check`.

```bash
for root in . auth_server servers/currenttime servers/example-server servers/fininfo servers/mcpgw servers/realserverfaketools; do
  (cd "$root" && uv lock --check >/dev/null 2>&1 && echo "OK   $root" || echo "FAIL $root")
done
```

Expected: `OK` for all seven roots. The CI matrix additionally covers `agents/a2a` and `metrics-service` (both pass).

Negative case (stale lock fails loudly):

```bash
S=$(mktemp -d); cp "$REPO/auth_server/pyproject.toml" "$REPO/auth_server/uv.lock" "$S/"
python3 - "$S" <<'EOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1], "pyproject.toml")
p.write_text(p.read_text().replace('"requests>=2.28.0",', '"requests>=999.0",'))
EOF
(cd "$S" && uv lock --check; echo "exit=$?"); rm -rf "$S"
```

Expected: uv prints `The lockfile is not up-to-date` (or equivalent) and `exit=1`.

Root-lock CPU assertion (the lock must describe a CPU-only set):

```bash
grep -c "nvidia-" "$REPO/uv.lock"        # expected: 0
grep -A2 '^name = "torch"' "$REPO/uv.lock" | grep -c "download.pytorch.org/whl/cpu"   # expected: >= 1
grep '+cpu' "$REPO/uv.lock" | head -1    # expected: version = "2.9.1+cpu" (linux marker)
```

### 1.2 Auth image build (Docker)

```bash
docker build -f docker/Dockerfile.auth -t swe3-auth:test .
```

Expected: build succeeds; the deps layer runs `uv sync --locked` (log shows uv installing the locked set; no fresh `Resolved ... packages` resolution step); no pytest/black wheels in the venv.

Assertions:

```bash
docker run --rm --entrypoint /app/.venv/bin/python swe3-auth:test -m pip list 2>/dev/null \
  | grep -Ei '^(pytest|black) ' && echo "FAIL: dev deps present" || echo "OK: no dev deps"
docker run --rm --entrypoint /app/.venv/bin/python swe3-auth:test -c "import fastapi, uvicorn; print('imports OK')"
```

### 1.3 Registry image build (Docker)

```bash
docker build -f docker/Dockerfile.registry -t swe3-registry:test .
```

Expected: build succeeds with NO separate CPU-torch pre-install layer (torch now comes from the locked sync). Torch assertions (the critical behavior-preservation check):

```bash
docker run --rm --entrypoint /app/.venv/bin/python swe3-registry:test -m pip list 2>/dev/null \
  | grep -Ei '^nvidia' && echo "FAIL: CUDA wheels present" || echo "OK: no nvidia wheels"
docker run --rm --entrypoint /app/.venv/bin/python swe3-registry:test -c "import torch; print(torch.__version__)"
docker run --rm --entrypoint /app/.venv/bin/python swe3-registry:test -c "import registry; print('registry importable')"
docker run --rm --entrypoint /app/.venv/bin/python swe3-registry:test -m pip list 2>/dev/null \
  | grep -Ei '^pytest' && echo "FAIL: dev group leaked" || echo "OK: no dev group"
```

Expected: no `nvidia-*` packages; torch version starts with `2.9.1` (CPU wheel); editable `registry` package imports; no pytest (the `--no-dev` flag worked).

### 1.4 MCP server images (Docker)

```bash
docker build -f docker/Dockerfile.mcp-server --build-arg SERVER_DIR=servers/mcpgw -t swe3-mcpgw:test .
docker build -f docker/Dockerfile.mcp-server-light --build-arg SERVER_DIR=servers/fininfo -t swe3-fininfo:test .
docker build -f docker/Dockerfile.mcp-server-light --build-arg SERVER_DIR=servers/realserverfaketools -t swe3-rsft:test .
docker build -f docker/Dockerfile.mcp-server-light --build-arg SERVER_DIR=servers/currenttime -t swe3-ct:test .
```

Expected: all four build. For mcpgw (`--inexact` must preserve the CPU torch pre-install):

```bash
docker run --rm --entrypoint /app/.venv/bin/python swe3-mcpgw:test -c "import torch; print('torch present', torch.__version__)"
docker run --rm --entrypoint /app/.venv/bin/python swe3-mcpgw:test -c "import fastmcp; print('fastmcp OK')"
```

For the light servers (plain locked sync):

```bash
docker run --rm --entrypoint /app/.venv/bin/python swe3-fininfo:test -c "import fastmcp; print('fastmcp OK')"
docker run --rm --entrypoint /app/.venv/bin/python swe3-ct:test -c "import fastmcp, pytz; print('ct OK')"
```

### 1.5 Runtime smoke (services start and answer health checks)

```bash
docker run -d --name swe3-reg swe3-registry:test
sleep 45
docker exec swe3-reg curl -fsS http://localhost:7860/health && echo "registry health OK"
docker logs swe3-reg 2>&1 | tail -5
docker rm -f swe3-reg
docker run -d --name swe3-auth swe3-auth:test
sleep 10
docker exec swe3-auth curl -fsS http://localhost:8888/health && echo "auth health OK"
docker rm -f swe3-auth
```

Expected: both health endpoints return 200 with the same response bodies as before the change (health checks and entrypoints are untouched).

### 1.6 CI lock-check workflow (GitHub Actions)

After pushing the branch: the `UV Lock Check` workflow appears in the Actions tab with 9 green matrix jobs (all repo roots). Negative case on a scratch branch:

```bash
# on a throwaway branch only:
printf '\n# drift\n' >> servers/fininfo/pyproject.toml   # any manifest edit without re-lock
git add -A && git commit -m "drift test" && git push origin HEAD:scratch/drift-test
```

Expected: the `servers/fininfo` matrix job fails with `The lockfile is not up-to-date`; the other legs stay green. Delete the branch afterward.

## 2. Backwards Compatibility Tests

- **Same build commands**: every command in 1.2-1.4 uses the exact invocations from `docker-compose.yml`, `scripts/publish_containers.sh`, and the CI workflows (no new required build-args). PASS = all builds succeed with unchanged commands.
- **Defaults preserved**: `BUILD_VERSION` still defaults to `1.0.0`; `SERVER_DIR` semantics unchanged; `docker compose build` succeeds for all Python services:

```bash
docker compose build registry auth-server currenttime fininfo realserverfaketools mcpgw-server
```

- **No dev tools in images** (matches pre-change contents): assertions in 1.2 and 1.3.
- **Entrypoints unchanged**: `docker inspect` shows the same entrypoints as before:

```bash
docker inspect -f '{{.Config.Entrypoint}}' swe3-auth:test swe3-registry:test swe3-mcpgw:test
# expected: ["/app/auth-entrypoint.sh"] ["/app/registry-entrypoint.sh"] ["/entrypoint.sh"]
```

- **Server without manifest still builds** (generic Dockerfile contract preserved; the `if [ -f /app/pyproject.toml ]` guard is kept):

```bash
M=$(mktemp -d); printf 'print("bare server")\n' > "$M/server.py"
git -C "$REPO" archive HEAD docker | tar -x -C "$M"
docker build -f "$M/docker/Dockerfile.mcp-server-light" -t swe3-bare:test "$M" && docker run --rm swe3-bare:test
rm -rf "$M"
```

Expected: builds and prints `bare server`.

- **Rollback**: reverting the patch restores the pre-change Dockerfiles verbatim (all changes are in-file; no external state).

## 3. UX Tests

**Not Applicable** - no UI or end-user-facing CLI surface changes. The only human-visible changes are Docker build log messages (uv's explicit stale-lock errors, verified in 1.1's negative case and Section 5) and the new CI workflow's matrix output (verified in 1.6).

## 4. Deployment Surface Tests

### 4.1 Docker wiring
No new parameters. Verified by 1.2-1.4 and Section 2 (`docker compose build`).

### 4.2 Terraform / ECS wiring
**Not Applicable** - ECS task definitions pull prebuilt images from public.ecr.aws; no Terraform variables change in this patch. Spot-check:

```bash
grep -r "uv pip install\|uv sync" terraform/ && echo "review needed" || echo "OK: terraform untouched"
```

### 4.3 Helm / EKS wiring
**Not Applicable** - charts reference image repositories/tags only (`charts/`); none change.

### 4.4 Deploy and verify
Out of scope for this benchmark patch; the images produced in 1.2-1.4 are drop-in replacements for the same tags (env, ports, health checks identical). ECS-side verification would be: deploy `latest` built from this commit, watch both health checks pass (paths unchanged: `/health` on 7860 registry, 8888 auth).

### 4.5 Rollback verification
```bash
git stash   # or revert the patch
docker build -f docker/Dockerfile.auth -t swe3-auth:rollback .
```
Expected: pre-change builds still work (nothing external was removed; lockfiles are additive).

## 5. End-to-End API Tests

The full user-visible workflow: edit a manifest without re-locking -> local image build fails loudly -> CI fails loudly -> the correct fix (re-lock) makes both pass.

```bash
# 1. drift the manifest (scratch copy of the repo, do not touch the real checkout)
R2=$(mktemp -d)
git -C "$REPO" archive HEAD | tar -x -C "$R2"
sed -i '' 's/"requests>=2.28.0",/"requests>=2.28.0", "itsdangerous>=99.0",/' "$R2/auth_server/pyproject.toml"
# 2. local build must FAIL in the deps layer
docker build -f "$R2/docker/Dockerfile.auth" "$R2" && echo "FAIL: stale lock accepted" || echo "OK: build failed loudly"
# 3. uv agrees
(cd "$R2/auth_server" && uv lock --check; echo "exit=$?")
# 4. correct fix: re-lock, rebuild succeeds
(cd "$R2/auth_server" && uv lock)
docker build -f "$R2/docker/Dockerfile.auth" "$R2" && echo "OK: rebuild after re-lock"
rm -rf "$R2"
```

Expected: step 2 fails with uv's stale-lock message (from `uv sync --locked`'s freshness assertion); step 3 exits 1; step 4 succeeds.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] CI workflow added under `.github/workflows/uv-lock-check.yml`
- [ ] `uv lock --check` green in all 9 roots (7 asserted by 1.1; agents/a2a and metrics-service pass)
- [ ] Torch assertions green in registry and mcpgw images (no nvidia wheels; torch imports)

Note (skill constraint): tests were designed but NOT executed as part of this benchmark run; running them is out of scope by design.
