# Low-Level Design: Nginx location trailing-slash fix (route-hijack prevention)

*Created: 2026-09-30*
*Author: glm-5.3-flash*
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
14. [Rollout Plan]

## Overview

### Problem Statement
`registry/core/nginx_service.py::_create_location_block` renders `location {{ROOT_PATH}}{location_path}` with `location_path = path` verbatim (line ~2364), i.e. with no trailing slash. nginx prefix locations match every URI that starts with the location string, so a server registered at `/a` also matches `/api/...`, `/auth`, `/about`, `/assets` and every SPA route beginning with `a`. Because every generated block carries `auth_request /validate`, unauthenticated navigation to such a route returns `401 {"error": "Authentication required"}` instead of the page. With a valid session cookie the subrequest returns 200 and the bug hides.

### Goals
- A server registered at `/name` owns only URIs under `/name/`; it cannot intercept a sibling namespace (`/api`, `/auth`, `/about`, `/apiv2`, ...).
- Existing MCP client flows keep working byte-for-byte: `/name/mcp`, `/name/sse`, `/name/messages`, including servers with `append_mcp_path=False` whose clients POST the bare registered path.
- Bare-path requests to the registered path (`POST /name`, the `append_mcp_path=False` connection style) keep proxying to the mcp-proxy hop through an exact-match block; sibling routes are untouched by it.
- Existing deployments converge to the fixed config automatically on the next registry restart (no manual nginx surgery).

### Non-Goals
- Trailing-slash normalization for virtual-server blocks (`_generate_virtual_server_blocks`, `/virtual/...` paths): the namespace is admin-controlled and prefix-disjoint from UI routes; follow-up.
- Changes to the nginx templates (`docker/nginx_rev_proxy_*.conf`): the catch-all and `^~` guards stay untouched.
- Registration-time path reservation (blocking a server path of `/validate`, `/oauth2`, etc.): separate hardening issue.
- Making the auth_server `/mcp-proxy/` hop accept GET (SSE): pre-existing surface, unchanged.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/core/nginx_service.py` | Generates nginx config for registered servers | Bug site: `_create_location_block` lines 2362-2369 (`location_path = path` with comment "Users have full control over the location path format"). Also hosts the unhealthy-server commented block (line 898) which already renders a trailing slash, the version map (`_generate_version_map`, lines 1275-1377), and the mcp-proxy target construction (line 2190) |
| `docker/nginx_rev_proxy_http_and_https.conf` | Base nginx template | `{{LOCATION_BLOCKS}}` placeholder (line 201); catch-all `location /` -> `127.0.0.1:7860` (line 255); `location = /validate` (line 273); `^~` guards on `/api/auth`, `/api/health`, `/api/version`, `/api/public/`, `/api/ard/` (lines 759-827). Structure mirrored in `nginx_rev_proxy_http_only.conf` |
| `auth_server/server.py` | auth sidecar | `POST /mcp-proxy/{server_name:path}` (line 6407) splits the capture into first segment (server name) + sub-path and appends the sub-path to the bound upstream URL (lines 6447-6450); `_registered_server_from_proxy_path` (line 1465) strips trailing transport segments (`mcp`/`sse`/`messages`) |
| `registry/core/schemas.py` | `ServerInfo.path` validation | `_SERVER_PATH_RE = ^[A-Za-z0-9._\-/]+$` (line 28); `_validate_path` (line 743) rejects every nginx metacharacter, so a path can never inject directives or form `//` unless it already ends in `/` |
| `registry/api/server_routes.py` | Registration write path | `_normalize_server_path` (line 1107): ensures leading slash, strips trailing slash unless path is `/`. Applied on PUT/PATCH (lines 6053, 6226) and elsewhere; older/other write paths may still store `/name/` or `name`, so the generator must be robust to all three shapes |
| `registry/auth/oauth_metadata.py` | Per-server PRM URLs | `build_per_server_prm_url` inserts `.well-known` segment and `/mcp` suffix; operates on `settings.registry_url` + `path`, not on the location string - unaffected by the location change |
| `registry/main.py` | Startup sequence | Lines 827-836: `generate_config_async(enabled_servers)` runs unconditionally at startup when `nginx_updates_enabled`, then seeds the scheduler hash from the written file - this is the self-heal path for existing deployments |
| `registry/core/nginx_service.py` (scheduler) | `NginxReloadScheduler._do_reload_if_changed` (lines 2443-2477) | Re-renders config every debounce tick, compares SHA-256 to the last-applied hash, writes via `_write_and_validate_config` (temp file + `nginx -t` + promote-or-restore) and reloads only on change - second self-heal path |
| `tests/unit/core/test_nginx_service.py` | Existing unit tests | `_create_location_block` / `_generate_transport_location_blocks` assertions use the substring `location {{ROOT_PATH}}/test` (lines 787, 872, 891, 906, 921, 952, 968, 984, 998) which remains a substring of `location {{ROOT_PATH}}/test/` - existing tests stay green. New tests slot in after line 1003 |

