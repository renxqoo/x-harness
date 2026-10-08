# Testing Plan: Pass SSRF allowlist env vars to the registry container in every compose file

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview
### Scope of Testing
Verify that `SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS` set in `.env` (or the shell) reach the registry service's container environment on every compose file that starts the registry (`docker-compose.yml`, `docker-compose.podman.yml`, `docker-compose.prebuilt.yml`), and that empty defaults preserve today's default-deny behavior.

### Prerequisites
- [ ] Docker (or Podman for `docker-compose.podman.yml`) with Compose v2 available
- [ ] A checkout of this repo at the patched state, with a `.env` prepared from `.env.example`
- [ ] For Section 5: a second container on the same compose network to act as an internal upstream

### Shared Variables
```bash
cd <repo checkout>
cp .env.example .env
# Values used across the tests below; set your own for a real run.
export SSRF_ALLOWED_HOSTS="mcpgw,upstream.internal"
export SSRF_ALLOWED_CIDRS="172.18.0.0/16"
```

## 1. Functional Tests
### 1.1 Compose rendering tests (no containers needed)
**Test 1.1.1 - default compose renders both variables**

```bash
docker compose config |
  sed -n '/^  registry:/,/^  [a-z]/p' |
  grep -E "SSRF_ALLOWED_(HOSTS|CIDRS)"
```

Expected output (values come from the exported variables):
```
      SSRF_ALLOWED_HOSTS: mcpgw,upstream.internal
      SSRF_ALLOWED_CIDRS: 172.18.0.0/16
```

**Test 1.1.2 - podman compose renders both variables**

```bash
docker compose -f docker-compose.podman.yml config |
  sed -n '/^  registry:/,/^  [a-z]/p' |
  grep -E "SSRF_ALLOWED_(HOSTS|CIDRS)"
```

Expected: same two lines as Test 1.1.1.

**Test 1.1.3 - prebuilt compose renders both variables**

```bash
docker compose -f docker-compose.prebuilt.yml config |
  sed -n '/^  registry:/,/^  [a-z]/p' |
  grep -E "SSRF_ALLOWED_(HOSTS|CIDRS)"
```

Expected: same two lines as Test 1.1.1.

**Test 1.1.4 - DHI override inherits the variables from the base file**

```bash
docker compose -f docker-compose.yml -f docker-compose.dhi.yml config |
  sed -n '/^  registry:/,/^  [a-z]/p' |
  grep -E "SSRF_ALLOWED_(HOSTS|CIDRS)"
```

Expected: same two lines as Test 1.1.1 (the override file must not erase them).

**Negative case - unset variables render empty, not "required"**

```bash
env -u SSRF_ALLOWED_HOSTS -u SSRF_ALLOWED_CIDRS docker compose -f docker-compose.prebuilt.yml config |
  grep -E "SSRF_ALLOWED_(HOSTS|CIDRS)"
```

Expected:
```
      SSRF_ALLOWED_HOSTS: ""
      SSRF_ALLOWED_CIDRS: ""
```

### 1.2 In-container environment tests
**Test 1.2.1 - registry process sees the variables (prebuilt variant)**

```bash
# .env must contain the values, then recreate so the container picks them up
SSRF_ALLOWED_HOSTS="$SSRF_ALLOWED_HOSTS" SSRF_ALLOWED_CIDRS="$SSRF_ALLOWED_CIDRS" \
  docker compose -f docker-compose.prebuilt.yml up -d registry
docker compose -f docker-compose.prebuilt.yml exec registry \
  sh -c 'env | grep SSRF_ALLOWED'
```

Expected:
```
SSRF_ALLOWED_HOSTS=mcpgw,upstream.internal
SSRF_ALLOWED_CIDRS=172.18.0.0/16
```

**Test 1.2.2 - same check on the podman variant** (run under `podman compose` or with the docker-compose.podman.yml file; expected output identical to 1.2.1).

## 2. Backwards Compatibility Tests
**Test 2.1 - empty defaults preserve default-deny**
With neither variable set (Section 1.1 negative case), confirm the guard still blocks private targets:

```bash
curl -s -X POST http://localhost/mcp/v0/servers/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serverName":"internal-only","url":"http://upstream.internal:8000/mcp"}'
```

