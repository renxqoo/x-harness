# Testing Plan: Server-Side OAuth Token Storage (token-reference sessions)

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies that IdP tokens are stored encrypted server-side at OAuth callback, that the session cookie stays small (metadata + `token_ref` only), that only the owning user can retrieve their tokens through the new `GET /oauth2/tokens` endpoint, that expiry/revocation behave per the TTL design, and that every legacy behavior is preserved.

### Prerequisites
- [ ] Auth server running with `SECRET_KEY` set
- [ ] MongoDB/DocumentDB reachable with `STORAGE_BACKEND=documentdb` (or `mongodb`/`mongodb-ce`/`mongodb-atlas`)
- [ ] An OAuth2 provider configured (Keycloak or Entra ID dev tenant) for manual callback tests
- [ ] For unit tests: `uv run pytest tests/unit tests/auth_server` available in the repo toolchain

### Shared Variables
```bash
export AUTH_SERVER_URL="http://localhost:8888"        # adjust to deployment
export REGISTRY_URL="http://localhost:7860"
export SESSION_COOKIE="mcp_gateway_session=<value>"   # captured from a real login below
```

Capture a session cookie from a real login (browser devtools -> Application -> Cookies -> `mcp_gateway_session`), or mint one for tests:

```bash
python - <<'PY'
import os, time
os.environ.setdefault("SECRET_KEY", "test-secret-key")
from itsdangerous import URLSafeTimedSerializer
s = URLSafeTimedSerializer(os.environ["SECRET_KEY"])
print(s.dumps({
    "username": "alice",
    "email": "alice@example.com",
    "name": "Alice",
    "groups": ["admin"],
    "provider": "keycloak",
    "auth_method": "oauth2",
    "token_ref": "tr_TESTREF0000000000000000000000000000000000000",
}))
PY
```

## 1. Functional Tests

### 1.1 `GET /oauth2/tokens` (new auth-server endpoint)

**1.1.1 Success - stored tokens returned**

```bash
curl -s -o /tmp/tokens.json -w "%{http_code}\n" \
  -H "Cookie: $SESSION_COOKIE" "$AUTH_SERVER_URL/oauth2/tokens"
```
- Expected status: `200`
- Expected headers: `Cache-Control: no-store`
- Expected body: `access_token` non-empty string, `refresh_token` string or null, `token_type` = `Bearer`, `provider` matching the login provider, `obtained_at`/`expires_at` timestamps matching the login time and TTL, `expires_in` equal to the ORIGINAL IdP `expires_in` (not recomputed from storage time).

**1.1.2 No session cookie**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$AUTH_SERVER_URL/oauth2/tokens"
```
- Expected: `401`

**1.1.3 Invalid/tampered cookie**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: mcp_gateway_session=tampered.value" "$AUTH_SERVER_URL/oauth2/tokens"
```
- Expected: `401`

**1.1.4 Legacy session (cookie without `token_ref`)**

Mint a cookie without the `token_ref` key (same script as above, drop the key), then:
- Expected: `404` with detail indicating re-login is required. MUST NOT be a 5xx.

**1.1.5 Expired record (TTL monitor has not collected it yet)**

Insert a record with `expires_at` in the past directly into `oauth_tokens_{namespace}` (or temporarily set `OAUTH_TOKEN_STORAGE_TTL_SECONDS=300` and wait), then call the endpoint with the matching cookie.
- Expected: `410`; the stale document is deleted from the collection (verify with a MongoDB query).

**1.1.6 Cross-user access denied**

Insert a record owned by `bob` but use alice's cookie with a cookie whose `token_ref` points at bob's record is impossible by construction (cookie is signed); instead directly test the repository predicate: `get_user_token(ref_of_bob, "alice")` MUST return `None`, and the endpoint returns `404` (indistinguishable from missing record - no user enumeration).

**1.1.7 Storage backend down**

Stop MongoDB (or point `documentdb_host` at a closed port), obtain a NEW login (storage failure at callback -> cookie has no `token_ref`), then call the endpoint.
- Expected: `404` (no record). Login itself must have succeeded.

### 1.2 CLI Tests

**Not Applicable** - the change adds no CLI commands.

## 2. Backwards Compatibility Tests

**2.1 Legacy cookie validation unchanged**
With a pre-change style cookie (no `token_ref`), verify normal flows still work:
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: $LEGACY_SESSION_COOKIE" "$REGISTRY_URL/api/health"   # or any authenticated GET
```
- Expected: same status as before the change (200 with a valid cookie, 401 without).

**2.2 `/validate` performs no extra database read**
Enable MongoDB query logging (or `mongostat`) and issue N authenticated requests through `/validate` with a cookie carrying `token_ref`.
- Expected: zero reads against `oauth_tokens_{namespace}` per request (count stays flat).

**2.3 `OAUTH_SERVER_SIDE_TOKEN_STORAGE=false` restores pre-change behavior**
Set the flag to `false`, restart auth server, perform a full OAuth login.
- Expected: session cookie contains NO `token_ref` key; no `oauth_tokens_` collection writes; `GET /oauth2/tokens` returns 404 for that session.

**2.4 Legacy `OAUTH_STORE_TOKENS_IN_SESSION` flag unchanged**
Set it to `true` with the new feature disabled.
- Expected: cookie carries `token_expires_in`/`token_obtained_at` metadata exactly as today (issue #490 behavior), and still no raw access/refresh tokens (that removal is intentionally permanent).

**2.5 Registry `/tokens/generate` unchanged**
```bash
curl -s -X POST -H "Cookie: $SESSION_COOKIE" -H "Content-Type: application/json" \
  -d '{"description":"compat check"}' "$REGISTRY_URL/api/tokens/generate"