### Existing Patterns Identified
1. **Trailing-slash prefix locations**: the unhealthy-server commented block (line 898: `location {{ROOT_PATH}}{safe_commented_path}/`) and the A2A agent block (line 1977: `location {{ROOT_PATH}}{route}/`) both already render a trailing slash; the nginx template uses `location {{ROOT_PATH}}/api/` (line 769). The fix makes `_create_location_block` consistent with all of them.
2. **Path sanitization for nginx interpolation**: `_sanitize_for_nginx_set` / `_sanitize_for_nginx_comment` defense-in-depth over `_SERVER_PATH_RE` validation. The location path itself is only interpolated into a directive-name position (not a quoted string), which `_SERVER_PATH_RE` already keeps metacharacter-free.
3. **Version map regexes are suffix-tolerant**: `_generate_version_map` keys on `~^{escaped_path}(/.*)?:...$` against `"$uri:$http_x_mcp_server_version"` - `escaped_path` has no trailing slash and `(/.*)?` covers `/`, `/mcp`, etc., so map matching is unaffected by the location shape.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `render_config` / `generate_config_async` | Depends on | Sole consumers of `_generate_transport_location_blocks`; output injected at `{{LOCATION_BLOCKS}}` |
| `auth_server` mcp-proxy hop | Depends on | `proxy_pass {settings.auth_server_url}/mcp-proxy/{path.strip("/")}/` (line 2190) already ends in `/`; the trailing slash is on the proxy target, not the client-facing location, and is unchanged |
| Version routing (`$versioned_backend` map) | Uses | Map keys are regexes on `$uri`; they keep matching URIs under the now-trailing-slashed location because the regex is anchored at `^{path}` with an optional `(/.*)?` tail |
| `nginx_reload_scheduler` | Consumes | Hash-diff reload writes regenerated (fixed) config within one debounce tick after any change; startup write is unconditional |
| Frontend / SPA | Uses | Sibling routes (`/about`, `/auth`, `/assets`) fall through to the catch-all and are served by the registry app again |

### Constraints and Limitations Discovered
- `_SERVER_PATH_RE` allows a trailing `/` in stored paths (`/name/`); the generator must collapse it, or the render would produce `//`.
- Some write paths store paths without the leading slash (schema comment: "some callers build ServerInfo with the bare segment"); the generator must normalize both ends.
- The bare-path POST compatibility requirement (`append_mcp_path=False` servers) rules out the naive "exact + slash-only" design; see Architecture.
- The path `/` itself would render `location {ROOT_PATH}//` under naive normalization; it must special-case to a no-op location string equivalent to today's catch-all ownership (documented degenerate case; rendered as `location {{ROOT_PATH}}/`).

## Architecture

### System Context Diagram
```
Browser / MCP client
        |
        v
+-----------------------------------------------------------+
| nginx (nginx_rev_proxy_*.conf)                            |
|  location = /validate          (internal auth subrequest) |
|  {{LOCATION_BLOCKS}}                                      |
|    location {ROOT_PATH}/name/  { auth_request /validate;  |
|                                  proxy_pass .../mcp-proxy/|
|                                  name/... }   <-- FIXED   |
|  location {ROOT_PATH}/api/     { ^~ guards, registry API }|
|  location /                    (catch-all -> registry app)|
+-----------------------------------------------------------+
        |                          |
        v                          v
  auth_server :8888          registry app :7860
  POST /mcp-proxy/name/...   catch-all routes, SPA, /api
```

