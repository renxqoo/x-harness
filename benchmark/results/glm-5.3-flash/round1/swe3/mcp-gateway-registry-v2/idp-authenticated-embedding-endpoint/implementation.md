# Implementation Summary: IdP-Authenticated Embedding Endpoint (OAuth2 Client-Credentials Bearer for LiteLLM Embeddings)

*Created: 2026-09-30*
*Baseline ref: `1.28.0` (commit `75a39fb347778c4654a2a81ad7e7b0baf9280b2b`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Adds an opt-in IdP token provider for the LiteLLM embeddings path so enterprise
OpenAI-compatible embedding endpoints gated by short-lived IdP-issued bearer tokens keep
working past one token lifetime. A thread-safe token manager (`EmbeddingsIdPTokenManager`,
mirroring `FederationAuthManager`) performs the OAuth2 client-credentials grant, caches the
token with a configurable pre-expiry refresh buffer, and `LiteLLMClient.encode()` supplies
the fresh bearer per call via LiteLLM's per-call `api_key` - the wire format and the static
key path are untouched. With the six new settings unset (the default), behaviour is
byte-for-byte identical to `1.28.0`. Startup fails fast when IdP mode is enabled but
required settings are missing; the client secret is a `SecretStr`, never logged, and masked
in the config UI. The Docker (compose + entrypoint banner), Terraform/ECS (task env +
Secrets Manager + IAM), Helm (`extraEnv`/`extraEnvFrom`, documented), and parameter
reference surfaces are wired, including the embedding-dimension / re-index caveat.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/embeddings/idp_token_manager.py` | added | +228 / -0 | Thread-safe OAuth2 client-credentials token manager + `create_idp_token_manager` factory; raises `EmbeddingsIdPTokenError` instead of returning None; error text carries only status/exception type |
| `tests/unit/embeddings/test_idp_token_manager.py` | added | +309 / -0 | Manager tests (grant shape, cache, buffer refresh, 16-thread single-flight, error classes, no-secret-in-logs), LiteLLMClient injection tests (IdP vs static, env-push guard, factory pass-through), factory tests (disabled -> None, SecretStr unwrapped) |
| `registry/core/config.py` | modified | +77 / -1 | Six `embeddings_idp_*` settings (secret as `SecretStr`); `_validate_embeddings_idp_config()` fail-fast in `Settings.__init__` (missing vars, non-http(s) URL, negative buffer) |
| `registry/embeddings/client.py` | modified | +26 / -4 | `idp_token_manager` kwarg; per-call `api_key` injection in `encode()`; `_set_api_key_env()` skipped in IdP mode; factory pass-through |
| `registry/embeddings/__init__.py` | modified | +8 / -0 | Exports `EmbeddingsIdPTokenError`, `EmbeddingsIdPTokenManager`, `create_idp_token_manager` |
| `registry/repositories/documentdb/search_repository.py` | modified | +2 / -1 | Forwards `idp_token_manager=create_idp_token_manager(settings)` (returns None when disabled) |
| `registry/api/config_routes.py` | modified | +6 / -0 | Six config-UI field tuples; client secret flagged sensitive (masked) |
| `docker-compose.yml` | modified | +6 / -0 | Six `EMBEDDINGS_IDP_*` env entries with neutral defaults |
| `docker-compose.prebuilt.yml` | modified | +6 / -0 | Same entries |
| `docker-compose.podman.yml` | modified | +6 / -0 | Same entries |
| `docker/registry-entrypoint.sh` | modified | +6 / -0 | Banner echoes IdP enabled state, token URL, client ID; never the secret |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | modified | +39 / -0 | `embeddings_idp_*` variables; secret `sensitive = true` |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +27 / -0 | Five plain env entries + `valueFrom` for the client secret |
| `terraform/aws-ecs/modules/mcp-gateway/secrets.tf` | modified | +19 / -0 | `aws_secretsmanager_secret.embeddings_idp_client_secret` + version (mirrors `embeddings_api_key`) |
| `terraform/aws-ecs/modules/mcp-gateway/iam.tf` | modified | +1 / -0 | `secretsmanager:GetSecretValue` on the new secret ARN |
| `docs/unified-parameter-reference.md` | modified | +31 / -0 | Group 20 rows + Helm `extraEnv`/`extraEnvFrom` example + dimension caveat |
| `docs/embeddings.md` | modified | +47 / -0 | Env table rows + "IdP-Authenticated Endpoints" section + re-index caveat |

## How to Apply

```bash
git clone --branch 1.28.0 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

Verified: `git apply --check` passes against a pristine `1.28.0` clone, and the patch
reverse-applies exactly onto the edited clone (patch and tree are in sync).

## Deviations from the LLD
- The LLD's Settings field names use `embeddings_idp_*` consistently; the implementation
  matches them (`embeddings_idp_enabled`, `embeddings_idp_token_url`,
  `embeddings_idp_client_id`, `embeddings_idp_client_secret`, `embeddings_idp_scope`,
  `embeddings_idp_refresh_buffer_seconds`). No rename drift.
- The LLD sketched a `DEFAULT_EXPIRES_IN_SECONDS = 3600` constant in the manager;
  implemented as specified, including the warning log when `expires_in` is omitted
  (review finding B4).
- The LLD also listed extensions to `tests/unit/embeddings/test_embeddings_client.py` and
  a standalone `tests/unit/core/test_embeddings_idp_config_validation.py`; the equivalent
  coverage ships in the new `tests/unit/embeddings/test_idp_token_manager.py` (mocked
  settings factory tests cover the validation behaviours indirectly; the injection and
  env-push guard tests live there too). Consolidating kept the diff smaller and the
  feature tests in one file.

## Not Implemented / Follow-ups
- Retry-once-on-401 after `clear_token()`: explicitly out of scope (issue + LLD Non-Goals).
- IdP connection test button/endpoint: deferred (review, Pixel).
- Metrics for token refreshes: deferred until there is a consumer (LLD Open Questions).

## Verification (not executed)
Per the skill constraints, the target project's tests were NOT run (no pytest, terraform
validate, docker build). Verification performed:

- `git apply --check` against a pristine `1.28.0` clone: patch applies cleanly.
- Reverse-apply check: the patch matches the edited tree exactly (no stray edits).
- All Python files syntax-checked via `ast.parse` (read-only inspection of the edits,
  not execution of the project).
- All edits landed via Edit/Write against confirmed absolute paths under the clone;
  `git diff --stat` re-grounded after each batch.
- The E2E stub-IdP scenario in `testing.md` covers grant caching, buffer refresh, and
  recovery; the unit tests shipped in the patch cover the manager, injection, and factory.
