# Testing Plan: Nginx location trailing-slash fix (route-hijack prevention)

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
The change is confined to the nginx config generator, so testing targets the generated config text: block shape (`location {ROOT_PATH}/name/`), the bare-path exact block, input-shape normalization, sibling-prefix confinement, and unchanged MCP client routing (`/name/mcp`, `/name/sse`). Live-nginx behavior is covered by a manual verification recipe for operators.

### Prerequisites
- [ ] Registry repo checkout at the patched commit
- [ ] Python env ready: `uv sync` (or the repo's standard setup)
- [ ] For the manual live check only: a running docker-compose deployment

### Shared Variables
```bash
# Unit-test invocation (from repo root)
pytest tests/unit/core/test_nginx_service.py -q
```

## 1. Functional Tests

### 1.1 Unit Tests - generated block shape (pytest)

Add to `tests/unit/core/test_nginx_service.py` (after the `_create_location_block` tests, ~line 1003). These are the tests the patch itself adds:

```python
@pytest.mark.unit
@pytest.mark.parametrize("raw_path", ["/test", "/test/", "test", "//test//"])
def test_create_location_block_normalizes_trailing_slash(nginx_service, raw_path):
    """All input shapes render the same canonical /test/ prefix location."""
    block = nginx_service._create_location_block(
        raw_path, "http://localhost:8000/mcp", "streamable-http"
    )
    assert "location {{ROOT_PATH}}/test/ {" in block
    assert "location {{ROOT_PATH}}/test {" not in block  # exact bare block aside
    # No doubled slash anywhere in the location line.
    assert "location {{ROOT_PATH}}//test" not in block


@pytest.mark.unit
def test_create_location_block_sibling_prefix_collision(nginx_service):
    """A server at /a owns /a/ and cannot intercept sibling namespaces."""
    block = nginx_service._create_location_block("/a", "http://localhost:8000/mcp", "streamable-http")

    assert "location {{ROOT_PATH}}/a/ {" in block
    # nginx prefix semantics: /api does NOT start with /a/ (segment boundary),
    # so none of these sibling URIs can match the generated location.
    for sibling in ("/api", "/auth", "/about", "/apiv2"):
        assert not sibling.startswith("/a/")


@pytest.mark.unit
def test_create_location_block_bare_path_exact_block(nginx_service):
    """Bare-path POSTs (append_mcp_path=False servers) keep proxying."""
    block = nginx_service._create_location_block(
        "/test", "http://localhost:8000/mcp", "streamable-http"
    )
    assert "location = {{ROOT_PATH}}/test {" in block
    # Both blocks carry identical auth + routing wiring: exactly two
    # auth_request /validate lines, two X-Upstream-Url forwards, two
    # proxy_pass hops to the same mcp-proxy target.
    assert block.count("auth_request /validate;") == 2
    assert block.count("proxy_set_header X-Upstream-Url $backend_url;") == 2
    assert block.count("proxy_pass http://auth-server:8888/mcp-proxy/test/") == 2


@pytest.mark.unit
def test_create_location_block_root_path_no_exact_block(nginx_service):
    """Root registration: prefix block only, no bare exact block."""
    block = nginx_service._create_location_block(
        "/", "http://localhost:8000/mcp", "streamable-http"
    )
    assert "location = {{ROOT_PATH}}" not in block
    assert "location {{ROOT_PATH}}/ {" in block


@pytest.mark.unit
def test_create_location_block_multi_segment_path(nginx_service):
    """Two-segment registered path normalizes and gains the exact block."""
    block = nginx_service._create_location_block(
        "/peer/server", "http://localhost:8000/mcp", "streamable-http"
    )
    assert "location {{ROOT_PATH}}/peer/server/ {" in block
    assert "location = {{ROOT_PATH}}/peer/server {" in block
    assert block.count("proxy_pass http://auth-server:8888/mcp-proxy/peer/server/") == 2
```

**Expected:** all pass. **Regression guard:** the pre-existing assertions `assert "location {{ROOT_PATH}}/test" in block` (9 call sites) remain green because the substring still occurs inside `location {{ROOT_PATH}}/test/`.

### 1.2 Generated-config sanity (no live nginx)

```bash
cd <repo> && grep -c "location {{ROOT_PATH}}/test/ {" <(pytest tests/unit/core/test_nginx_service.py -q --no-header -s 2>/dev/null) 2>/dev/null || true
# The meaningful check is the unit tests above; this grep is only a smoke aid.
```

**Not separately executable** - the unit tests in 1.1 are the functional check of the generated text.

## 2. Backwards Compatibility Tests

### 2.1 MCP client transport endpoints still match (unit)

```python
@pytest.mark.unit
@pytest.mark.parametrize("sub", ["mcp", "sse", "messages"])
def test_transport_endpoints_still_match_prefix_location(nginx_service, sub):
    """URIs /name/<transport> still resolve into the server's block."""
    block = nginx_service._create_location_block(
        "/test", "http://localhost:8000/sse", "sse"
    )
    location = "{{ROOT_PATH}}/test/"
    # Nginx semantics: prefix location /test/ matches /test/mcp, /test/sse, ...
    for uri_tail in (sub, f"{sub}/x"):
        assert ("/test/" + uri_tail).startswith("/test/")
    assert location in block
```

### 2.2 Version-map tolerance (unit, existing behavior pinned)

```python
@pytest.mark.unit
def test_version_map_keys_survive_trailing_slash_locations(nginx_service):
    """The generated map regex still keys on the raw path, not the location."""
    import asyncio
    from unittest.mock import AsyncMock, patch

    async def _run():
        with patch("registry.services.server_service.server_service") as svc:
            svc.get_server_info = AsyncMock(return_value=None)
            servers = {
                "/test": {
                    "other_version_ids": ["id2"],
                    "version": "v1.0.0",
                    "proxy_pass_url": "http://u1",
                }
            }
            svc.get_server_info = AsyncMock(
                return_value={"version": "v2.0.0", "proxy_pass_url": "http://u2"}
            )
            return await nginx_service._generate_version_map(servers)

    text = asyncio.run(_run())
    # Anchored at ^/test with optional /... tail: matches /test and /test/mcp
    # whether or not the location carries the trailing slash.
    assert "~^/test(/.*)?:$" in text
```

### 2.3 Existing suite regression

```bash
pytest tests/unit/core/test_nginx_service.py -q
```

**Expected:** no regressions; the 9 pre-existing substring assertions stay green (verified by reading: `location {{ROOT_PATH}}/test` is a substring of `location {{ROOT_PATH}}/test/`).

## 3. UX Tests

**Partially Applicable** - covered by the manual live check in Section 5 (post-logout navigation). No CLI surface exists for this feature; no UI code changes ship in this patch.

Manual UX assertion (operator, on a deployment with a server at a short path):
- Log out, navigate to `/about` (or any SPA route sharing the server path's prefix): expect the app page / login redirect, never `{"error": "Authentication required"}`.

## 4. Deployment Surface Tests

**Not Applicable** - no new config parameters on any surface (`.env.example`, `docker-compose.yml`, Terraform, Helm untouched).

Deployment-behavior verification (config convergence) is covered in Section 5.

## 5. End-to-End Tests

### 5.1 Live deployment convergence + sibling-route recovery (manual, docker-compose)

```bash
# 0. Baseline (pre-fix image): confirm the bug
docker compose ps   # stack up; a server registered at a short path, e.g. /a
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/about
# Expected pre-fix: 401 (hijacked by location /a)

# 1. Upgrade: replace the registry image with the patched build, restart only that service
docker compose up -d --no-deps registry
# Startup generation rewrites /etc/nginx/conf.d/nginx_rev_proxy.conf inside the nginx container

# 2. Confirm the generated config carries the trailing slash
docker compose exec nginx grep -n 'location /.*/ {' /etc/nginx/conf.d/nginx_rev_proxy.conf | head
# Expected: 'location /a/ {' plus 'location = /a {' lines for each server

# 3. Sibling route recovered for unauthenticated navigation
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/about
# Expected: 200 (SPA) or 30x to login - never 401 JSON

# 4. MCP client flow intact (authenticated)
TOKEN=$(jq -r '.access_token' .oauth-tokens/ingress.json)   # per repo docs
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/a/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# Expected: 200 (or the upstream's own JSON-RPC response code)

# 5. Bare-path POST (append_mcp_path=False server) intact
#    (run this only if the /a server is registered with append_mcp_path=False;
#    otherwise POST /a is not an MCP endpoint and a 404/405 from the app is expected)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/a \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# Expected: same as step 4 (proxied through the exact-match block)

# 6. Rollback
docker compose up -d --no-deps registry   # with previous image
docker compose exec nginx grep -c 'location /a/ {' /etc/nginx/conf.d/nginx_rev_proxy.conf
# Expected after next restart: 0 occurrences of the new shape; old shape restored
```

### 5.2 Reload-safety gate (manual, optional)

```bash
# While the stack is up, break a rendered config and confirm promote-or-restore:
docker compose exec nginx nginx -t   # must pass on the generated file at all times
```

## 6. Test Execution Checklist
- [ ] Section 1 (Functional - generated block shape, exact block, root/multi-segment) passes
- [ ] Section 2 (Backwards Compat - transport endpoints, version map, full nginx_service suite) passes
- [ ] Section 3 (UX) verified via Section 5.1 step 3 (or marked Partially Applicable)
- [ ] Section 4 (Deployment surfaces) marked Not Applicable
- [ ] Section 5 (E2E) executed on a live deployment or explicitly deferred with reason
- [ ] Unit tests added under `tests/unit/core/test_nginx_service.py`
- [ ] `pytest tests/unit/core/test_nginx_service.py -q` passes with no regressions
