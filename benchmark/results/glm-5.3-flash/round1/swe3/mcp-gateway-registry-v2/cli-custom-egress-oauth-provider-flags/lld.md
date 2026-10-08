# Low-Level Design: `egress-configure` custom-provider OAuth flags

*Created: 2026-09-29*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (post-review revisions incorporated)*

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
`egress-configure --provider custom` in the management CLI
(`api/registry_management.py`) can never succeed. The subparser accepts `--provider`
free-form, so `custom` parses fine, but the handler forwards only
`mode/provider/client_id/client_secret/scopes/target_audience` to the client. The five
`custom_*` fields that `EgressConfigRequest` (`registry/api/egress_auth_routes.py:523`)
accepts never leave the CLI, so the server's `resolve_provider`
(`registry/egress_auth/providers.py:74`) always raises
`Custom OIDC provider requires custom_authorize_url and custom_token_url.` and the
registry answers 400.

### Goals
- Add five flags to the `egress-configure` subparser that mirror the server request
  model fields one-to-one.
- Forward the fields through `RegistryClient.configure_egress_auth` using the client's
  existing "only send what was supplied" convention.
- Constrain `--custom-token-auth-style` to `post_body` / `basic_header` (the values
  `TokenEndpointAuthStyle` accepts).
- Add unit tests that fail against the pre-fix tree (missing flags, missing client
  parameters, missing payload fields).

### Non-Goals
- Any change to server-side routes, models, validation, or provider resolution.
- Client-side URL validation (the server already applies the SSRF guard and
  `resolve_provider`; duplicating it in the CLI would risk drift).
- Changes to other CLI commands, the React UI, or the endpoint/method.
- A live end-to-end run against a real custom OIDC provider.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `api/registry_management.py` | Management CLI (argparse) run via `uv run python registry_management.py` | Hosts `cmd_egress_configure` (line 2018), the `egress-configure` subparser (line 6708), and `_parse_scopes` (line 2003) |
| `api/registry_client.py` | `RegistryClient`, the registry HTTP client used by the CLI | Hosts `configure_egress_auth` (line 3877); endpoint stays `POST /api/servers/{path}/egress-auth` |
| `registry/api/egress_auth_routes.py` | FastAPI egress-auth routes | `EgressConfigRequest` (line 523) is the authoritative request shape; handler at line 561 validates custom URLs and calls `resolve_provider` |
| `registry/core/schemas.py` | Pydantic persistence schemas | `EgressOAuthConfig` (line 344) stores the five custom fields |
| `registry/egress_auth/providers.py` | Provider registry + `resolve_provider` | Defines the `custom` option and its required/optional fields (lines 93-114) |
| `registry/egress_auth/schemas.py` | `TokenEndpointAuthStyle` enum | `POST_BODY = "post_body"`, `BASIC_HEADER = "basic_header"` (lines 40-41) constrain the new flag choices |
| `tests/unit/api/` | Existing route-level unit tests | Convention: plain classes, direct imports, `unittest.mock.patch` |
| `tests/unit/cli/` | Existing CLI unit tests | Convention: `from __future__ import annotations`, `MagicMock`/`patch`, no subprocess invocation |

### Existing Patterns Identified
1. **"Only send what was supplied" client convention**
   - Files: `api/registry_client.py` (`configure_egress_auth` lines 3912-3922,
     `update_auth_credential` lines 1974-1981, `update_m2m_client` lines 5587-5595).
   - How a future implementer should follow this: build the body dict with required keys,
     then add each optional key under `if value is not None:` guards. The CLI passes
     argparse defaults of `None` for omitted flags, so a plain `if` guard on the kwarg is
     sufficient.
2. **argparse option-to-kwarg pass-through handlers**
   - Files: `api/registry_management.py` (`cmd_egress_configure` lines 2030-2038,
     `cmd_egress_pat_set` lines 2085-2092).
   - How a future implementer should follow this: handler reads `args.<snake_case>` and
     forwards positionally-named kwargs to one client method; return 0 on success, log and
     return 1 on exception.
3. **Choices-constrained flags**
   - Files: `api/registry_management.py` (`--mode` line 6717).
   - How a future implementer should follow this: use `choices=[...]` in
     `add_argument` so invalid values fail at parse time with exit code 2.
4. **JSON body for egress endpoints**
   - Files: `api/registry_client.py` `_make_request` (the `/egress-auth` branch at line
     1803 sends `data` as JSON).
   - How a future implementer should follow this: keep passing a plain dict as `data=`;
     no form-encoding needed for this endpoint.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `EgressConfigRequest` | Uses (unchanged) | New CLI flags map 1:1 onto its five `custom_*` optional fields |
