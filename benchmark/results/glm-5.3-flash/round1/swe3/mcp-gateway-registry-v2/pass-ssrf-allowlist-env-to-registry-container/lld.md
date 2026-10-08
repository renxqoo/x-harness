# Low-Level Design: Pass SSRF allowlist env vars to the registry container in every compose file

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft*

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
The registry's SSRF guard (`registry/utils/url_guard.py`) reads two operator-facing allowlist variables, `SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS`, via pydantic settings (`registry/core/config.py:591-611`, field names `ssrf_allowed_hosts` / `ssrf_allowed_cidrs`, no env prefix). They are documented in `.env.example` (lines 1184-1189) and in `docs/unified-parameter-reference.md` (lines 801-802).

Of the three compose files that define a `registry` service, only the default `docker-compose.yml` declares these variables in the service `environment:` block (lines 206-207). The other two do not:

- `docker-compose.podman.yml` - registry service environment block, lines ~47-141
- `docker-compose.prebuilt.yml` - registry service environment block, lines ~57-160

Docker Compose does not forward host environment or `.env` values into a container unless the service declares them, so on podman and prebuilt deployments the settings are silently inert: the registry process never sees them. An operator who sets `SSRF_ALLOWED_HOSTS=myserver` in `.env` and registers `http://myserver:8000/mcp` (a docker-network hostname) still gets `url blocked by SSRF guard` from the health checker. The only workaround is hand-editing the compose file, which is exactly what the documented `.env` variables are supposed to avoid.

### Goals
- Make `SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS` from `.env` reach the registry container on every compose deployment that starts the registry.
- Keep the three compose files consistent: same passthrough syntax, same comment, same placement style as the existing block in `docker-compose.yml`.
- Change nothing else: no guard logic, no docs, no chart, no unrelated services.

### Non-Goals
- Changing SSRF guard behavior, defaults, or parsing (`registry/utils/url_guard.py` is untouched).
- Helm chart changes (`charts/registry/templates/deployment.yaml` already wires both variables, lines 150-153).
- Terraform/ECS task definitions and Kubernetes manifests outside the chart.
- Supporting other env-var delivery mechanisms (e.g. `env_file:` directives) in compose.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `docker-compose.yml` | Default full-stack compose; defines `registry` at line 149 | Already correct: passes both SSRF vars at lines 206-207 with an explanatory comment block at lines 202-205. This is the template the other two files must copy. |
| `docker-compose.podman.yml` | Podman/rootless variant of the same stack; `registry` service at line 41 | Missing both variables. Registry env block runs from line 47 (`environment:`) onward; adjacent entries `REGISTRY_CONTACT_URL` (line 84) then `SECRET_KEY` (line 85). |
| `docker-compose.prebuilt.yml` | Prebuilt public-ECR-image variant; `registry` service at line 51 | Missing both variables. Registry env block from line 57; adjacent entries `REGISTRY_CONTACT_URL` (line 90) then the `BUILD_VERSION` rationale comment (lines 91-95) + `SECRET_KEY` (line 96). |
| `docker-compose.dhi.yml` | Override file for Docker Hardened Images | No `registry` service (only mongodb, prometheus, grafana, keycloak-db overrides). Used as `-f docker-compose.yml -f docker-compose.dhi.yml`, so registry env is inherited from the base file. No change needed. |
| `.env.example` | Documents every compose-facing variable | Lines 1184-1189 document and default both variables to empty. Already exists; no change. |
| `registry/core/config.py` | Pydantic settings for the registry | `ssrf_allowed_hosts` (line 591) and `ssrf_allowed_cidrs` (line 601) read plain (unprefixed) env vars, defaulting to empty strings. Confirms the env var names and that empty string = feature off. |
| `registry/utils/url_guard.py` | SSRF guard implementation | Builds its allowlist from `settings.ssrf_allowed_hosts` / `ssrf_allowed_cidrs`; empty means only public addresses allowed. No change. |
| `charts/registry/templates/deployment.yaml` | Helm deployment | Already passes both vars (lines 150-153). No change. |
| `tests/conftest.py` | Test environment setup | Sets `SSRF_ALLOWED_HOSTS` at import time (lines 185-192), confirming the canonical variable name and that the guard reads the process environment. |
| `agents/a2a/docker-compose.*.yml` | A2A agent demos | Do not define a `registry` service; out of scope. |