Expected: registration/health check reports `url blocked by SSRF guard` (same as before the change).

**Test 2.2 - base compose file unchanged**
`git diff docker-compose.yml` must be empty; its env block at lines 206-207 is the template, not a target.

**Test 2.3 - no other services touched**
`git diff --stat` must list only `docker-compose.podman.yml` and `docker-compose.prebuilt.yml`.

## 3. UX Tests
**Not Applicable** - no UI, CLI output, or error-message surfaces change; the registry UI's health-check badge improves only as a consequence of env reaching the process (covered by Section 5).

## 4. Deployment Surface Tests
### 4.1 Docker wiring
Covered by Tests 1.1.1-1.1.4 and 1.2.1 (`docker compose config` renders the variables on all three files plus the DHI combination).

### 4.2 Terraform / ECS wiring
**Not Applicable** - compose-scoped change; ECS task definitions are out of scope and unchanged.

### 4.3 Helm / EKS wiring
**Not Applicable** - `charts/registry/templates/deployment.yaml` already passes both variables (lines 150-153) and is not modified.

### 4.4 Deploy and verify
```bash
# After setting values in .env, recreate the registry so the new env lands:
docker compose -f docker-compose.prebuilt.yml up -d registry
docker compose -f docker-compose.prebuilt.yml exec registry sh -c 'env | grep SSRF_ALLOWED'
```
Expected: the container env matches `.env`. Repeat with `-f docker-compose.podman.yml`.

### 4.5 Rollback verification
```bash
git checkout -- docker-compose.podman.yml docker-compose.prebuilt.yml
docker compose -f docker-compose.prebuilt.yml up -d registry
```
Expected: stack returns to pre-change behavior (variables absent from container env, guard default-deny). No volumes or state affected.

## 5. End-to-End API Tests
**Scenario - the issue's reproduction: internal docker-network upstream becomes registerable**

1. Start an internal MCP upstream on the compose network (hostname not resolvable publicly):
```bash
docker network create ssrf-e2e 2>/dev/null || true
docker run -d --name upstream.internal --network ssrf-e2e \
  registry.k8s.io/e2e-test-images/agnhost:2.53 netexec --http-port=8000
```
2. In `.env`, set `SSRF_ALLOWED_HOSTS=upstream.internal` and recreate the registry with the patched compose file:
```bash
docker compose -f docker-compose.prebuilt.yml up -d registry
```
3. Register the internal upstream and check health:
```bash
curl -s -X POST http://localhost/mcp/v0/servers/register \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serverName":"internal-upstream","url":"http://upstream.internal:8000/mcp"}'
```

Expected after the fix: registration succeeds and the health check no longer reports `url blocked by SSRF guard`.
Expected before the fix (regression baseline): health check reports `url blocked by SSRF guard` even though `SSRF_ALLOWED_HOSTS` is in `.env`.
Repeat steps 2-3 with `-f docker-compose.podman.yml` and with the default `docker-compose.yml` (which must behave identically to before - it already worked).

**CIDR variant:** clear `SSRF_ALLOWED_HOSTS`, set `SSRF_ALLOWED_CIDRS` to the compose network subnet (e.g. `172.18.0.0/16`), recreate, and confirm registration succeeds by CIDR alone.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes: variables render in `docker compose config` for all three files + DHI combo, and appear in the container env
- [ ] Section 2 (Backwards Compat) verified: empty default = default-deny; base compose and other services untouched
- [ ] Section 3 (UX) marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable (ECS/Helm not applicable by scope)
- [ ] Section 5 (E2E) passes: internal upstream registers once the allowlist is set, on every compose variant
- [ ] Patch review greps: `git diff` contains only the two compose files; in each, the inserted block sits between `- REGISTRY_CONTACT_URL=` and the next entry, and in `docker-compose.prebuilt.yml` the `# BUILD_VERSION is NOT set here` comment still directly precedes `- SECRET_KEY=`
- [ ] Unit tests added under `tests/unit/`: **Not applicable** (config-only change; repo has no compose-parsing test harness)
- [ ] Integration tests added under `tests/integration/`: **Not applicable** (same reason)
- [ ] `uv run pytest tests/` passes with no regressions (tests do not read compose files; expected unaffected)
