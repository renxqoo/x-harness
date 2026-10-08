# GitHub Issue: Make the /mcp-proxy upstream timeout configurable (MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS)

## Title
auth-server /mcp-proxy hop: hardcoded 30s upstream timeout kills long-running MCP tool calls; make it configurable

## Labels
- enhancement
- configuration
- mcp-proxy
- reliability

## Description

### Problem Statement
The auth-server's `/mcp-proxy` hop opens its upstream connection with a hardcoded 30 second timeout (`httpx.AsyncClient(timeout=30.0)` in `auth_server/server.py`). Any upstream MCP tool call that legitimately runs longer than 30s is killed and the hop returns `504 Upstream MCP server timed out`, even though the upstream is healthy and still working.

Real deployments hit this with fan-out coordinator agents: lightweight calls such as `initialize` and `tools/list` succeed, while heavier delegations fail at exactly 30s. There is no way to raise the value without rebuilding the image.

Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1320

### Proposed Solution
Make the proxy-hop upstream timeout configurable, following the same pattern the codebase already uses for the proxy body-size limit (`MCP_PROXY_MAX_BODY_BYTES`): a settings field with an `MCP_PROXY_*` environment-variable fallback, read through a clamping helper, used by the proxy handler, and exposed on every deployment and admin surface the body-size knob already covers. Default stays 30 seconds so nothing changes for operators who do not opt in.

### User Stories
- As an operator fronting long-running MCP servers through the gateway, I want to raise the proxy-hop upstream timeout via configuration so that legitimate tool calls are not killed at 30 seconds.
- As an operator running fan-out coordinator agents, I want a single documented knob (env var, Helm value, or Terraform variable) so that heavy delegations complete instead of returning 504.
- As an operator who does not opt in, I want the default to stay at 30 seconds so that my deployment behaviour is unchanged after upgrade.

### Acceptance Criteria
- [ ] The `/mcp-proxy` handler passes its upstream timeout from configuration instead of the hardcoded `30.0`.
- [ ] Default remains 30 seconds when neither the settings field nor `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` is set.
- [ ] Setting `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS` (or the equivalent settings/Helm/Terraform value) changes the timeout used for the upstream request.
- [ ] Values below the minimum floor (1 second) are clamped up to the floor rather than disabling the timeout or producing immediate failures.
- [ ] Non-numeric values fall back to the default 30 seconds with a warning, mirroring the `MCP_PROXY_MAX_BODY_BYTES` handling.
- [ ] The parameter appears in the admin config surface (`registry/api/config_routes.py`), `.env.example`, all three docker-compose files, the auth-server Helm chart (values.yaml, secret.yaml, reserved-env-names.txt), the Terraform root/module variables, `ecs-services.tf`, `terraform.tfvars.example`, and `docs/unified-parameter-reference.md`.
- [ ] Unit tests cover the default, an override, and the validation floor.
- [ ] No behaviour change for deployments that do not set the new knob.

### Out of Scope
- Per-server or per-request timeout overrides; one global proxy-hop timeout only.
- Separate httpx connect/read/write/pool timeout tuning; the client receives a single scalar, as today.
- Changing nginx or ingress-level timeouts that may independently cap long requests.
- Streaming/SSE keep-alive semantics; the timeout applies to the upstream request as a whole, exactly as the current 30s does.
- Changes to any other hop's timeouts (registry `/api/`, `/validate`, session handling).

### Dependencies
- None. Uses only existing dependencies (pydantic-settings, httpx).

### Related Issues
- #1320