| `configure_egress_auth` | Extends | New keyword-only-style optional params appended after `target_audience` (all callers are internal; no positional callers) |
| `cmd_egress_configure` | Extends | Forwards five new namespace attributes |
| `egress-configure` subparser | Extends | Five new `add_argument` calls after `--target-audience` |
| `main()` handler map | Unchanged | `"egress-configure": cmd_egress_configure` already resolves |

### Constraints and Limitations Discovered
- `--provider` is free-form (no `choices`), so the CLI cannot know at parse time whether
  the custom flags are relevant; per the issue, we do not add client-side enforcement -
  the server remains the validation authority.
- `EgressConfigRequest.custom_token_auth_style` is a plain `str | None`; the enum values
  are only enforced later at `resolve_provider`. Constraining at argparse time gives
  operators a fast, local error instead of a 400 from the server.
- The client serializes the body as JSON for this endpoint, so `None` vs omitted is
  visible to the server: a `null` value would overwrite server-side defaults on edit,
  which is exactly what the "only send what was supplied" convention avoids.
- `registry_management.py` imports only from `registry_client` (a sibling module in the
  same `api/` directory, imported at runtime as a top-level module because the CLI is run
  as a script from `api/`), so tests must not import the CLI module in a way that assumes
  package resolution of `registry_client`; mocking the client class with `patch` on the
  CLI module namespace avoids the issue.

## Architecture

### System Context Diagram
```
Operator (terminal)
   |
   | uv run python registry_management.py egress-configure --path /s \
   |     --mode oauth_user --provider custom --client-id ID --client-secret SEC \
   |     --custom-authorize-url https://tenant.example.com/oauth2/authorize \
   |     --custom-token-url https://tenant.example.com/oauth2/token \
   |     [--custom-scope-separator S] [--custom-token-auth-style post_body|basic_header]
   |     [--custom-resource https://api.example.com]
   v
cmd_egress_configure (api/registry_management.py)
   |
   | configure_egress_auth(...)  (api/registry_client.py)
   v
POST /api/servers/{path}/egress-auth      (unchanged)
   |
   v
EgressConfigRequest -> SSRF guard on custom URLs -> resolve_provider -> persist
```

### Sequence Diagram
```
CLI                 RegistryClient            Registry API
 |  args parse           |                          |
 |----.                  |                          |
 |<---'                  |                          |
 |  configure_egress_auth(mode, provider, ..., custom_*)  (new kwargs)
 |---------------------->|                          |
 |                       |  body = {egress_auth_mode, ...}      |
 |                       |  + custom_* if not None  (new)       |
 |                       |  POST /api/servers/{p}/egress-auth   |
 |                       |------------------------->|           |
 |                       |                          | validate URLs (SSRF, https)
 |                       |                          | resolve_provider(eo) -> custom OK
 |                       |           200 config view |           |
 |                       |<-------------------------|           |
 |  print JSON, exit 0   |                          |
 |<----------------------|                          |
```

### Component Diagram
```
api/registry_management.py            api/registry_client.py         server (unchanged)
+--------------------------+          +------------------------+     +----------------------+
| egress-configure parser  |          | RegistryClient         |     | EgressConfigRequest  |
|  + 5 new flags (NEW)     |--args--->|  configure_egress_auth |     |  5 custom_* fields   |
| cmd_egress_configure     |          |  + 5 new params (NEW)  |---->| SSRF guard           |
|  + 5 kwarg forwards (NEW)|          |  + 5 body keys  (NEW)  |     | resolve_provider     |
+--------------------------+          +------------------------+     +----------------------+
```

## Data Models

### New Models
None. No server-side model changes.

### Model Changes
None to persisted models. The only signature change is:

```python
# api/registry_client.py
def configure_egress_auth(
    self,
    server_path: str,
    mode: str,
    provider: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    scopes: list[str] | None = None,
    target_audience: str | None = None,
    custom_authorize_url: str | None = None,     # NEW
    custom_token_url: str | None = None,         # NEW
    custom_scope_separator: str | None = None,   # NEW
    custom_token_auth_style: str | None = None,  # NEW
    custom_resource: str | None = None,          # NEW
) -> dict[str, Any]:
```

All new parameters default to `None` so existing call sites (and any external scripts
calling the method positionally up to `target_audience`) are unaffected.

## API / CLI Design

### New Endpoints / Commands
No new endpoints. The existing `egress-configure` CLI command gains five optional flags.