### Sequence Diagram (post-fix, unauthenticated browser hit on sibling route)
```
Browser -> GET /about
nginx: does /about start with any location? /a/ does NOT match /about
     -> longest match: location / (catch-all)
     -> proxy_pass 127.0.0.1:7860/about  -> registry app serves page (200)
```

### Sequence Diagram (MCP client, unchanged)
```
Client -> POST /name/mcp
nginx: matches location {ROOT_PATH}/name/
     -> auth_request /validate (session or X-Authorization)
     -> proxy_pass auth-server:8888/mcp-proxy/name/mcp  (sub-path appended by hop)
auth_server: strips transport segment for scope lookup, forwards to $backend_url
```

### Component Diagram
```
_create_location_block(path, proxy_pass_url, transport, server_info)
        |
        v
_normalize_location_path(path)     <-- NEW static helper
  - strip leading+trailing "/", drop empty segments
  - "" -> "/" ; else "/" + joined + "/"
        |
        v
  f"location {{{{ROOT_PATH}}}}{normalized} {{ ... }}"
```

## Data Models

### New Models
None. No Pydantic model, schema, or persisted shape changes.

### Model Changes
None. `ServerInfo.path` storage format, `_SERVER_PATH_RE`, and `_normalize_server_path` are unchanged.

## API / CLI Design

**Not Applicable** - no HTTP endpoint, CLI command, or nginx directive surface changes. The generated nginx config text changes as specified in Implementation Details.

## Configuration Parameters

**Not Applicable** - no new environment variables or settings. The fix is unconditional; a kill switch was considered and rejected (see Alternatives).

### Deployment Surface Checklist
No parameter changes on any surface (`.env.example`, `docker-compose.yml`, Terraform, Helm all untouched).

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Add the location-path normalizer
**File:** `registry/core/nginx_service.py`
**Lines:** new static method adjacent to `_sanitize_path_for_location` (~line 1379)

```python
@staticmethod
def _normalize_location_path(path: str) -> str:
    """Normalize a registered server path for an nginx prefix location.

    The generated block must own exactly the server's route subtree, so the
    location carries a leading AND trailing slash: nginx prefix locations
    match every URI that starts with the location string, and a bare
    `location /name` would also hijack sibling namespaces such as /apiv2 or
    (for a server registered at /a) /api and /auth. Registration validation
    (`_SERVER_PATH_RE`) guarantees the value is slug-only, so normalization
    only ever moves or adds slashes; it cannot encounter nginx metacharacters.

    Accepts the three shapes found in the wild (leading slash missing on some
    write paths, trailing slash persisted by others) and returns one canonical
    form: "/name/". The root path "/" maps to itself.
    """
    segments = [seg for seg in path.split("/") if seg]
    if not segments:
        return "/"
    return "/" + "/".join(segments) + "/"
```

#### Step 2: Use it in `_create_location_block`
**File:** `registry/core/nginx_service.py`
**Lines:** ~2362-2369 (replace the verbatim assignment)

Before:
```python
        # Use the location path exactly as specified in the server configuration
        # Users have full control over the location path format (with or without trailing slash)
        location_path = path
        logger.info(f"Creating location block for {location_path} with {transport_type} transport")

        return f"""
    location {{{{ROOT_PATH}}}}{location_path} {{{transport_settings}{common_settings}
    }}"""
```

