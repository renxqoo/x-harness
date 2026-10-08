# Testing Plan: IdP-Authenticated Embedding Endpoint

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies that (a) the IdP token manager performs the client-credentials grant, caches with
a buffer, and refreshes single-flight; (b) `LiteLLMClient.encode` injects the bearer per
call only in IdP mode; (c) the static path is byte-for-byte unchanged when the new settings
are unset; (d) startup fails fast on misconfiguration; (e) the secret never appears in logs
or the config UI; (f) every deployment surface carries the new variables.

### Prerequisites
- [ ] Registry repo checked out at tag `1.28.0` with the patch applied
- [ ] Python environment with project dependencies installed (`uv sync`)
- [ ] For manual E2E: a reachable OAuth2 token endpoint (or Keycloak via
      `docker compose up keycloak`) and a stub OpenAI-compatible embeddings endpoint

### Shared Variables
```bash
export REGISTRY_URL="http://localhost:8000"
export EMBEDDINGS_IDP_ENABLED="true"
export EMBEDDINGS_IDP_TOKEN_URL="http://localhost:9000/oauth2/token"
export EMBEDDINGS_IDP_CLIENT_ID="embeddings-client"
export EMBEDDINGS_IDP_CLIENT_SECRET="super-secret-value"
export EMBEDDINGS_IDP_SCOPE="embeddings.read"
export EMBEDDINGS_IDP_REFRESH_BUFFER_SECONDS="60"
```

## 1. Functional Tests

### 1.1 Unit Tests (pytest) - token manager
**File:** `tests/unit/embeddings/test_idp_token_manager.py` (new)

```bash
uv run pytest tests/unit/embeddings/test_idp_token_manager.py -v
```

Cases (use a stubbed transport; monkeypatch `httpx.Client.post` or inject a
`MockTransport`):

- **first_fetch:** no cached token -> one POST with `grant_type=client_credentials`,
  `client_id`, `client_secret` (form-encoded via `data=`), optional `scope`; returns
  `access_token` from the response.
- **cache_hit:** second `get_token()` within the buffer returns the same token and issues
  no second POST (assert call count == 1).
- **buffer_refresh:** freeze time so the cached token is `buffer - 1s` from expiry ->
  next `get_token()` triggers exactly one refresh.
- **no_stampede:** 16 threads call `get_token()` concurrently against a counting stub
  (with a `threading.Barrier` before the call) -> POST count == 1 (single-flight).
- **http_error:** endpoint returns 400/500 -> `EmbeddingsIdPTokenError` raised; message
  contains the status code.
- **network_error:** `httpx.ConnectError` -> `EmbeddingsIdPTokenError`; message contains
  the exception class name only.
- **non_json:** 200 with an HTML body -> `EmbeddingsIdPTokenError` ("non-JSON").
- **missing_access_token:** 200 JSON without `access_token` -> `EmbeddingsIdPTokenError`.
- **missing_expires_in_defaults:** 200 JSON with a token but no `expires_in` -> token
  accepted, 3600s assumed, warning logged.
- **clear_token:** after `clear_token()`, the next `get_token()` re-fetches.
- **no_secret_in_logs:** run a failing fetch under `caplog` at DEBUG -> no record contains
  the client secret or any `access_token` value; contains only status/type names.
- **no_secret_in_error_text:** assert `"super-secret-value" not in str(exc)` for every
  raised error case above.

### 1.2 Unit Tests (pytest) - LiteLLM client injection
**File:** `tests/unit/embeddings/test_embeddings_client.py` (extend factory/encode
sections)

```bash
uv run pytest tests/unit/embeddings/test_embeddings_client.py -v
```

Cases:

- **idp_mode_injects_api_key:** manager stub returns "tok-1"; monkeypatch
  `litellm.embedding` to capture kwargs -> `kwargs["api_key"] == "tok-1"`; a second call
  captures the refreshed token when the stub advances.
- **static_mode_unchanged:** no manager -> captured kwargs contain no `api_key` key
  (exactly as today).