**Invocation (full custom configuration):**
```bash
uv run python registry_management.py egress-configure \
  --path /github \
  --mode oauth_user \
  --provider custom \
  --client-id my-client \
  --client-secret my-secret \
  --scopes "openid,profile" \
  --custom-authorize-url "https://tenant.example.com/oauth2/authorize" \
  --custom-token-url "https://tenant.example.com/oauth2/token" \
  --custom-scope-separator " " \
  --custom-token-auth-style post_body \
  --custom-resource "https://api.example.com"
```

**Expected Output:**
The command prints the server's non-secret egress config view as JSON (unchanged shape,
now including the custom fields that were stored), exit code 0.

**Error Cases:**
- argparse: `--custom-token-auth-style foo` -> usage error, exit code 2 (before any
  network call).
- 400 from server: unknown provider, custom URLs missing/invalid (SSRF guard),
  `custom_resource` not an absolute https URI without fragment, `client_secret required`
  - surfaced by the existing handler as a logged error, exit code 1.

### Wire Format Produced (example)
```json
{
  "egress_auth_mode": "oauth_user",
  "egress_provider": "custom",
  "client_id": "my-client",
  "client_secret": "my-secret",
  "scopes": ["openid", "profile"],
  "custom_authorize_url": "https://tenant.example.com/oauth2/authorize",
  "custom_token_url": "https://tenant.example.com/oauth2/token",
  "custom_scope_separator": " ",
  "custom_token_auth_style": "post_body",
  "custom_resource": "https://api.example.com"
}
```
Omitted flags produce no key at all (not `"key": null`).

## Configuration Parameters

### New Environment Variables
None.

### Settings / Config Class Updates
None.

### Deployment Surface Checklist
Not applicable - no new configuration parameters on any deployment surface. The flags are
per-invocation CLI arguments.

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Extend `RegistryClient.configure_egress_auth`
**File:** `api/registry_client.py`
**Lines:** ~3877-3929