### Existing Patterns Identified
1. **Env passthrough pattern**: every registry env entry uses list syntax with an empty default:
   - Files: `docker-compose.yml:206-207`, same style throughout all three files
   - How a future implementer should follow this: `- VAR_NAME=${VAR_NAME:-}` (dash at column 7, entries at the same indent as neighbors), placed in the registry service's `environment:` block.
2. **Comment-the-why pattern**: non-obvious variables get a short comment block above them (e.g. `docker-compose.yml:202-205` explains the SSRF allowlist, mentions least privilege and that the metadata IP is never permitted).
   - How a future implementer should follow this: copy the existing five-line comment verbatim rather than paraphrasing, so grepping any compose file yields identical guidance.
3. **Placement convention**: in `docker-compose.yml` the SSRF block sits after the A2A reverse-proxy entry and before `SECRET_KEY`. In podman/prebuilt there is no A2A entry in the registry block; the closest structural anchor is `REGISTRY_CONTACT_URL` (last registry-card entry) immediately before `SECRET_KEY` (start of the egress/secret section). Placing the SSRF block between them preserves "before SECRET_KEY" in all three files.
4. **File-family consistency**: the three compose files are deliberately near-copies; a variable present in one registry env block is expected in all three (verified: `TRUSTED_EXTERNAL_HOSTS`, `RUM_ALLOWED_HOSTS`, `TRUSTED_REAL_IP_CIDRS` appear in all three).

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `.env` file loading | Uses | Compose interpolates `${SSRF_ALLOWED_HOSTS:-}` from the shell env or `.env` next to the compose file; empty default keeps the entry present but blank. |
| Registry settings (`Settings.ssrf_allowed_hosts/cidrs`) | Depends on | The container process must see the env var for pydantic-settings to pick it up; names match exactly (no prefix). |
| `url_guard` allowlist construction | Depends on | Reads the settings values; behavior changes only when the operator sets non-empty values. |
| `docker-compose.dhi.yml` | Inherits | Override file has no registry service, so the base file's env (already correct) applies. |

### Constraints and Limitations Discovered
- Compose `${VAR:-}` (not `${VAR:?}`): both variables' documented default is empty, matching `.env.example` lines 1188-1189 and the base file's existing entries.
- The prebuilt registry block has an intentional comment about NOT setting `BUILD_VERSION` (lines 91-95); the SSRF insertion must not disturb that comment block.
- Comment indentation inside `environment:` list sections matches the existing comment blocks (six spaces before `#`); `- ` items share the same indent. Copy the base file's block byte-for-byte to stay consistent.
- No test currently asserts compose env contents (no compose-parsing tests found under `tests/`), so verification is via `docker compose config` in the testing plan, plus grep checks.

## Architecture

### System Context Diagram
```
Operator .env                      Compose interpolation               Registry container
+----------------------+           +---------------------------+       +--------------------------+
| SSRF_ALLOWED_HOSTS=  |  ------>  | ${SSRF_ALLOWED_HOSTS:-}   | ----> | env: SSRF_ALLOWED_HOSTS  |
| SSRF_ALLOWED_CIDRS=  |  ------>  | ${SSRF_ALLOWED_CIDRS:-}   | ----> | env: SSRF_ALLOWED_CIDRS  |
+----------------------+           +---------------------------+       |           |              |
                                                                       |           v              |
                                                                       |  Settings (pydantic)     |
                                                                       |           |              |
                                                                       |           v              |
                                                                       |  url_guard allowlist     |
                                                                       +--------------------------+
```

Before this change, the left two arrows exist only for `docker-compose.yml`; podman and prebuilt drop the values on the floor.

### Sequence Diagram
```
Operator      Compose           Registry process        url_guard
   |  set vars in .env |                |                    |
   |------------------>|                |                    |
   |  up registry      | inject env     |                    |
   |------------------>|--------------->|                    |
   |                   |                | Settings() reads   |
   |                   |                | SSRF_ALLOWED_*     |
   |                   |                |------ allowlist -->|
   |  register internal upstream        |  allowed?          |
   |---------------------------------->|                    |
   |                   |                |<--- verdict -------|
   |  health check passes (was: "url blocked by SSRF guard")
```

### Component Diagram
```
docker-compose.podman.yml ----\
docker-compose.prebuilt.yml ---+--> (edit) registry.environment += SSRF_ALLOWED_HOSTS/CIDRS
docker-compose.yml (template) /
docker-compose.dhi.yml --------> unchanged (override-only, no registry service)
```