- **idp_mode_skips_env_push:** construct `LiteLLMClient(api_key="STATIC",
  idp_token_manager=stub)` -> `OPENAI_API_KEY` is NOT set in `os.environ` (guarded
  `_set_api_key_env`).
- **combined_credentials:** IdP enabled AND `EMBEDDINGS_API_KEY` set -> the request
  carries the IdP bearer, not the static key (migration scenario).
- **factory_passthrough:** `create_embeddings_client(provider="litellm", ...,
  idp_token_manager=stub)` -> returned client holds the manager.

### 1.3 Unit Tests (pytest) - settings validation
**File:** `tests/unit/core/test_embeddings_idp_config_validation.py` (new, mirrors
`test_egress_config_validation.py` style)

```bash
uv run pytest tests/unit/core/test_embeddings_idp_config_validation.py -v
```

Cases:

- **enabled_missing_all:** `EMBEDDINGS_IDP_ENABLED=true`, nothing else -> `ValueError`
  naming all three required variables.
- **enabled_missing_one:** only token URL set -> error names the missing two.
- **bad_scheme:** `EMBEDDINGS_IDP_TOKEN_URL="ftp://x"` -> `ValueError` ("http(s)").
- **negative_buffer:** `-1` -> `ValueError`.
- **disabled_ignores:** flag false, all others garbage -> `Settings` constructs fine.
- **defaults_unset:** bare `Settings()` -> `embeddings_idp_enabled is False`, optional
  fields None, buffer == 60.
- **secret_is_secretstr:** the field is a `SecretStr`; `repr(settings)` does not contain
  the secret.

### 1.4 HTTP surface (existing config API)
No new endpoints exist; the externally visible surface is the config API:

```bash
# With the registry running and IdP settings set:
curl -s "$REGISTRY_URL/api/config" | jq '.groups[] | select(.id=="embeddings")'
# Expected: fields include embeddings_idp_enabled, token URL, client id, scope, buffer;
# embeddings_idp_client_secret has is_masked=true and value "****".

curl -s "$REGISTRY_URL/api/config/export" | grep -i "EMBEDDINGS_IDP_CLIENT_SECRET"
# Expected: the line is commented out with a masked value (sensitive handling), unless
# the export explicitly includes sensitive values.
```

Negative case: unset `EMBEDDINGS_IDP_ENABLED` with the other variables present -> registry
starts normally; the config UI shows IdP Enabled = false; no token manager is constructed
(no "Requesting embeddings IdP token" log lines at startup).

## 2. Backwards Compatibility Tests

- **Static key path untouched (grep):**
  ```bash
  git diff 1.28.0 -- registry/embeddings/client.py | grep -E "^[-+].*_set_api_key_env"
  # Expected: only the new guard line (if api_key and self.idp_token_manager is None),
  # not a removal or rewrite of the static path.
  ```
- **Default constructor equivalence (pytest):** `LiteLLMClient("openai/x", api_key="k")`
  with the patch -> `OPENAI_API_KEY == "k"` in env, exactly as before.
- **Existing suite green:**
  ```bash
  uv run pytest tests/unit/embeddings/ -v        # all pre-existing tests pass unmodified
  uv run pytest tests/unit/core/ -v              # config validation suite passes
  ```
- **compose defaults neutral:**
  ```bash
  docker compose config | grep -E "EMBEDDINGS_IDP"
  # Each new key present with an empty/false default, so an operator's untouched .env
  # produces the same container env as before plus six unset keys.
  ```

## 3. UX Tests

- **Config UI masking:** open the registry UI configuration page, Embeddings group -> the
  new fields render; the secret shows `****`; saving without touching the secret does not
  unmask it.
- **Startup banner (UX clarity):**
  ```bash
  docker compose up registry
  docker compose logs registry 2>&1 | grep -c "super-secret-value"   # expected: 0
  docker compose logs registry 2>&1 | grep -E "IdP auth"
  # Expected: "IdP auth: true" plus the token endpoint echoed once; no secret anywhere.
  ```
