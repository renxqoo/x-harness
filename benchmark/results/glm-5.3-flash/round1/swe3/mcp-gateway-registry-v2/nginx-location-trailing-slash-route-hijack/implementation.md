# Implementation Summary: Nginx location trailing-slash fix (route-hijack prevention)

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed

Generated nginx location blocks for registered MCP servers now carry a leading AND trailing slash (`location {ROOT_PATH}/name/`), so a server registered at `/name` owns only URIs under `/name/` and can no longer prefix-match sibling routes (`/api`, `/auth`, `/about`, `/apiv2`, ...) into its `auth_request`-guarded block. A bare-path exact-match block (`location = {ROOT_PATH}/name`) with identical auth and routing wiring keeps bare-path POSTs working for servers registered with `append_mcp_path=False`; the root path renders only the prefix block (no invalid bare exact match). Both blocks are assembled from the same f-string fragments so their wiring cannot diverge.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/core/nginx_service.py` | modified | +57 / -5 | New `_normalize_location_path` static helper (canonical `/name/` form from any input shape; root maps to itself); `_create_location_block` now normalizes the location path, emits the bare-path exact block from the same `transport_settings` + `common_settings` fragments, and its docstring replaces the old "with or without trailing slash" contract |
| `tests/unit/core/test_nginx_service.py` | modified | +75 / -0 | Five new tests: input-shape normalization (4 shapes), sibling-prefix collision (`/a` cannot own `/api`/`/auth`/`/about`/`/apiv2`), bare-path exact block with wiring-equality counts, root-path degenerate case, multi-segment path |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

## Deviations from the LLD

- The LLD's Step 2 sketch wrote the prefix block first and appended the bare block; the implementation returns `bare_block + prefix_block` so the exact match renders first, matching the LLD's stated intent ("the exact-match block is emitted FIRST"). Cosmetic ordering only; nginx `location =` precedence is order-independent.
- No other deviations. The normalizer, shared-fragment construction, root-path guard, tests, and docstring changes are implemented as designed.

## Not Implemented / Follow-ups

- Virtual-server block normalization (`_generate_virtual_server_blocks`): out of scope per LLD Non-Goals (admin-controlled `/virtual/...` namespace).
- Registration-time reservation of nginx-internal paths (`/validate`, `/oauth2`, `/api` prefixes): out of scope, noted as future hardening in review.md (Security/Sage).
- No new configuration parameters or dependencies (per design).

## Verification (not executed)

Per skill constraints, tests were designed but not run against the target repo. The full plan is `./testing.md`:

- `pytest tests/unit/core/test_nginx_service.py -q` covers the new tests (Section 1.1) plus the 9 pre-existing `location {{ROOT_PATH}}/test` substring assertions, which remain green because the substring still occurs inside the rendered `location {{ROOT_PATH}}/test/` (verified by reading, not execution).
- `git apply --check` of `patch.diff` onto a fresh checkout of `5f725c1d` passed ("patch applies cleanly onto fresh BASE_SHA checkout").
- Live-deployment convergence and the manual browser/MCP checks are specified in testing.md Sections 3 and 5 and were not executed.
