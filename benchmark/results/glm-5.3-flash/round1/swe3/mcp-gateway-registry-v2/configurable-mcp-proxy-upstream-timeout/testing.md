# Testing Plan: Configurable /mcp-proxy upstream timeout (MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS)

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verify that the `/mcp-proxy` hop's upstream timeout is configurable end to end: default stays 30s, the env/settings/Helm/Terraform values change it, the 1s floor holds, non-finite and junk values fall back safely, and every deployment surface carries the knob. Also verify nothing else about the hop changed (headers, filtering, error mapping).

### Prerequisites
- [ ] Repository checked out at tag `1.25.0` with the patch applied (`git apply patch.diff`).
- [ ] Python environment with the auth-server dependencies installed (`fastapi`, `httpx`, `pytest`, `pytest-asyncio`).
- [ ] For compose tests: docker compose available.
- [ ] For Helm tests: `helm` CLI available.
- [ ] For Terraform tests: `terraform` CLI available (`validate` only; no apply).

### Shared Variables
```bash
export REPO="/path/to/mcp-gateway-registry"   # checkout with the patch applied
cd "$REPO"
# The auth-server unit tests read SECRET_KEY from the env (set by tests/auth_server/conftest.py fixtures).
```

## 1. Functional Tests

### 1.1 curl / HTTP Tests
**Not Applicable** - no new or modified HTTP endpoints; the knob rides the existing admin config payload, and driving the live proxy hop is covered by the unit-level TestClient tests below and E2E in Section 5. The admin config surface test:

```bash
# Start the stack, mint an admin token per docs, then:
curl -sf http://localhost/api/config | jq '.auth.mcp_proxy_upstream_timeout_seconds'
# Expected: 30 (default) or the operator-set value
```

### 1.2 Unit Tests (pytest)

All tests live in `tests/auth_server/unit/test_server.py`, class `TestMcpProxyUpstreamTimeoutConfig`, reusing `_mcp_proxy_token_headers()` and the (patch-extended) `_patch_httpx_async_client()` helper. The helper extension exposes the mock `AsyncClient` class so tests assert `mock_cls.call_args.kwargs["timeout"]`.

#### 1.2.1 Default is 30.0

```python
def test_default_timeout_is_30(self):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200,
        headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", None, create=True), \
         patch.dict(os.environ, {}, clear=False):
        os.environ.pop("MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS", None)
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert response.status_code == 200
    assert mock_cls.call_args.kwargs["timeout"] == 30.0
```

#### 1.2.2 Env override changes the timeout

```python
def test_env_override_timeout(self):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200, headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    env = {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "120"}
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", None, create=True), \
         patch.dict(os.environ, env):
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert response.status_code == 200
    assert mock_cls.call_args.kwargs["timeout"] == 120.0
```

#### 1.2.3 Floor clamps sub-1 values

```python
def test_floor_clamps_to_one_second(self):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200, headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    env = {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "0.25"}
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", None, create=True), \
         patch.dict(os.environ, env):
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert response.status_code == 200
    assert mock_cls.call_args.kwargs["timeout"] == 1.0
```

#### 1.2.4 Junk value falls back to default

```python
def test_junk_env_falls_back_to_default(self):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200, headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    env = {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "banana"}
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", None, create=True), \
         patch.dict(os.environ, env):
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert response.status_code == 200
    assert mock_cls.call_args.kwargs["timeout"] == 30.0
```

#### 1.2.5 Non-finite values are rejected (review follow-up)

```python
@pytest.mark.parametrize("bad", ["nan", "inf", "-inf"])
def test_non_finite_env_falls_back_to_default(self, bad):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200, headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    env = {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": bad}
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", None, create=True), \
         patch.dict(os.environ, env):
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert response.status_code == 200
    assert mock_cls.call_args.kwargs["timeout"] == 30.0
```

#### 1.2.6 Settings field wins over env (cascade check)

```python
def test_settings_attr_beats_env(self):
    import auth_server.server as server_module
    upstream_resp = _build_mock_upstream_response(
        status_code=200, headers={"content-type": "application/json"},
        body=b'{"jsonrpc":"2.0","id":1,"result":{}}',
    )
    env = {"MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS": "120"}
    with patch.object(server_module.settings, "mcp_proxy_upstream_timeout_seconds", 45.0, create=True), \
         patch.dict(os.environ, env):
        with _patch_httpx_async_client(upstream_resp) as mock_cls:
            client = TestClient(server_module.app)
            response = client.post(
                "/mcp-proxy/office-docs",
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                headers=_mcp_proxy_token_headers(),
            )
    assert mock_cls.call_args.kwargs["timeout"] == 45.0
```

