# GitHub Issue: Pass SSRF_ALLOWED_HOSTS and SSRF_ALLOWED_CIDRS through to the registry container in every compose file

## Title
Compose files for podman and prebuilt deployments do not pass SSRF_ALLOWED_HOSTS / SSRF_ALLOWED_CIDRS to the registry service

## Labels
- bug
- deployment
- security

## Description

### Problem Statement
`SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS` are documented in `.env.example` (lines 1184-1189) and read by the registry at runtime through `registry.core.config.Settings` (`ssrf_allowed_hosts`, `ssrf_allowed_cidrs`, `registry/core/config.py:591-611`) and consumed by `registry/utils/url_guard.py`. The default `docker-compose.yml` passes both into the registry service environment (lines 206-207), but the other two compose files that start the registry do not:

- `docker-compose.podman.yml` (registry service, environment block around lines 47-84)
- `docker-compose.prebuilt.yml` (registry service, environment block around lines 57-90)

On those deployments the settings therefore have no effect: the registry process never sees the variables, because Compose only forwards host environment / `.env` values that a service explicitly declares.

The practical consequence is that an internal upstream cannot be allowlisted. Registering a server reachable only by a docker-network hostname makes its health check report `url blocked by SSRF guard`, and setting `SSRF_ALLOWED_HOSTS` in `.env` changes nothing. The only workaround is to hand-edit the compose file, which is exactly what the documented variables are supposed to avoid.

### Proposed Solution
Add the same two-line environment passthrough (with the same explanatory comment) used by the default `docker-compose.yml` to the registry service in `docker-compose.podman.yml` and `docker-compose.prebuilt.yml`:

```yaml
      - SSRF_ALLOWED_HOSTS=${SSRF_ALLOWED_HOSTS:-}
      - SSRF_ALLOWED_CIDRS=${SSRF_ALLOWED_CIDRS:-}
```

`docker-compose.dhi.yml` needs no change: it is an override file with no `registry` service, so the registry definition (including its environment) is inherited from the base `docker-compose.yml` when the two files are combined.

### User Stories
- As an operator running the stack via `docker-compose.podman.yml`, I want to set `SSRF_ALLOWED_HOSTS` in `.env` so that MCP servers on docker-network hostnames pass the SSRF health check.
- As an operator running the prebuilt ECR deployment (`docker-compose.prebuilt.yml`), I want to allowlist an internal CIDR range in `.env` so that internal MCP server subnets can be registered without editing compose files.

### Acceptance Criteria
- [ ] `docker-compose.podman.yml` registry service declares both `SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS` environment entries with the `${VAR:-}` empty-default passthrough
- [ ] `docker-compose.prebuilt.yml` registry service declares both variables the same way
- [ ] The wording and comment match the existing block in `docker-compose.yml` (lines 202-207) so the three files stay consistent
- [ ] Setting the variables in `.env` and running `docker compose config` shows them in the registry service environment for all three compose files
- [ ] No other service in any compose file is modified; `docker-compose.dhi.yml` is unchanged

### Out of Scope
- Changes to the SSRF guard logic itself (`registry/utils/url_guard.py`)
- Helm chart wiring (`charts/registry/templates/deployment.yaml` already passes both variables)
- Documentation rewrites; `.env.example` and `docs/unified-parameter-reference.md` already document the variables
- Terraform/ECS task definitions

### Dependencies
- None. Uses only existing Compose variable substitution.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1513
