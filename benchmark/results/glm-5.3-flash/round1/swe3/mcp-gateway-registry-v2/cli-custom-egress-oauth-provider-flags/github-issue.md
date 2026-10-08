# GitHub Issue: Add custom-provider OAuth flags to `egress-configure` CLI

## Title
`egress-configure --provider custom` can never succeed: CLI omits the custom_* fields the server requires

## Labels
- bug
- cli
- egress-auth
- parity

## Description

### Problem Statement
The management CLI command `egress-configure` (`api/registry_management.py`) advertises
`--provider` and accepts the value `custom`, but it defines no flags for the custom
provider fields the server-side request model requires. When an operator runs
`egress-configure --provider custom`, the request always arrives without
`custom_authorize_url` and `custom_token_url`, and the server rejects it during provider
resolution with:

```
Custom OIDC provider requires custom_authorize_url and custom_token_url.
```

There is no CLI path that can ever configure a custom egress provider. The only workaround
is to hand-craft the POST with curl:

```
POST /api/servers/{path}/egress-auth
```

This is a CLI/UI parity gap, not a deliberate restriction:

- the API request model `EgressConfigRequest` accepts five custom fields
  (`custom_authorize_url`, `custom_token_url`, `custom_scope_separator`,
  `custom_token_auth_style`, `custom_resource`) - `registry/api/egress_auth_routes.py:523`;
- the persistence schema `EgressOAuthConfig` stores them - `registry/core/schemas.py:344`;
- the React server-edit modal already sends them;
- `list_providers()` (backed by `list_provider_names()`,
  `registry/egress_auth/providers.py:69`) advertises `custom` as a selectable provider.

Per-tenant providers (for example a Salesforce org host) cannot be represented as a static
provider-registry row, so the CLI gap blocks a real configuration path.

### Proposed Solution
Add the five missing flags to the `egress-configure` subparser and forward them through
`RegistryClient.configure_egress_auth` to the existing endpoint:

| CLI flag | Request field |
|----------|---------------|
| `--custom-authorize-url` | `custom_authorize_url` |
| `--custom-token-url` | `custom_token_url` |
| `--custom-scope-separator` | `custom_scope_separator` |
| `--custom-token-auth-style` | `custom_token_auth_style` |
| `--custom-resource` | `custom_resource` |

Constraints:

- Follow the client's existing "only send what was supplied" convention: each field is
  included in the request body only when the flag was provided, so an omitted flag cannot
  null out a stored value on an edit.
- Constrain `--custom-token-auth-style` to the values the server enum accepts
  (`post_body`, `basic_header` - `registry/egress_auth/schemas.py:37`).
- Do not change the endpoint or the HTTP method.

### User Stories
- As a registry operator, I want to configure per-user egress OAuth against a custom OIDC
  provider from the management CLI, so that I do not need to hand-craft authenticated curl
  requests against the admin API.
- As a registry operator, I want to point egress OAuth at per-tenant endpoints (for example
  a Salesforce org host), so that providers without a static registry row still work.
- As a CLI user editing an existing egress config, I want omitted flags left out of the
  request, so that I do not accidentally clear stored custom provider settings.

### Acceptance Criteria
- [ ] `egress-configure` accepts `--custom-authorize-url`, `--custom-token-url`,
      `--custom-scope-separator`, `--custom-token-auth-style`, `--custom-resource`.
- [ ] `--custom-token-auth-style` only accepts `post_body` and `basic_header` (argparse
      rejects anything else with exit code 2).
- [ ] `RegistryClient.configure_egress_auth` forwards each supplied custom field in the
      JSON body and omits unsupplied ones (no `null` values sent).
- [ ] `cmd_egress_configure` passes the new namespace attributes through to the client.
- [ ] A full custom configuration (`--mode oauth_user --provider custom` plus both URLs,
      client id/secret, and any optional custom field) produces a request body containing
      all five custom fields with the operator-supplied values.
- [ ] Unit tests covering the above fail against the current tree and pass after the fix.
- [ ] The endpoint (`POST /api/servers/{path}/egress-auth`) and its method are unchanged.

### Out of Scope
- Server-side changes of any kind (routes, schemas, provider resolution, SSRF validation).
- Changes to other CLI commands or to the React UI.
- A `--provider custom`-only mode restriction or client-side validation of the URLs
  (the server remains the validation authority).
- Running the registry end-to-end against a live custom provider.

### Dependencies
- None. The server already accepts and validates all five fields.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1601
