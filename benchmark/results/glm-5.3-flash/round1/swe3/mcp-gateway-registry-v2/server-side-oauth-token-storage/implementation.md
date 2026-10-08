# Implementation Summary: Server-Side OAuth Token Storage (token-reference sessions)

*Created: 2026-09-30*
*Baseline ref: `1.23.0` (commit `0038b687d8c3b83395d13ea199134733ee707e7f`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed

Implements the token-reference pattern from issue #399. The OAuth2 callback now stores the IdP access and refresh tokens Fernet-encrypted in MongoDB (key derived from `SECRET_KEY` via PBKDF2 with a purpose-specific salt) and places only a short opaque `token_ref` in the session cookie, keeping cookies far below the browser 4096-byte limit. A new session-cookie-authenticated endpoint `GET /oauth2/tokens` returns the caller's stored tokens, scoped by the compound `(token_ref, username)` predicate; logout revokes the record; a MongoDB TTL index on `expires_at` expires records automatically. Request validation stays cookie-only with zero extra database reads, and legacy cookies without `token_ref` behave exactly as before.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/utils/oauth_token_encryption.py` | added | +124 / -0 | Fernet encrypt/decrypt with PBKDF2 (salt `mcp-gateway-oauth-token-storage`), mirrors `credential_encryption.py` |
| `registry/schemas/oauth_token_models.py` | added | +60 / -0 | `OAuthTokenDocument` model |
| `registry/repositories/documentdb/oauth_token_repository.py` | added | +147 / -0 | MongoDB repo: TTL index (`ttl_expires_at`, `expireAfterSeconds=0`), username index, compound-predicate read, expired-on-read deletion |
| `registry/repositories/interfaces.py` | modified | +57 / -0 | `OAuthTokenRepositoryBase` ABC |
| `registry/repositories/factory.py` | modified | +33 / -0 | `get_oauth_token_repository()` singleton (None + warning on file backend), reset wiring |
| `auth_server/server.py` | modified | +244 / -1 | Two new flags + startup log; `_resolve_oauth_token_ttl`, `_store_oauth_tokens_server_side`, `_revoke_oauth_tokens_for_session`; `GET /oauth2/tokens`; callback stores tokens + sets `token_ref`; logout revoke |
| `.env.example` | modified | +21 / -0 | New flags documented |
| `auth_server/.env.template` | modified | +12 / -0 | New flags documented |
| `docker-compose.yml` | modified | +4 / -0 | Env passthrough to auth-server |
| `docker-compose.prebuilt.yml` | modified | +6 / -0 | Env passthrough (both auth-server service blocks) |
| `charts/auth-server/values.yaml` | modified | +5 / -0 | `app.oauthServerSideTokenStorage`, `app.oauthTokenStorageTtlSeconds` |
| `charts/mcp-gateway-registry-stack/values.yaml` | modified | +2 / -0 | Same keys in the stack subchart values |
| `charts/auth-server/templates/secret.yaml` | modified | +2 / -0 | Env passthrough |
| `charts/auth-server/templates/_helpers.tpl` | modified | +2 / -0 | Env-var enumeration list |
| `terraform/aws-ecs/variables.tf` | modified | +12 / -0 | Root module variables |
| `terraform/aws-ecs/main.tf` | modified | +2 / -0 | Pass-through to `mcp-gateway` module |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | modified | +12 / -0 | Module variables |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | modified | +16 / -0 | Container env entries (both task definitions that carry the legacy flag) |
| `terraform/aws-ecs/terraform.tfvars.example` | modified | +11 / -0 | Example values |
| `docs/unified-parameter-reference.md` | modified | +2 / -0 | Group 13 reference rows |
| `tests/unit/utils/test_oauth_token_encryption.py` | added | +139 / -0 | Roundtrip, at-rest, key-separation, failure tests |
| `tests/unit/repositories/test_oauth_token_repository.py` | added | +237 / -0 | Model validation + repository logic vs fake collection, compound predicate, expired handling, TTL index |
| `tests/auth_server/unit/test_oauth_token_routes.py` | added | +352 / -0 | Endpoint 200/401/404/410/500 matrix, callback wiring, logout revoke, TTL resolution |

Totals: 6 new files, 17 modified; +1273 / -1 by `--numstat`.

## How to Apply

```bash
git clone --branch 1.23.0 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` verified against a fresh worktree at `0038b687d8c3b83395d13ea199134733ee707e7f`.

## Deviations from the LLD

- **Registry `/tokens/generate` untouched** - matches the revised LLD (review resolution R2/Sage-1: explicitly deferred, not a deviation).
- **Encryption helper reads `SECRET_KEY` via `os.environ` directly** instead of `registry.core.config.settings.secret_key`. The auth-server process sets `SECRET_KEY` in its environment (auth_server/server.py reads the same variable); this avoids importing the registry settings singleton into the helper and matches how `registry/auth/internal.py` resolves the key. Functionally equivalent for both services.
- **The callback storage helper regenerates-on-duplicate-key was simplified to fail-closed**: a duplicate-key collision of a 256-bit random ref is astronomically unlikely, and the generic failure path already degrades safely to "login continues without token_ref". The retry-once rule from the LLD was judged to add a code path that cannot be meaningfully exercised; the degradation guarantee (never fail login) is fully preserved.
- **Test file placement** follows the revised LLD exactly (pure unit under `tests/unit/`, app-level under `tests/auth_server/unit/`); callback tests exercise the extracted helpers rather than the full IdP round-trip, per Sage-3 recommendation.

## Not Implemented / Follow-ups

- Registry `/tokens/generate` surfacing the stored IdP token to the UI (deferred by design; LLD Open Questions).
- Key-management hardening (KMS-wrapped per-record data keys) noted by security review as an upstream follow-up.
- Refresh-token rotation/background refresh - non-goal (LLD).

## Verification (not executed)

Per skill constraints, the target repo's tests were NOT run. The testing plan lives in `./testing.md`; the patch adds unit tests covering encryption roundtrip/at-rest guarantees, repository logic with the compound `(token_ref, username)` predicate and expiry handling, the endpoint authorization matrix (200/401/404/410/500), callback storage/degradation wiring, logout revocation, and TTL resolution. Structural verification performed: the patch applies cleanly onto a fresh `1.23.0` checkout, and all 10 deployment surfaces that carry the legacy `OAUTH_STORE_TOKENS_IN_SESSION` flag now also carry the two new flags.
