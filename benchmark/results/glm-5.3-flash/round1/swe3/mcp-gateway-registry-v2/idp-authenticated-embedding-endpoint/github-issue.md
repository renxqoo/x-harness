# GitHub Issue: IdP-authenticated embedding endpoint support (OAuth2 client-credentials bearer for LiteLLM embeddings)

## Title
Support IdP-issued short-lived bearer tokens for the LiteLLM embeddings provider (OAuth2 client-credentials, auto-refresh)

Ref: https://github.com/agentic-community/mcp-gateway-registry/issues/1415

## Labels
- enhancement
- security
- embeddings
- backwards-compatibility

## Description

### Problem Statement
The registry reaches cloud embedding endpoints through its LiteLLM embeddings provider
(`registry/embeddings/client.py`, `LiteLLMClient`). That path assumes a STATIC credential:
a fixed key supplied once via `EMBEDDINGS_API_KEY` and pushed into a provider environment
variable (`OPENAI_API_KEY`, etc.) when the client is constructed.

Some enterprise embedding endpoints are OpenAI-compatible on the wire but are gated by a
short-lived access token (typically a ~60 minute JWT) that the caller must obtain from an
identity provider using the OAuth2 client-credentials grant and refresh before it expires.
Today, a token pasted into `EMBEDDINGS_API_KEY` works for exactly one token lifetime, after
which every embedding call and every semantic-search query returns 401 until an operator
manually rotates the key and restarts.

### Proposed Solution
Keep the existing LiteLLM request/response path (the wire format is already correct) and add
an opt-in IdP token provider that mirrors the codebase's existing federation token-manager
pattern (`registry/services/federation/federation_auth.py`):

- A thread-safe token manager that performs the OAuth2 client-credentials flow against a
  configurable token endpoint.
- Caches the access token with a configurable expiry buffer, refreshing it automatically
  before it expires.
- Supplies a fresh bearer token on each embedding call via LiteLLM's per-call `api_key`
  parameter instead of relying on a static environment variable.

Every new setting defaults to unset/disabled. With them unset, the behaviour of all existing
providers (sentence-transformers and litellm with a static key) is byte-for-byte identical to
today. The client secret is never logged and is masked in the config UI. Misconfiguration
(IdP mode enabled with required settings missing) fails fast at startup with a clear error.
The new parameters are wired through the Docker, Terraform/ECS, and Helm deployment surfaces
plus the unified parameter reference, and the embedding-dimension / re-index caveat is
documented.

### User Stories
- As a registry operator whose organization fronts its embedding endpoint with an IdP, I want
  the registry to obtain and refresh short-lived bearer tokens automatically so that semantic
  search keeps working past the first token lifetime without manual key rotation.
- As a registry operator, I want the IdP integration to be opt-in with all new settings unset
  by default so my existing static-key deployments behave exactly as before.
- As a security reviewer, I want the client secret to never appear in logs and to be masked
  in the configuration UI so the credential does not leak through observability surfaces.
- As an operator deploying with Terraform or Helm, I want the new settings available on my
  deployment surface so I can enable IdP mode without hand-editing container env.

### Acceptance Criteria
- [ ] A new, thread-safe IdP token provider performs the OAuth2 client-credentials grant
      against a configurable token endpoint and caches the token with an expiry buffer.
- [ ] When the cached token is within the buffer of expiry, the next embedding call triggers
      a refresh automatically; concurrent callers do not stampede the token endpoint.
- [ ] With IdP mode enabled, `LiteLLMClient.encode()` passes the current bearer token
      per-call (LiteLLM `api_key` parameter) and does NOT write it into any environment
      variable.
- [ ] With the new settings unset, no token provider is constructed, no per-call `api_key`
      is injected, and the static `EMBEDDINGS_API_KEY` path behaves exactly as before.
- [ ] Startup fails fast with a clear, actionable error when IdP mode is enabled but the
      token URL, client ID, or client secret is missing.
- [ ] The client secret is never logged at any level; the config UI (`/api/config` sections)
      masks it like other secrets.
- [ ] New parameters are wired through `docker-compose.yml`, `docker-compose.prebuilt.yml`,
      `docker-compose.podman.yml`, the Terraform/ECS module (plain env + Secrets Manager for
      the secret), the Helm registry chart, and the unified parameter reference (Group 20).
- [ ] The embedding-dimension / re-index caveat (an IdP-gated endpoint often implies a
      different embedding model and dimension, which requires re-indexing) is documented in
      the embeddings docs with a pointer to the switching-models FAQ.

### Out of Scope
- Changing the LiteLLM request/response wire format for embeddings.
- Supporting authorization-code / refresh-token grants (client-credentials only).
- Automatic re-indexing triggered by a change of embedding model or dimension (documented as
  an operator task, not automated).
- Retrying an embedding call after a 401 (the refresh buffer makes this a non-event in
  normal operation; a retry-once behaviour is noted as a follow-up).
- The CDK (`infra/`) deployment surface.

### Dependencies
- None new: the token flow uses `httpx`, already a project dependency, mirroring
  `FederationAuthManager`.

### Related Issues
- #1415