- **Fail-fast message clarity:** start with `EMBEDDINGS_IDP_ENABLED=true` and nothing else
  -> the registry exits at startup with
  `EMBEDDINGS_IDP_ENABLED=true requires EMBEDDINGS_IDP_TOKEN_URL, EMBEDDINGS_IDP_CLIENT_ID,
  EMBEDDINGS_IDP_CLIENT_SECRET` (exact variable names in the message).

## 4. Deployment Surface Tests

### 4.1 Docker / compose wiring
```bash
docker compose config | grep -E "EMBEDDINGS_IDP"
# Expected: 6 keys on the registry service with the LLD defaults
# (ENABLED=false, others empty / buffer 60).
```

### 4.2 Terraform / ECS wiring
```bash
cd terraform && terraform validate
terraform plan \
  -var="embeddings_idp_enabled=true" \
  -var="embeddings_idp_token_url=https://idp.example.com/oauth2/token" \
  -var="embeddings_idp_client_id=embeddings-client" \
  -var="embeddings_idp_client_secret=super-secret-value"
# Expected: registry task definition gains 5 plain env entries + 1 secret valueFrom;
# a new secretsmanager secret + version; IAM statement includes the new ARN.
```

### 4.3 Helm / EKS wiring
The chart carries these via `extraEnv` / `extraEnvFrom` (no new chart values by design):

```bash
cat > /tmp/idp-values.yaml <<'EOF'
extraEnv:
  - name: EMBEDDINGS_IDP_ENABLED
    value: "true"
  - name: EMBEDDINGS_IDP_TOKEN_URL
    value: "https://idp.example.com/oauth2/token"
  - name: EMBEDDINGS_IDP_CLIENT_ID
    value: "embeddings-client"
extraEnvFrom:
  - secretRef:
      name: embeddings-idp
EOF
helm template registry charts/registry -f /tmp/idp-values.yaml | grep -A2 "EMBEDDINGS_IDP"
# Expected: the three extraEnv entries rendered; embeddings-idp secretRef in envFrom.
kubectl create secret generic embeddings-idp --from-literal=EMBEDDINGS_IDP_CLIENT_SECRET=super-secret-value
```

### 4.4 Deploy and verify
- Bring up the full stack with IdP vars set; register a server; run a semantic search ->
  search returns results; token endpoint access logs show one grant per buffer window, not
  per query.

### 4.5 Rollback verification
- Set `EMBEDDINGS_IDP_ENABLED=false` (or unset), restart -> registry starts, semantic
  search against the static-key endpoint behaves as before; no IdP log lines.

## 5. End-to-End API Tests

**Scenario: full IdP lifecycle against a stub IdP + stub embeddings endpoint**

1. Start a stub token endpoint that counts grants and returns
   `{"access_token": "tok-<n>", "expires_in": 120}` (2-minute lifetime, 60-second buffer).
2. Start the registry with the Shared Variables above pointed at the stubs.
3. Register a server; run `POST /api/search` with a query 5 times over ~70 seconds.
4. Assert: the embeddings stub saw `Authorization: Bearer tok-1` on early calls and
   `tok-2` after the buffer window; the token stub recorded exactly 2 grants (not 5); no
   search request failed.
5. Kill the token endpoint, force an embedding call -> the registry logs an
   `EmbeddingsIdPTokenError`-derived failure via the existing search-unavailable path;
   restart the stub -> next search succeeds (recovery without registry restart).
6. Restart the registry with `EMBEDDINGS_IDP_ENABLED` unset but the static
   `EMBEDDINGS_API_KEY` set -> identical behaviour to pre-patch (same number of embedding
   calls per query, same results).

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes: token manager + injection + settings validation units
- [ ] Section 2 (Backwards Compat) verified: static path unchanged, existing suites green
- [ ] Section 3 (UX) verified: masking, banner, fail-fast message
- [ ] Section 4 (Deployment) verified or marked Not Applicable per surface actually in use
- [ ] Section 5 (E2E) verified against stub IdP
- [ ] Unit tests added under `tests/unit/embeddings/` and `tests/unit/core/`
- [ ] `uv run pytest tests/unit/` passes with no regressions
