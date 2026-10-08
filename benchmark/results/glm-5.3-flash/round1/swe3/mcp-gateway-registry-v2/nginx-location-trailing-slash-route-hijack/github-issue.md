# GitHub Issue: Generated nginx location blocks hijack sibling routes (missing trailing slash)

## Title

Generated MCP server nginx location blocks lack a trailing slash and hijack unrelated browser and API routes

## Labels

- bug
- nginx
- security
- routing

## Description

### Problem Statement

`NginxConfigService._create_location_block` (`registry/core/nginx_service.py`) renders the per-server reverse-proxy block as `location {ROOT_PATH}<path>` with no trailing slash. In nginx, a prefix location matches every URI that STARTS WITH the location string, so a server registered at a short path such as `/a` matches not only `/a/mcp` but also `/api/...`, `/auth`, `/about`, and every SPA route beginning with `a`.

Because every generated block carries `auth_request /validate`, an unauthenticated request to any hijacked route is rejected by the auth subrequest and returns `401 {"error": "Authentication required"}` instead of the expected page or API response. The bug is easy to miss: while a valid session cookie is present the auth_request returns 200 and the request passes through, so it only surfaces for unauthenticated requests such as post-logout redirects or direct links.

The `^~` guards on `/api/auth`, `/api/health`, `/api/version`, `/api/public/` and `/api/ard/` in `docker/nginx_rev_proxy_http_and_https.conf` protect only those specific longer matches; they do not help arbitrary siblings of a short server path.

### Proposed Solution

Normalize the generated location path to always carry exactly one trailing slash (`/name` renders `location {ROOT_PATH}/name/`), confined to the nginx config generator so no registration, storage, or client-facing contract changes. A server registered at `/name` then owns only routes under `/name/`. Existing MCP clients keep working unchanged: the transport endpoints they append (`/name/mcp`, `/name/sse`, `/name/messages`) still match the `/name/` block, and the `proxy_pass .../mcp-proxy/<name>/` hop already carries a trailing slash. For servers registered with `append_mcp_path=False` (whose MCP clients POST the bare registered path itself, which the `/name/` prefix block no longer matches), a bare-path exact-match block (`location = {ROOT_PATH}/name`) with the same auth and routing wiring forwards those requests to the same mcp-proxy hop; a bare browser `GET /name` on such a server then reaches the auth gate exactly as it did before, which is the correct behavior because for those servers the bare path IS the MCP endpoint.

### User Stories

- As a browser user, I want SPA and API routes to be reachable after logout so that I can log back in instead of seeing `{"error": "Authentication required"}` on any route whose name prefixes a registered server path.
- As a registry operator, I want a registered server to own only its own route subtree so that one tenant registering `/a` cannot shadow the gateway's `/api` surface.
- As an MCP client author, I want the connection URL (`/name/mcp`, `/name/sse`) to keep working unchanged so that no client update or re-registration is required.

### Acceptance Criteria

- [ ] `_create_location_block` renders `location {ROOT_PATH}/name/` for a server registered at `/name` (single trailing slash, never doubled).
- [ ] Path inputs without a leading slash (`name`) or with a trailing slash (`/name/`) render the identical `location {ROOT_PATH}/name/` block.
- [ ] A server registered at `/a` no longer intercepts `/api/...`, `/auth`, `/about`, or any sibling route; those fall through to the intended locations (template blocks or catch-all).
- [ ] Existing MCP clients calling `/name/mcp` and `/name/sse` still route into the server's block and reach the auth_server `/mcp-proxy/<name>/` hop with the correct sub-path appended.
- [ ] A bare `POST /name` (the `append_mcp_path=False` connection style) is still proxied to the mcp-proxy hop through a bare-path exact-match block carrying the same auth wiring; sibling routes (`/api/...`, `/auth`, `/about`) are unaffected by that block because exact matches only ever match the literal path.
- [ ] Existing deployments converge to the corrected config: startup regeneration (`registry/main.py`) rewrites the file unconditionally, and the debounced reload scheduler rewrites when the rendered hash changes.
- [ ] Unit tests cover the trailing-slash normalization and the sibling-prefix collision case.

### Out of Scope

- Virtual-server location blocks (`location {ROOT_PATH}{vs_path}` in `_generate_virtual_server_blocks`) share the same prefix-match characteristic, but their `/virtual/...` namespace is admin-controlled and prefix-disjoint from UI routes; handled as a follow-up if desired.
- The auth_server `/mcp-proxy/` hop exposes POST only; SSE GET forwarding through the hop is a pre-existing separate concern, unchanged by this fix.
- A root-path registration (`/`) rendering `location {ROOT_PATH}/` that shadows the catch-all behaves the same before and after this fix; not addressed here.
- Registration-time path validation and normalization (`_SERVER_PATH_RE`, `_normalize_server_path`) are unchanged.

### Dependencies

- None. Python-only change in the nginx config generator; no new packages, services, or infrastructure.

### Related Issues

- agentic-community/mcp-gateway-registry#1501
