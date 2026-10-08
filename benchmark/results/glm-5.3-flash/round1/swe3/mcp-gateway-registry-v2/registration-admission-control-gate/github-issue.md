# GitHub Issue: Registration Admission Control Gate (external policy webhook)

## Title
Add an external admission-control gate that is consulted before every agent, server, and skill registration or update

## Labels
- enhancement
- security
- enterprise
- registration

## Description

### Problem Statement
Any authenticated user with the right permissions can register an agent, server, or skill with no external policy enforcement. The registry checks only its own built-in permissions and validation rules. Organizations need to apply their own rules before a registration is persisted: naming conventions, compliance checks, ticket approval, allowlists of upstream URLs, and similar policy that lives outside the registry and changes independently of it.

Today there is no hook point where such a policy can run, and no way for an operator to block a registration that satisfies the registry's built-in checks but violates org policy.

### Proposed Solution
Add a registration gate: an admission-control webhook that the registry calls before persisting ANY asset registration or update. The registry POSTs the registration payload to a configurable external HTTP endpoint. The gate replies:

- `200` with a JSON body: allow, registration proceeds.
- `403` with a JSON body containing a `reason`: deny, registration is blocked and the gate's reason is surfaced to the caller in the HTTP error detail.

The call is fail-closed: if the gate is unreachable, times out, or returns any unexpected status, the registration is blocked.

The gate applies to every registration and update path across all three asset types:

| Asset | Path | Gate action |
|------|------|-------------|
| Agent | `POST /agents/register` | register |
| Agent | `PUT /agents/{path}` | update |
| Server | `POST /register` | register |
| Server | `POST /internal/register` | register |
| Server | `POST /edit/{service_path}` | update |
| Skill | `POST /skills` | register |
| Skill | `PUT /skills/{skill_path}` | update |

The gate request payload identifies which endpoint the call came from (`endpoint` and `action` fields) so one gate can distinguish, for example, an internal server registration from a UI edit.

Configuration (all environment variables, feature off by default):

| Variable | Default | Purpose |
|----------|---------|---------|
| `REGISTRATION_GATE_ENABLED` | `false` | Master switch; off means zero behavior change |
| `REGISTRATION_GATE_URL` | (empty) | Gate webhook URL, required when enabled |
| `REGISTRATION_GATE_TIMEOUT_SECONDS` | `5` | Per-call HTTP timeout |
| `REGISTRATION_GATE_AUTH_HEADER` | `Authorization` | Header name used to authenticate to the gate |
| `REGISTRATION_GATE_AUTH_TOKEN` | (empty) | Header value; empty sends no auth header |

The gate request never includes registry credentials (for example a server's `auth_credential`); only registration metadata is sent.

### User Stories
- As an enterprise operator, I want every registration and update to be checked against my organization's policy service so that non-compliant assets never enter the registry.
- As a policy-service developer, I want the full registration payload plus the originating endpoint and action so that one webhook can implement different rules per asset type and per route.
- As an agent developer, when my registration is denied I want the gate's reason returned to me so I can fix the problem and retry.
- As an operator, I want the feature off by default so that upgrading the registry does not change behavior until I explicitly enable the gate.

### Acceptance Criteria
- [ ] All seven registration/update paths listed above call the gate before any persistence when `REGISTRATION_GATE_ENABLED=true`.
- [ ] A `200` from the gate allows the registration; the flow is identical to the current flow.
- [ ] A `403` from the gate blocks the registration and the gate's `reason` is surfaced to the caller (HTTP 403, message in the response detail/error).
- [ ] Gate timeout, connection failure, or any non-200/non-403 status blocks the registration with HTTP 503 and a fixed, non-sensitive error message (fail-closed).
- [ ] With `REGISTRATION_GATE_ENABLED=false` (the default) no HTTP call is made and all seven paths behave exactly as before.
- [ ] Enabling the gate without setting `REGISTRATION_GATE_URL` blocks registrations (fail-closed on misconfiguration).
- [ ] The gate request body contains `asset_type`, `endpoint`, `action`, `payload`, and the calling principal's username.
- [ ] The gate request carries the configured auth header and never contains registry credential fields.
- [ ] Deny and gate-failure events are logged at warning/error level with asset type, endpoint, path, and user.
- [ ] New settings appear in the admin config API groups and in `.env.example`, `docker-compose.yml`, Terraform ECS variables, and the Helm chart.
- [ ] Unit tests cover allow, deny, timeout, unreachable gate, unexpected status, disabled no-op, and misconfiguration, plus route-level deny/allow/timeout tests for the registration paths.

### Out of Scope
- Changes to delete, toggle, rate, health-check, or read paths; the gate covers registration and update only.
- A reference implementation of the gate service itself (only the client side in the registry).
- Retries or circuit breaking on gate calls (a single attempt per registration; fail-closed on error).
- Asynchronous or queue-based admission (the check is synchronous and blocking).
- A runtime admin UI toggle for the gate (configuration is environment-based in this change).
- Frontend UI changes beyond what the existing config API rendering already provides.

### Dependencies
- None. The gate is an external HTTP service; the registry already depends on `httpx` for outbound HTTP.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/809