## Data Models
No data models are added or changed. The two settings fields already exist:

```python
# registry/core/config.py (existing, unchanged)
ssrf_allowed_hosts: str = Field(default="", ...)
ssrf_allowed_cidrs: str = Field(default="", ...)
```

## API / CLI Design
No new endpoints or CLI commands. The only observable surface is Compose configuration:

**Invocation:**
```bash
docker compose -f docker-compose.podman.yml config
docker compose -f docker-compose.prebuilt.yml config
docker compose config
```

**Expected output (registry service, environment section):**
```yaml
    environment:
      SSRF_ALLOWED_HOSTS: ""
      SSRF_ALLOWED_CIDRS: ""
```
and, when `.env` sets `SSRF_ALLOWED_HOSTS=mcpgw,host.docker.internal`, the rendered value must equal that string in all three files.

**Error cases:**
- None new. Malformed CIDR/host values are already handled by `url_guard` (logs `SSRF guard: ignoring malformed CIDR in allowlist`).

## Configuration Parameters

### New Environment Variables
None new. This change wires two already-documented variables through two additional deployment surfaces:

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `SSRF_ALLOWED_HOSTS` | str | empty | No | Comma-separated exact hostnames/literal IPs the SSRF guard accepts despite resolving private. Already documented in `.env.example:1184-1188`. |
| `SSRF_ALLOWED_CIDRS` | str | empty | No | Comma-separated CIDR ranges accepted despite being private. Already documented in `.env.example:1186-1189`. |

### Settings / Config Class Updates
None. `registry/core/config.py:591-611` already defines both fields.

### Deployment Surface Checklist

| Surface | Status |
|---------|--------|
| `.env.example` | Already present (lines 1184-1189), unchanged |
| `docker-compose.yml` | Already present (lines 206-207), unchanged |
| `docker-compose.podman.yml` | **Added by this change** |
| `docker-compose.prebuilt.yml` | **Added by this change** |
| `docker-compose.dhi.yml` | Not applicable (override file, no registry service) |
| `charts/registry/templates/deployment.yaml` | Already present (lines 150-153), unchanged |
| Terraform/ECS | Not applicable (compose-scope task) |

## New Dependencies
This change uses only existing dependencies. No new packages, images, or tools.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Edit `docker-compose.podman.yml`
**File:** `docker-compose.podman.yml`
**Lines:** insert between line 84 (`- REGISTRY_CONTACT_URL=${REGISTRY_CONTACT_URL:-}`) and line 85 (`- SECRET_KEY=${SECRET_KEY}`)

```yaml
      # SSRF guard bypass for internal MCP-server / A2A-agent upstreams at private
      # IPs (e.g. docker-network hostnames). The health checker and proxy validate
      # each upstream URL through the SSRF guard, which blocks private IPs by
      # default. List exact hosts (least privilege) or CIDR ranges here; the cloud
      # metadata address (169.254.169.254) is never permitted by either.
      - SSRF_ALLOWED_HOSTS=${SSRF_ALLOWED_HOSTS:-}
      - SSRF_ALLOWED_CIDRS=${SSRF_ALLOWED_CIDRS:-}
```

#### Step 2: Edit `docker-compose.prebuilt.yml`
**File:** `docker-compose.prebuilt.yml`
**Lines:** insert after line 90 (`- REGISTRY_CONTACT_URL=${REGISTRY_CONTACT_URL:-}`). Lines 91-95 are the `BUILD_VERSION` rationale comment, which must remain intact before `SECRET_KEY` (line 96); the SSRF block goes between `REGISTRY_CONTACT_URL` and that comment, matching the base file's "registry-card vars, then SSRF vars" ordering.

```yaml
      # SSRF guard bypass for internal MCP-server / A2A-agent upstreams at private
      # IPs (e.g. docker-network hostnames). The health checker and proxy validate
      # each upstream URL through the SSRF guard, which blocks private IPs by
      # default. List exact hosts (least privilege) or CIDR ranges here; the cloud
      # metadata address (169.254.169.254) is never permitted by either.
      - SSRF_ALLOWED_HOSTS=${SSRF_ALLOWED_HOSTS:-}
      - SSRF_ALLOWED_CIDRS=${SSRF_ALLOWED_CIDRS:-}
```