```
- Expected: 200 with a self-signed registry JWT, same shape as before the change.

## 3. UX Tests

**3.1 Cookie size under large-token IdPs**
After a login against an IdP that issues large JWTs (Entra ID with group claims, or a synthetic test with a padded token), inspect the `mcp_gateway_session` cookie in browser devtools.
- Expected: size well under 4096 bytes (typically < 1.5 KB). The cookie MUST NOT be dropped by the browser (login completes and redirect lands on `/`).

**3.2 "Get JWT Token" page still works**
Log in via OAuth, open UI -> User -> Token Generation, generate a token.
- Expected: token issued as before; no UI errors. (IdP-token surfacing in the UI is explicitly deferred and out of scope.)

**3.3 Error clarity (manual)**
Call `GET /oauth2/tokens` from a legacy session via devtools console (`fetch`).
- Expected: 404 detail mentions re-login; no stack trace or internal detail in the response.

## 4. Deployment Surface Tests

### 4.1 Docker wiring
```bash
grep -n "OAUTH_SERVER_SIDE_TOKEN_STORAGE\|OAUTH_TOKEN_STORAGE_TTL_SECONDS" docker-compose.yml docker-compose.prebuilt.yml
```
- Expected: both variables passed to the auth-server service in both files.
```bash
OAUTH_SERVER_SIDE_TOKEN_STORAGE=false docker compose up -d auth-server
docker compose exec auth-server printenv | grep OAUTH_
```
- Expected: env visible in container; behavior per test 2.3.

### 4.2 Terraform / ECS wiring
```bash
grep -rn "oauth_server_side_token_storage\|oauth_token_storage_ttl_seconds\|OAUTH_SERVER_SIDE_TOKEN_STORAGE" terraform/aws-ecs/
```
- Expected: variables in `variables.tf` (root + module), passthrough in `main.tf`, container env entries in `modules/mcp-gateway/ecs-services.tf`.
```bash
cd terraform/aws-ecs && terraform validate
```
- Expected: plan/validate succeeds with the new variables defaulted.

### 4.3 Helm / EKS wiring
```bash
grep -rn "oauthServerSideTokenStorage\|oauthTokenStorageTtlSeconds" charts/auth-server/
helm template test charts/auth-server | grep -i "OAUTH_SERVER_SIDE_TOKEN_STORAGE"
```
- Expected: values.yaml keys, secret.yaml passthrough, rendered secret contains the env var.

### 4.4 Deploy and verify
Deploy to a dev environment with MongoDB backend, run tests 1.1.1, 2.2, 3.1 end-to-end.
- Expected: all pass; `oauth_tokens_{namespace}` collection exists with TTL index `ttl_expires_at`:
```bash
mongosh "$MONGO_URI" --eval 'db.getCollection("oauth_tokens_default").getIndexes()'
```

### 4.5 Rollback verification
Set `OAUTH_SERVER_SIDE_TOKEN_STORAGE=false`, redeploy, log in again.
- Expected: no new collection writes; existing stored records age out via TTL; no errors from in-flight sessions (their `token_ref` lookups simply return 404).

## 5. End-to-End API Tests

**5.1 Full happy-path journey (OAuth login -> retrieve tokens)**
1. Browse to `$REGISTRY_URL/login`, pick the provider, complete IdP login.
2. Verify `mcp_gateway_session` cookie exists, is < 4096 bytes, and (decoded via the app's signer in a REPL/script) contains `token_ref` starting with `tr_`.
3. Verify a record exists in MongoDB with `_id` = that ref, `username` = the logged-in user, and `access_token_encrypted` that does NOT contain the plaintext token substring.
4. `GET /oauth2/tokens` with the cookie -> 200 with matching tokens.
5. Log out via `/logout` (registry) which redirects through `/oauth2/logout/{provider}`.
6. Verify the record for that ref is deleted immediately (revoke) and the endpoint now returns 401 (cookie cleared).

**5.2 Re-login rotation**
Log in twice in a row.
- Expected: two distinct `token_ref` values; both records exist until TTL; retrieving with the newest cookie returns the newest record.

**5.3 Unit test suite (the automated core of this plan)**
```bash
uv run pytest tests/unit/utils/test_oauth_token_encryption.py \
              tests/unit/repositories/test_oauth_token_repository.py \
              tests/auth_server/unit/test_oauth_token_routes.py -v
```
- Expected: all pass. Coverage must include:
  - encryption roundtrip; ciphertext differs from plaintext; different SECRET_KEY fails to decrypt; purpose-specific salt differs from the credential-encryption derived key
  - model validation (required fields, optional refresh)
  - repository store/get/delete with mocked collection; compound `(token_ref, username)` query is used; expired document treated as gone
  - endpoint matrix: 200 / 401 (no cookie, bad cookie) / 404 (legacy, unknown ref, other-user ref) / 410 (expired) / 503-free degradation (repo None -> 404)
  - callback integration: with storage enabled, `token_data` tokens appear in the stored document ENCRYPTED and do NOT appear in the serialized cookie; with the repo raising, login still completes and cookie has no `token_ref`; with flag false, behavior matches legacy
  - logout revoke: record deleted; logout proceeds when the store raises

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/`
- [ ] App-level tests added under `tests/auth_server/unit/`
- [ ] `uv run pytest tests/` passes with no regressions