Run:

```bash
cd "$REPO" && uv run pytest tests/auth_server/unit/test_server.py::TestMcpProxyUpstreamTimeoutConfig -v
# Expected: all pass, 0 failed
```

### 1.3 Full regression sweep

```bash
cd "$REPO" && uv run pytest tests/auth_server/unit/ -q
# Expected: no failures; the existing TestMcpProxyEndpointHeaderPassthrough and
# tool-filter suites must be unaffected (they do not set the env var, so the
# default 30.0 path applies and behaviour is identical to pre-patch).
```

## 2. Backwards Compatibility Tests

- [ ] **Default unchanged:** 1.2.1 proves a no-env deployment constructs `timeout=30.0`, byte-identical behaviour to the hardcoded value.
- [ ] **Existing tests pass unmodified:** Section 1.3's sweep must show zero changes to pre-existing tests; if an existing test asserts `timeout=30.0` inline, it still passes because the default equals the old constant.
- [ ] **504 mapping intact:** with the env var raised (e.g. `5`) and a mock upstream raising `httpx.ConnectTimeout`, the handler still returns `504 Upstream MCP server timed out` (existing error-path tests cover the mapping; run them via 1.3).
- [ ] **CLI flags:** **Not Applicable** - no CLI commands changed.

## 3. UX Tests

- [ ] **Admin config UI:** load the admin configuration page; the Authentication section shows "MCP Proxy Upstream Timeout (seconds)" with the current value; editing it and saving round-trips through `PUT /api/config`.
- [ ] **CLI output:** **Not Applicable** - no CLI surface changed.
- [ ] **Docs legibility (manual):** `docs/unified-parameter-reference.md` row renders as a proper table row with the caveat sentence intact.

## 4. Deployment Surface Tests

### 4.1 Docker wiring
```bash
cd "$REPO"
grep -n "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS" docker-compose.yml docker-compose.prebuilt.yml docker-compose.podman.yml .env.example
# Expected: one line each; compose lines read
#   - MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=${MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS:-30}

# Live compose check (optional, requires a running stack):
MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=120 docker compose up -d auth-server
docker compose exec auth-server printenv MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS
# Expected: 120
```

### 4.2 Terraform / ECS wiring
```bash
cd "$REPO/terraform/aws-ecs"
terraform validate
# Expected: success; an invalid value fails validation:
terraform validate -var="mcp_proxy_upstream_timeout_seconds=0"
# Expected: error "mcp_proxy_upstream_timeout_seconds must be at least 1"

grep -n "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS" modules/mcp-gateway/ecs-services.tf
grep -n "mcp_proxy_upstream_timeout_seconds" variables.tf main.tf modules/mcp-gateway/variables.tf terraform.tfvars.example
# Expected: the entries listed in the LLD Deployment Surface Checklist
```

### 4.3 Helm / EKS wiring
```bash
cd "$REPO"
grep -n "mcpProxyUpstreamTimeoutSeconds" charts/auth-server/values.yaml
grep -n "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS" charts/auth-server/templates/secret.yaml charts/auth-server/reserved-env-names.txt
helm template test charts/auth-server --set app.mcpProxyUpstreamTimeoutSeconds="90" | grep -a "MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS"
# Expected (base64 of "90"): MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS: OTAK
```

### 4.4 Deploy and verify
```bash
# After any deploy path (compose/ECS/Helm), drive a call that takes >30s upstream:
# - with the default: expect 504 at ~30s (unchanged legacy behaviour)
# - with MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=120: expect success at ~45s
```

### 4.5 Rollback verification
```bash
# Unset the knob and redeploy: behaviour returns to the 30s default.
# The patch introduces no migration or state; rollback = unset variable.
```

## 5. End-to-End API Tests

- [ ] **Long-call scenario:** register a stub MCP server whose tool sleeps 45s; drive `tools/call` through `/mcp-proxy/<server>/mcp`. Default (no env): 504 at ~30s. With `MCP_PROXY_UPSTREAM_TIMEOUT_SECONDS=120`: 200 with the tool result at ~45s.
- [ ] **Short-call unaffected:** `initialize` and `tools/list` return quickly in both configurations.
- [ ] **Fan-out coordinator simulation:** sequence of 1 `initialize`, 1 `tools/list`, 1 slow `tools/call` -- all succeed under the raised timeout; only the slow call fails under the default.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/auth_server/unit/test_server.py`
- [ ] `uv run pytest tests/auth_server/unit/` passes with no regressions