After:
```python
        # Normalize to a leading+trailing slash so the prefix location owns
        # exactly this server's route subtree: nginx prefix locations match
        # every URI starting with the location string, so the historical
        # `location /name` also intercepted sibling namespaces (/apiv2, and
        # for a server registered at /a: /api, /auth, /about) and 401-ed
        # unauthenticated browser navigation via the block's auth_request.
        # Clients are unaffected: /name/mcp, /name/sse, /name/messages still
        # match, and servers registered with append_mcp_path=False keep their
        # bare-path POSTs working via the exact-match block below.
        location_path = self._normalize_location_path(path)
        logger.info(
            f"Creating location block for {location_path} with {transport_type} transport"
        )

        return f"""
    location = {{{{ROOT_PATH}}}}{_bare} {{
        # Bare-path compatibility for servers registered with append_mcp_path=False:
        # clients POST the registered path itself, and a prefix location /name/
        # does not match /name. Forward to the same auth_server mcp-proxy hop the
        # prefix location uses (the hop tolerates a missing transport segment --
        # _registered_server_from_proxy_path keys on the first segment alone), with
        # the same auth_request + internal-token wiring as the prefix block.
{transport_settings}{common_settings}
    }}

    location {{{{ROOT_PATH}}}}{location_path} {{{transport_settings}{common_settings}
    }}"""
```

`_bare` is `{location_path.rstrip("/")}` (the canonical path without the trailing slash; for root it collapses to `""` and the exact block is skipped entirely - `location = ` would be invalid, and the root path is already served through the catch-all).

Implementation shape (final, as coded): the method returns a string that contains BOTH blocks for non-root paths, or only the prefix block for the root path. The exact-match block is emitted FIRST so nginx longest-prefix semantics are unambiguous (`location =` wins regardless of order, but first-render keeps the generated file readable).

#### Step 3: Bare-path exact block content
The exact block duplicates the prefix block's directives except the transport `proxy_buffering`/`Connection` settings are identical anyway (they are transport-agnostic string constants), so the exact block reuses the same `transport_settings` + `common_settings` f-string fragments. There is no behavioral divergence to maintain: `proxy_pass` targets `auth-server:8888/mcp-proxy/<name>/` identically (the hop's `{server_name:path}` capture accepts the empty remainder), `auth_request /validate` authenticates the caller, and `X-Upstream-Url` binds the same `$backend_url`.

The one intentional difference: nothing in the exact block rewrites the URI, so the hop receives `/mcp-proxy/<name>` with no transport segment - matching how `_registered_server_from_proxy_path` and the sub-path append (lines 6447-6450: no `/` in capture -> no append) already behave for a bare POST today.

#### Step 4: Update the docstring
`_create_location_block`'s docstring gains one line: the location is normalized to `/name/` (plus a bare-path exact block) regardless of the input shape, and clients are expected to connect under the subtree.

### Error Handling
- No new error paths. `_normalize_location_path` is total: `""`, `/`, `//` all collapse to `/`; any slug path maps to its canonical form. Inputs are already constrained by `_SERVER_PATH_RE` at the model boundary.
- If `path` somehow arrived with nginx metacharacters (impossible post-validation, legacy data otherwise), the normalizer neither adds nor removes them; exposure is unchanged from today and still bounded by the schema validator.

### Logging
- The existing `logger.info(f"Creating location block for {location_path} ...")` line stays (now logging the normalized path - strictly more useful).

## Observability
### Tracing / Metrics / Logging Points
- No new metrics. The regenerated config is hashed and logged by `NginxReloadScheduler._do_reload_if_changed` (`Debounced nginx reload completed (hash=...)`), which is the observable signal that an existing deployment converged.
- Operators verifying convergence can diff `/etc/nginx/conf.d/nginx_rev_proxy.conf` before/after restart: `location /name {` becomes `location /name/ {` (plus the new exact-match block).