Append five optional parameters (see [Data Models](#data-models)) and extend the body
construction, preserving the existing guard style:

```python
        if target_audience is not None:
            body["target_audience"] = target_audience
        if custom_authorize_url is not None:
            body["custom_authorize_url"] = custom_authorize_url
        if custom_token_url is not None:
            body["custom_token_url"] = custom_token_url
        if custom_scope_separator is not None:
            body["custom_scope_separator"] = custom_scope_separator
        if custom_token_auth_style is not None:
            body["custom_token_auth_style"] = custom_token_auth_style
        if custom_resource is not None:
            body["custom_resource"] = custom_resource
```

Update the docstring Args section with the five new entries, each annotated
`(custom provider only)`.

#### Step 2: Extend `cmd_egress_configure`
**File:** `api/registry_management.py`
**Lines:** ~2018-2044

Forward the five new namespace attributes:

```python
        response = client.configure_egress_auth(
            server_path=args.path,
            mode=args.mode,
            provider=args.provider,
            client_id=args.client_id,
            client_secret=args.client_secret,
            scopes=_parse_scopes(args.scopes),
            target_audience=args.target_audience,
            custom_authorize_url=args.custom_authorize_url,
            custom_token_url=args.custom_token_url,
            custom_scope_separator=args.custom_scope_separator,
            custom_token_auth_style=args.custom_token_auth_style,
            custom_resource=args.custom_resource,
        )
```

argparse converts `--custom-authorize-url` to `args.custom_authorize_url` (default
`None` when omitted), so no default handling is needed in the handler.

#### Step 3: Extend the `egress-configure` subparser
**File:** `api/registry_management.py`
**Lines:** ~6730-6732 (after `--target-audience`)

```python
    egress_configure_parser.add_argument(
        "--custom-authorize-url",
        help="Custom OIDC authorize URL (provider custom only, https required)",
    )
    egress_configure_parser.add_argument(
        "--custom-token-url",
        help="Custom OIDC token URL (provider custom only, https required)",
    )
    egress_configure_parser.add_argument(
        "--custom-scope-separator",
        help="Scope separator for the custom provider (default: space)",
    )
    egress_configure_parser.add_argument(
        "--custom-token-auth-style",
        choices=["post_body", "basic_header"],
        help="How the client secret is sent to the custom token endpoint "
        "(default: post_body)",
    )
    egress_configure_parser.add_argument(
        "--custom-resource",
        help="RFC 8707 resource indicator (absolute https URI, no fragment)",
    )
```

#### Step 4: Add unit tests
**File:** `tests/unit/api/test_egress_configure_cli_custom_flags.py` (new file)

Three test groups, all of which fail against the pre-fix tree:

1. **Client payload tests** - construct `RegistryClient("https://reg.example", "tok")`,
   `patch("api.registry_client.requests.request")` returning a mocked response, call
   `configure_egress_auth(...)` with/without custom kwargs, and assert on the `json=`
   body captured from the mock: all five keys present with values when supplied; only
   `egress_auth_mode` present when nothing optional is supplied; no `null` values.
2. **Handler pass-through test** - build an `argparse.Namespace` with all egress
   attributes, `patch` the CLI module's `RegistryClient` symbol so `_create_client`
   resolves to a `MagicMock`, call `cmd_egress_configure(args)`, and assert the client
   mock received every custom kwarg with the namespace's values.
3. **Parser wiring test** - call `main()` under `patch("sys.argv", [...])` with the
   client patched, and assert exit codes. Invalid `--custom-token-auth-style` must exit
   2 (argparse calls `parser.error`, which raises `SystemExit(2)` - assert with
   `pytest.raises(SystemExit)`).

### Error Handling
- Unchanged: the handler wraps the client call in `try/except Exception`, logs
  `Failed to configure egress auth: {e}`, and returns 1.
- New argparse validation (`choices`) fails before any network I/O with exit code 2.

### Logging
- Unchanged: the client logs `Configuring egress auth for /{path}: mode={mode}` at INFO.
  Custom field values are URLs/metadata, not secrets, but they are not added to the log
  line (keeps parity with existing behavior and avoids log noise).

## Observability
### Tracing / Metrics / Logging Points
No new observability surfaces. Requests remain visible through the client's existing
DEBUG `"{method} {url}"` log and the INFO configure log. A rejected config still surfaces
as an ERROR log from the CLI handler.

## Scaling Considerations
Not applicable - a per-invocation CLI argument pass-through; no new load, storage, or
cache impact.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `tests/unit/api/test_egress_configure_cli_custom_flags.py` | Unit tests: client payload shape, handler pass-through, parser choices validation |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `api/registry_client.py` | ~3877-3929 | Add five optional params to `configure_egress_auth`; extend body with guarded keys; docstring |
| `api/registry_management.py` | ~2030-2038 | Forward five new args in `cmd_egress_configure` |
| `api/registry_management.py` | ~6730-6732 | Add five `add_argument` calls to the `egress-configure` subparser |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~25 (client + CLI + parser) |
| New tests | ~150 |
| Modified code | ~10 |
| **Total** | **~185** |

## Testing Strategy
See `testing.md` for the full plan. Automated coverage is concentrated in
`tests/unit/api/test_egress_configure_cli_custom_flags.py`.

## Alternatives Considered

### Alternative 1: Make `--provider` choice-aware and require custom flags up front
**Description:** Add argparse validation requiring both custom URLs when
`--provider custom`.
**Pros / Cons:** Fails faster; but duplicates server validation, risks drift with the
SSRF/`resolve_provider` rules, and complicates the parser (cross-flag dependency checks).
**Why Rejected:** The issue explicitly scopes the fix to pass-through flags; the server
remains the validation authority.

### Alternative 2: Accept a `--custom-config <json>` blob flag
**Description:** One JSON flag carrying all custom fields.
**Pros / Cons:** Fewer flags; but worse discoverability, no per-field help, no argparse
choices validation for the auth style, and inconsistent with the flag-per-field style of
every other subcommand.
**Why Rejected:** Ergonomics and convention.

### Alternative 3: Namespace the flags under a nested subcommand
**Description:** A nested argparse group.
**Pros / Cons:** Groups visually; but argparse nested subcommands complicate a flat
command surface that is otherwise purely flat.
**Why Rejected:** Unnecessary complexity.

### Comparison Matrix

| Criteria | Chosen (five flags) | Alt 1 (upfront validation) | Alt 2 (JSON blob) |
|----------|---------------------|----------------------------|-------------------|
| Complexity | Low | Medium | Medium |
| Parity with request model | Exact | Partial | Partial |
| Validation drift risk | None (server-only) | Some | Some |
| Discoverability | High | High | Low |

## Rollout Plan
- Phase 1: Implementation (this patch).
- Phase 2: Unit tests (included in the patch; designed to fail pre-fix).
- Phase 3: Deployment - ship with the next registry release; no migration or config
  change needed since the endpoint is unchanged. Operators may immediately use the new
  flags against existing deployments.

## Open Questions
- None. Deferred deliberately: client-side validation of custom URLs stays out of scope
  (server is the authority; noted in Non-Goals).

## References
- `registry/api/egress_auth_routes.py` - `EgressConfigRequest` and custom URL validation
- `registry/egress_auth/providers.py` - `resolve_provider` custom branch
- `registry/egress_auth/schemas.py` - `TokenEndpointAuthStyle` values
- Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1601