#### Step 3: No other file changes
- `docker-compose.yml`: already has the identical block (lines 202-207); do not touch.
- `docker-compose.dhi.yml`: no registry service; do not touch.
- Guard, settings, docs, chart: untouched per Non-Goals.

### Error Handling
Not applicable at runtime: empty values reproduce today's default-deny behavior exactly (`${VAR:-}` guarantees the env key exists with an empty string, which pydantic-settings reads as `""`, and `url_guard` treats an empty allowlist as "no extra hosts/CIDRs"). Malformed operator values are already logged and skipped by `url_guard` (line 165).

### Logging
No new logging. Existing `url_guard` warnings cover malformed values.

## Observability
No new tracing/metrics. The existing guard logs (`SSRF guard: ignoring malformed CIDR in allowlist: %r`) and health-check failure messages (`url blocked by SSRF guard`) remain the observable signals. A correctly-set allowlist is visible via `docker compose config` and inside the container via `docker compose exec registry env | grep SSRF_`.

## Scaling Considerations
Not applicable: static YAML env passthrough, no runtime cost, no per-request impact. Allowlist parsing happens once at settings load.

## File Changes

### New Files
None.

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `docker-compose.podman.yml` | +7 (after line 84) | Add SSRF comment block + two env passthrough entries to registry service |
| `docker-compose.prebuilt.yml` | +7 (after line 90) | Same addition to registry service |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | 0 |
| New tests | 0 |
| Modified code (YAML config) | ~14 (7 per file) |
| **Total** | **~14** |

## Testing Strategy
See `testing.md`. In short: `docker compose config` rendering checks for all three files, in-container `env` presence check, and the end-to-end registration scenario from the issue (internal docker-network upstream passes health check once the vars are set in `.env`).

## Alternatives Considered

### Alternative 1: `env_file: .env` on the registry service
**Description:** Forward the whole `.env` file into the container instead of per-variable entries.
**Pros / Cons:** One line covers every current and future variable; but it blasts dozens of host-only variables (nginx ports, image tags) into the container, changes container env wholesale, breaks the explicit-declaration convention every other entry follows, and risks shadowing intentionally-different in-container values.
**Why Rejected:** Inconsistent with the file family's explicit passthrough pattern; wider blast radius than the bug being fixed.

### Alternative 2: Fix only `docker-compose.yml` docs and tell podman/prebuilt users to use `environment:` overrides
**Description:** Document a compose override snippet in docs instead of editing the files.
**Pros / Cons:** Zero diff to compose files; but it codifies the exact hand-editing workaround the issue complains about and leaves two of three deployment surfaces broken.
**Why Rejected:** Does not fix the reported behavior for the affected deployments.

### Alternative 3: Also add the variables to `docker-compose.dhi.yml`
**Description:** Belt-and-suspenders duplication in the override file.
**Pros / Cons:** Harmless but dead config; the DHI file has no registry service and cannot override one that does not exist in it.
**Why Rejected:** Misleading no-op config; the base file already covers combined `-f` usage.

### Comparison Matrix

| Criteria | Chosen (explicit passthrough) | Alt 1 (env_file) | Alt 2 (docs-only) | Alt 3 (DHI dup) |
|----------|------------------------------|------------------|-------------------|-----------------|
| Fixes the bug on all registry surfaces | Yes | Yes | No | Partial |
| Matches existing convention | Yes | No | n/a | Yes |
| Diff size | ~14 lines | ~2 lines | 0 | ~16 lines |
| Blast radius | Minimal | Large | None | None (dead) |

## Rollout Plan
- Phase 1: Implementation (this change; compose-only, no image rebuild required for prebuilt since env is injected at `up` time)
- Phase 2: Testing per `testing.md` (compose config rendering + E2E registration on a docker network)
- Phase 3: Deployment - operators add values to `.env` and `docker compose up -d registry` to recreate the container with the new env; rollback is reverting the compose files (no data or state impact)

## Open Questions
- None. Scope is fully determined by which compose files define the registry service.

## References
- `docker-compose.yml:202-207` - template block
- `.env.example:1184-1189` - variable documentation
- `registry/core/config.py:591-611` - settings fields
- `registry/utils/url_guard.py:165` - malformed-value handling
- `charts/registry/templates/deployment.yaml:150-153` - chart equivalent
- Upstream reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1513