## Scaling Considerations
- Config size grows by one small block per registered server (the exact-match block): ~20 lines each, matching the per-server block that already exists. At nginx's location-table scale this is noise (hundreds of servers stay well within nginx's static-location performance envelope, which is a hash lookup for exact matches - O(1) - and a sorted prefix walk otherwise).
- The debounced reload coalescing (issue #1087) is unaffected: the scheduler hashes rendered output, and the new blocks simply change the hash once at upgrade time.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| (none) | The change is confined to existing files |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/nginx_service.py` | ~1379 (new helper), 2362-2369 | Add `_normalize_location_path`; render `/name/` prefix location + bare-path exact-match block in `_create_location_block` |
| `tests/unit/core/test_nginx_service.py` | after line 1003 | New tests: trailing-slash normalization (3 input shapes), sibling-prefix collision, bare-path exact block presence, root-path degenerate case |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~85 |
| New tests | ~95 |
| Modified code | ~12 |
| **Total** | **~190** |

## Testing Strategy
See `testing.md` for the full plan. Summary: unit tests pin the generated block shape (`location {{ROOT_PATH}}/name/`), the exact-match bare block, input-shape normalization, and the sibling-prefix collision (`/a` must not own `/api`/`/auth`/`/about`); backwards-compat tests pin `/name/mcp` + `/name/sse` sub-path routing and the version-map tolerance.

## Alternatives Considered

### Alternative 1: Exact-match redirect (308) from bare path to trailing-slash path
**Description:** Emit `location = {ROOT_PATH}/name { return 308 .../name/; }` and the `/name/` prefix block; no auth wiring in the exact block.
**Pros / Cons:** Smaller diff (no duplicated directive set), canonical-URL friendly for browsers.
**Why Rejected:** Breaks `append_mcp_path=False` servers whose MCP clients POST the bare registered path: a 308 on POST would break clients that do not follow redirects on POST (307/308 preserves method+body but several MCP client stacks do not follow at all). It also adds a redirect hop to every such tool call, forever.

### Alternative 2: Only add the trailing slash, no exact-match block
**Description:** Minimal one-line-ish change; bare `/name` falls through to the catch-all.
**Pros / Cons:** Smallest possible diff; bare POSTs to `/name` break for `append_mcp_path=False` servers (they previously matched the prefix location and proxied to the hop).
**Why Rejected:** Silently breaks a documented registration mode: with the bare path no longer matched, `POST /name` from `append_mcp_path=False` clients 404s at the catch-all. (A browser `GET /name` falling to the catch-all would be fine - the app serves it - but the POST path must keep working.)

### Alternative 3: `location ^~ {ROOT_PATH}/name/` (caret-tilde modifier)
**Description:** Same slash normalization but with `^~` to skip regex location evaluation.
**Pros / Cons:** Marginally faster matching; but the templates already rely on regex locations (the registry-only 503 block) overlapping MCP paths, and `^~` would change which block wins for requests that today fall through to those regexes (e.g. registry-only mode).
**Why Rejected:** Behavior change beyond the bug's scope; plain prefix matching preserves today's precedence.

### Alternative 4: Feature flag to toggle normalization
**Description:** `NGINX_LOCATION_TRAILING_SLASH=true/false` env var.
**Why Rejected:** Two config shapes double the test matrix and leave deployments stuck on the broken shape; the scheduler's hash-diff + `nginx -t` gate already makes convergence safe and reversible by rolling back the registry image.

### Comparison Matrix

| Criteria | Chosen (slash + exact bare block) | Alt 1 (308 redirect) | Alt 2 (slash only) | Alt 3 (^~) |
|----------|-----------------------------------|----------------------|--------------------|------------|
| Fixes sibling hijack | Yes | Yes | Yes | Yes |
| Bare POST compat (`append_mcp_path=False`) | Yes | No | No | Yes |
| Template/precedence behavior preserved | Yes | Yes | Yes | No |
| Diff size | Medium | Small | Smallest | Small |
| New redirect hop | None | Per bare call | None | None |

## Rollout Plan
- Phase 1: Implementation (this patch).
- Phase 2: Tests (`pytest tests/unit/core/test_nginx_service.py`) - designed in testing.md, not executed by this skill.
- Phase 3: Deployment - existing deployments regenerate config at next registry start (`registry/main.py` startup generation) or within one debounce tick (scheduler); `nginx -t` gates the swap and the last-good config is restored on rejection. Rollback = redeploy the previous image; the next restart regenerates the old shape.

## Open Questions
- Should virtual-server blocks get the same normalization? Deferred (Non-Goals); namespace is admin-controlled.

## References
- nginx location matching docs (prefix locations, `=`, `^~`): https://nginx.org/en/docs/http/ngx_http_core_module.html#location
- In-repo precedent: unhealthy-server commented block and A2A agent block already use trailing-slash prefix locations (`registry/core/nginx_service.py:898,1977`)
- auth_server hop sub-path append: `auth_server/server.py:6447-6450`; scope-key derivation: `_registered_server_from_proxy_path` (`auth_server/server.py:1465`)
