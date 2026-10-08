# Testing Plan: Registration Admission Control Gate

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview
### Scope of Testing
Verify that the admission-control gate is consulted on all seven registration/update paths, that allow/deny/failure verdicts produce the documented HTTP responses, that the disabled flag is a strict no-op, and that the configuration appears on every deployment surface.

### Prerequisites
- [ ] Registry running locally (docker-compose or `make run`) with the patched code
- [ ] Authenticated user session with `publish_agent`, `register_service`, and skill-write permissions
- [ ] A stub gate service for allow/deny tests, e.g. `python -m http.server` is not enough; use any small webhook echo that can return 200/403/500 and can be stopped to simulate unreachability
- [ ] Admin access to read `/api/config` for surface verification

### Shared Variables
```bash
export REGISTRY_URL="http://localhost"
export GATE_URL="http://localhost:9900/admit"
export COOKIE="mcpgateway_session=<paste-a-valid-session-cookie>"
```

Example stub gate (python, stdlib only):

```bash
python3 - <<'PY'
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    mode = "allow"  # allow | deny | error
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        print("GATE SEEN:", json.dumps(body)[:500])
        if H.mode == "allow":
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ok"}')
        elif H.mode == "deny":
            self.send_response(403); self.end_headers()
            self.wfile.write(json.dumps({"reason": "Name violates org naming convention"}).encode())
        else:
            self.send_response(500); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 9900), H).serve_forever()
PY
```

## 1. Functional Tests

### 1.1 Gate client verdict matrix (unit)

Run against `tests/unit/services/test_registration_gate.py`:

| Case | Gate returns | Expected decision |
|------|--------------|-------------------|
| allow | 200 `{}` | allowed=True |
| deny with reason | 403 `{"reason": "..."}` | allowed=False, reason passthrough, failure=False |
| deny without reason | 403 `{}` | allowed=False, reason=fallback message, failure=False |
| deny non-JSON body | 403 `not-json` | allowed=False, reason=fallback message |
| timeout | raises `httpx.TimeoutException` | allowed=False, failure=True |
| unreachable | raises `httpx.ConnectError` | allowed=False, failure=True |
| unexpected status | 500 / 302 / 200-with-403-semantics none | allowed=False, failure=True for non-200/403 |
| disabled | flag false, no server | allowed=True, no HTTP call made |
| misconfigured URL | enabled, URL empty or `ftp://...` | allowed=False, failure=True |
| payload scrubbing | payload with `auth_credential`, `api_key`, nested `client_secret` | keys absent from POSTed body; other fields intact |
| timeout clamp | timeout configured 600s | effective timeout 30s |

### 1.2 Agent register (`POST /agents/register`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$REGISTRY_URL/agents/register" \
  -H "Content-Type: application/json" -b "$COOKIE" \
  -d '{"name":"gate-test-agent","description":"d","url":"http://localhost:9000/a","version":"1.0","protocol_version":"0.2.9","tags":"","supported_protocol":"a2a","provider":null,"security_schemes":{},"skills":[],"visibility":"public","trust_level":"unverified"}'
```

- Gate stub in `allow` mode, `REGISTRATION_GATE_ENABLED=true`: expected `201`.
- Stub in `deny` mode: expected `403`, body contains `"Name violates org naming convention"` (the gate's reason, surfaced in `detail`).
- Stub stopped (connection refused): expected `503`, detail is exactly `Registration gate unavailable, registration blocked (fail-closed)`.
- Stub hung (accepts but never responds): expected `503` after ~5s (configured timeout).

### 1.3 Agent update (`PUT /agents/{path}`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$REGISTRY_URL/agents/gate-test-agent" \
  -H "Content-Type: application/json" -b "$COOKIE" -d '{"name":"gate-test-agent","description":"d2","url":"http://localhost:9000/a","version":"1.1","protocol_version":"0.2.9","tags":"","supported_protocol":"a2a","provider":null,"security_schemes":{},"skills":[],"visibility":"public","trust_level":"unverified"}'
```

- Gate allow: `200`. Gate deny: `403` with gate reason. Gate down: `503` fixed message.

### 1.4 Server register (`POST /register`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$REGISTRY_URL/register" \
  -b "$COOKIE" \
  -F name=gate-test-server -F description=d -F path=/gate-test-server \
  -F proxy_pass_url=http://localhost:8080 -F tags="" -F visibility=public
```

- Gate allow: `201`. Gate deny: `403` with body `{"error": "Registration denied", "detail": "<gate reason>"}`. Gate down: `503` with the fixed message.

### 1.5 Internal server register (`POST /internal/register`)

Same form fields as 1.4, authenticated as an internal caller. Verify additionally: when the server already exists and `overwrite=true`, the gate payload has `action="update"`; when new, `action="register"`.

### 1.6 Server edit (`POST /edit/{service_path}`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$REGISTRY_URL/edit/gate-test-server" \
  -b "$COOKIE" \
  -F name=gate-test-server -F description=d2 -F proxy_pass_url=http://localhost:8080 \
  -F tags="" -F visibility=public -F auth_scheme=none
```

- Gate allow: `303` (browser form) or `200` JSON (SPA). Gate deny: `403` JSON body with the gate reason, regardless of Accept header. Gate down: `503` JSON with fixed message.

### 1.7 Skill register (`POST /skills`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$REGISTRY_URL/skills" \
  -H "Content-Type: application/json" -b "$COOKIE" \
  -d '{"name":"gate-test-skill","description":"d","skill_md_url":"https://raw.githubusercontent.com/org/repo/main/SKILL.md","visibility":"public"}'
```

- Gate allow: `201`. Gate deny: `403` with gate reason in `detail`. Gate down: `503` fixed message.

### 1.8 Skill update (`PUT /skills/{skill_path}`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$REGISTRY_URL/skills/gate-test-skill" \
  -H "Content-Type: application/json" -b "$COOKIE" \
  -d '{"name":"gate-test-skill","description":"d2","skill_md_url":"https://raw.githubusercontent.com/org/repo/main/SKILL.md","visibility":"public"}'
```

- Gate allow: `200`. Gate deny: `403`. Gate down: `503`.

### 1.9 Gate payload contract (functional assertion)

With the stub printing the POST body, register any asset and assert the body contains: `asset_type`, `path`, `endpoint`, `action`, `user`, `payload`; that `endpoint` matches the route called; and that no payload key contains `credential`, `secret`, `token`, or `password`.

Negative case for every endpoint: a deny MUST leave storage unchanged (asset count identical before/after; `GET /agents`, `/servers`, `/skills` show no new or modified entry).

## 2. Backwards Compatibility Tests

- [ ] With `REGISTRATION_GATE_ENABLED=false` (default), run 1.2 through 1.8: all statuses identical to pre-change behavior (201/200/303), and the stub gate logs zero incoming requests.
- [ ] `PUT /agents/{path}` without the feature enabled still returns the same 404/403/422 shapes as before.
- [ ] `POST /internal/register` with the feature disabled behaves exactly as before, including the overwrite and 409 paths.
- [ ] Config API `/api/config` still returns all pre-existing groups; the new `registration_gate` group is additive.
- [ ] `.env.example`-only deployments (no gate vars set) start with no errors or new warnings.

## 3. UX Tests

- [ ] Deny reason from the gate is human-readable in the SPA when a registration is rejected (message appears in the existing error toast/panel).
- [ ] Gate-failure message shown to users is the fixed generic text; no stack traces, URLs, or exception details leak.
- [ ] Config admin UI shows the five new fields under a "Registration Gate" group; sensitive token is masked.

## 4. Deployment Surface Tests

### 4.1 Docker wiring

```bash
grep -n "REGISTRATION_GATE_ENABLED\|REGISTRATION_GATE_URL" docker-compose.yml
# expected: 5 env entries in the registry service block
```

### 4.2 Terraform / ECS wiring

```bash
grep -n "registration_gate" terraform/aws-ecs/variables.tf terraform/aws-ecs/main.tf \
  terraform/aws-ecs/modules/mcp-gateway/variables.tf terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf
# expected: root var, module var, main.tf pass-through, container env entry (REGISTRATION_GATE_ENABLED / _URL / _TIMEOUT_SECONDS / _AUTH_HEADER / _AUTH_TOKEN)
```

### 4.3 Helm / EKS wiring

```bash
grep -n "registrationGate\|REGISTRATION_GATE" charts/registry/values.yaml charts/registry/templates/secret.yaml
# expected: values block + 5 rendered keys, token handled as secret material
```

### 4.4 Deploy and verify

```bash
export REGISTRATION_GATE_ENABLED=true REGISTRATION_GATE_URL=$GATE_URL
docker compose up -d registry
# repeat 1.4 (allow) against the deployed registry
```

### 4.5 Rollback verification

```bash
export REGISTRATION_GATE_ENABLED=false
docker compose up -d registry
# registrations succeed with the gate down: no 503s, feature fully inert
```

## 5. End-to-End API Tests

Scenario: org naming policy via the gate.
1. Start stub in `deny` mode with reason "Name must start with team-".
2. Register an agent named `gate-test-agent` -> `403`, reason surfaced.
3. Confirm the agent does not appear in `GET /agents` (not persisted).
4. Flip stub to `allow`, retry the same request -> `201`.
5. Confirm the agent now appears and its card is complete.
6. Stop the stub, attempt a server registration -> `503` (fail-closed), nothing persisted.
7. Set `REGISTRATION_GATE_ENABLED=false`, restart, attempt the same server registration -> `201` (kill switch works).

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) verified
- [ ] Section 5 (E2E) verified
- [ ] Unit tests added under `tests/unit/services/` (gate client)
- [ ] Route-level unit tests added under `tests/unit/api/`
- [ ] `uv run pytest tests/unit/services/test_registration_gate.py tests/unit/api/test_registration_gate_routes.py` passes
- [ ] Full `uv run pytest tests/unit/` passes with no regressions
