# Low-Level Design: Server-Side OAuth Token Storage (token-reference sessions)

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Revised after expert review (see review.md resolutions)*

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

OAuth session cookies exceed the browser's 4096-byte per-cookie limit when they carry IdP access and refresh tokens (~500 B metadata + 2-3 KB JWT + 2-3 KB refresh token + serialization overhead is about 7 KB). Browsers silently drop oversized cookies, breaking login for Entra ID (group claims) and Keycloak (custom attributes) users. Since issue #490 the tokens are simply not stored (`OAUTH_STORE_TOKENS_IN_SESSION` defaults to `false`), so the "Get JWT Token" feature cannot return the user's real IdP tokens.

### Goals

- Store IdP `access_token` / `refresh_token` server-side in MongoDB, encrypted at rest.
- Keep the session cookie at metadata size plus one ~50-char opaque reference (`token_ref`).
- Serve the tokens back to the authenticated owner on demand (`GET /oauth2/tokens` on the auth server).
- Auto-expire stored tokens with a TTL index aligned to the session lifetime; revoke on logout.
- Zero extra database reads on the normal request-validation hot path.
- Full backwards compatibility: legacy cookies without `token_ref` behave exactly as today.

### Non-Goals

- Refresh-token rotation or background refresh of IdP tokens (documented limitation: stored access tokens may outlive their IdP validity; retrieval returns them as stored).
- Rotation of the encryption key (single PBKDF2-derived Fernet key, same model as existing credential encryption).
- Storing tokens for M2M/client-credential flows.
- Any new UI surface; the existing "Get JWT Token" page keeps working through its existing `/api/tokens/generate` backend.
- File-backend support for the token store (degrades to "not stored", like `BackendSessionRepository`).

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `auth_server/server.py` (3337 lines) | Auth-server FastAPI app: OAuth2 login/callback/logout, session cookie creation, `/validate`, internal token API | Hosts the callback change (store tokens, add `token_ref`), the new retrieval endpoint, and the logout revoke |
| `auth_server/server.py:96-105` | `OAUTH_STORE_TOKENS_IN_SESSION` flag (default false) and legacy metadata storage | Legacy flag kept as-is; new behavior is independent of it |
| `auth_server/server.py:3055-3066` | Session-data assembly in `oauth2_callback` (tokens already excluded, `id_token` kept for OIDC logout) | Insertion point for server-side storage + `token_ref` |
| `auth_server/server.py:630-690` | `validate_session_cookie` (itsdangerous `URLSafeTimedSerializer`, `max_age=28800`) | Must stay cookie-only; untouched |
| `auth_server/server.py:2556-2567` | `SECRET_KEY` resolution + global `signer` | Encryption key source; same env var, no new secret surface |
| `registry/utils/credential_encryption.py` | Fernet encrypt/decrypt with PBKDF2 key derivation from `SECRET_KEY` | The exact pattern to replicate with a purpose-specific salt |
| `registry/repositories/interfaces.py:1248+` | `BackendSessionRepositoryBase` ABC | Template for the new `OAuthTokenRepositoryBase` interface |
| `registry/repositories/documentdb/backend_session_repository.py` | MongoDB repo with TTL index (`expireAfterSeconds`), `get_collection_name` namespacing, lazy collection + `ensure_indexes` | Template for `DocumentDBOAuthTokenRepository` |
| `registry/repositories/factory.py` | Singleton getters, `MONGODB_BACKENDS` gating, `reset_repositories()` | Add `get_oauth_token_repository()` following `get_backend_session_repository()` |
| `registry/repositories/documentdb/client.py` | Shared async MongoDB client, `get_collection_name(base)` -> `"{base}_{namespace}"` | Reused directly |
| `registry/core/config.py:28-35,549` | `MONGODB_BACKENDS` frozenset, `storage_backend` setting | Backend gating logic |
| `registry/api/server_routes.py:2357-2470` | `/tokens/generate` UI flow: reads full session data, calls auth-server `/internal/tokens` with an internal JWT | The "Get JWT Token" path; gains nothing required, but confirms the session-cookie contract |
| `registry/auth/dependencies.py` | `signer = URLSafeTimedSerializer(settings.secret_key)`, `get_user_session_data` | Registry-side session decode; cookie payload must remain small and signature-compatible |
| `registry/auth/internal.py` | Internal service JWT (`iss=mcp-auth-server`, `aud=mcp-registry`, TTL 60 s, shared `SECRET_KEY`) | Considered for an internal retrieval variant; not needed for this patch |
| `auth_server/oauth2_providers.yml:131-138` | Session settings: `max_age_seconds: 28800`, secure/httponly/samesite/domain | TTL default (8 h) aligned to this |
| `tests/auth_server/conftest.py`, `tests/auth_server/unit/providers/test_auth0.py` | Test conventions: auto-mocks before import, `pytestmark = [pytest.mark.unit, pytest.mark.auth]` | Test placement and style for the new unit tests |
| `tests/unit/test_backend_session_repository.py` | Model + route unit-test style with pydantic validation tests | Model test template |
| `tests/unit/utils/test_credential_encryption.py` | Fernet roundtrip/at-rest test style | Encryption test template |
| `.env.example:655-660`, `auth_server/.env.template:47-49`, `docker-compose.yml`, `docker-compose.prebuilt.yml`, `charts/auth-server/templates/secret.yaml`, `charts/auth-server/values.yaml`, `charts/mcp-gateway-registry-stack/values.yaml`, `terraform/aws-ecs/{variables.tf,main.tf,modules/mcp-gateway/variables.tf,modules/mcp-gateway/ecs-services.tf}`, `docs/unified-parameter-reference.md` | Every deployment surface of the legacy `OAUTH_STORE_TOKENS_IN_SESSION` flag | The new flag(s) must be wired on the same surfaces |

### Existing Patterns Identified

1. **Repository ABC + DocumentDB implementation + factory singleton** (e.g. `BackendSessionRepository`)
   - Files: `registry/repositories/interfaces.py`, `registry/repositories/documentdb/backend_session_repository.py`, `registry/repositories/factory.py`
   - How a future implementer should follow this: define `OAuthTokenRepositoryBase` ABC; implement `DocumentDBOAuthTokenRepository` with lazy `_get_collection()` and `ensure_indexes()` creating the TTL index; expose `get_oauth_token_repository()` singleton that returns `None` with a warning for non-MongoDB backends; add the singleton to `reset_repositories()`.
2. **Fernet-at-rest encryption derived from `SECRET_KEY`** (`credential_encryption.py`)
   - Files: `registry/utils/credential_encryption.py`, sibling `federation_encryption.py`
   - How to follow: copy the `_derive_fernet_key` / `_get_fernet` structure with a new purpose-specific salt (`mcp-gateway-oauth-token-storage`) so a stolen ciphertext from one store cannot be replayed in another; add small `encrypt_token` / `decrypt_token` helpers.
3. **TTL-based cleanup** (`backend_session_repository.py`)
   - How to follow: datetime field (`expires_at`) + `create_index([("expires_at", ASCENDING)], expireAfterSeconds=0)`; MongoDB's TTL monitor deletes expired docs within ~60 s.
4. **Opaque random reference strings**: `secrets.token_urlsafe(32)` already used for OAuth `state` (auth_server/server.py:2714).
5. **Internal service auth**: `internal_router` with router-level `Depends(validate_internal_auth)`; purpose-tagged JWTs.
6. **Auth-server unit tests**: import-time auto-mocking in `tests/auth_server/conftest.py`; `pytestmark = [pytest.mark.unit, pytest.mark.auth]`.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `oauth2_callback` (auth_server) | Extends | After building `session_data`, store tokens + build `token_ref`; add `token_ref` to session payload |
| Session cookie (`mcp_gateway_session`) | Extends | One new short key `token_ref`; signature scheme, serializer, and all existing keys unchanged |
| `/oauth2/logout/{provider}` | Extends | Best-effort `delete_by_ref` when the pre-logout cookie carries a `token_ref` |
| `GET /oauth2/tokens` (new, auth_server) | New endpoint | Session-cookie authenticated; returns caller-owned stored tokens |
| `get_oauth_token_repository()` (new, factory) | New | Consumed by auth_server callback/logout/retrieval |
| `/tokens/generate` (registry) | Untouched | Confirms the broken IdP-token path; not modified in this patch (deferred, see review resolution R2) |
| MongoDB client | Uses | `registry.repositories.documentdb.client.get_documentdb_client` / `get_collection_name` |

### Constraints and Limitations Discovered

- **Cookie-only validation requirement**: `/validate` and registry middleware resolve identity from the signed cookie alone; the design must not add a lookup there. (Satisfied: `token_ref` is opaque; nothing reads the store during validation.)
- **Shared `SECRET_KEY` across services**: key reuse is unavoidable without a new secret; PBKDF2 with a purpose-specific salt domain-separates the derived Fernet key (same approach the repo already accepts for credentials and federation secrets).
- **File backend deployments**: `get_backend_session_repository()` returns `None` with a warning; the token store copies that degradation. Login must never fail because the store is unavailable.
- **DocumentDB TTL monitor granularity**: deletions happen within about 60 s of expiry; retrieval must therefore also treat `expires_at <= now` as not found (defense in depth).
- **auth_server imports registry modules already** (`registry.core.config`, `registry.utils...`), so placing the encryption helper under `registry/utils/` and the repository under `registry/repositories/` introduces no new import direction.

## Architecture

### System Context Diagram

```
+--------+     1. /auth/{provider} 302      +-------------+     2. /oauth2/login 302
| Browser| --------------------------------> |  Registry   | ---------------------------> IdP
|        | <--------------------------------| (FastAPI)   | <----------------------------+
|        |     7. cookie set, redirect       +-------------+        3. authorize (IdP UI)
|        |                                                                        |
|        | 4. callback w/ code                                                    v
|        | +--------------------------------------------------------------> Auth Server
|        |                                                   5. code->tokens (IdP) |
|        |                                                   6. tokens -> MongoDB  |
|        |                                                      (encrypted, TTL)   |
|        |                       cookie = metadata + token_ref (~small)           |
|        |                                                                        |
|        | 8. GET /oauth2/tokens (cookie)  --------------------------------------> |
|        | <---- access/refresh tokens for THIS user+ref only --------------------+
+--------+
```

### Sequence Diagram (callback)

```
Browser      AuthServer                          MongoDB
  |--GET /oauth2/callback/{provider}-->|              |
  |                                    |--code->IdP-->|
  |                                    |<--token_data-|
  |                                    |--insert {token_ref, enc(access), enc(refresh),
  |                                    |    username, expires_at}----------->|
  |                                    |<------------------------------------|
  |<--302 Set-Cookie mcp_gateway_session={...user..., token_ref:"tr_..."}----|
```

### Component Diagram

```
auth_server/server.py
  oauth2_callback -----> oauth_token_store.store_tokens() ----> DocumentDBOAuthTokenRepository
  oauth2_logout ------> oauth_token_store.delete_by_ref() --->   (TTL index on expires_at)
  GET /oauth2/tokens -> oauth_token_store.get_user_token() --> 
registry/repositories
  interfaces.py: OAuthTokenRepositoryBase (new)
  documentdb/oauth_token_repository.py (new)
  factory.py: get_oauth_token_repository() (new singleton)
registry/utils/oauth_token_encryption.py (new: encrypt_token/decrypt_token, PBKDF2 salt)
```

## Data Models

### New Pydantic model (`registry/schemas/oauth_token_models.py`)

```python
class OAuthTokenDocument(BaseModel):
    """MongoDB document holding one OAuth login's encrypted IdP tokens."""

    token_ref: str = Field(
        ...,
        min_length=8,
        max_length=128,
        description="Opaque reference embedded in the session cookie ('tr_' + 32 url-safe bytes)",
    )
    username: str = Field(..., min_length=1, description="Owner; retrieval is scoped to this identity")
    provider: str | None = Field(default=None, description="OAuth2 provider that issued the tokens")
    access_token_encrypted: str = Field(..., description="Fernet ciphertext of the IdP access token")
    refresh_token_encrypted: str | None = Field(default=None, description="Fernet ciphertext of the IdP refresh token")
    expires_in: int | None = Field(default=None, description="IdP-reported token lifetime in seconds")
    obtained_at: datetime = Field(default_factory=_utc_now)
    expires_at: datetime = Field(..., description="TTL boundary; drives the MongoDB TTL index")
```

Notes: it mirrors `BackendSessionDocument` (same module style, `_utc_now` helper). The Fernet ciphertext is opaque to MongoDB; no plaintext field exists anywhere in the schema. `id_token` is intentionally NOT stored server-side - it stays in the cookie as today because OIDC logout needs it and it is identity info, not a credential.

### New session-cookie key

`session_data["token_ref"] = "tr_<43 chars>"` - adds roughly 60 bytes to the cookie. All existing keys and the itsdangerous signature are unchanged.

## API / CLI Design

### New Endpoint: `GET /oauth2/tokens` (auth server)

**Description:** Returns the current user's stored IdP tokens. Session-cookie authenticated only (Bearer JWT auth is deliberately NOT accepted: a stateless bearer cannot prove ownership of the interactive session that created the record). The response is sensitive: it MUST be sent with `Cache-Control: no-store` so no proxy or browser cache retains IdP tokens. CORS must remain closed for this route (default). Intended for on-demand display/copy by the user, never client-side persistence. Client error mapping for future UI consumers: 401 -> redirect to login, 404 -> prompt re-login (legacy session or storage disabled), 410 -> prompt re-login (expired).

**Request / Invocation:**

```bash
curl -b "mcp_gateway_session=<cookie>" https://<auth-server>/oauth2/tokens
```

**Expected Response (200):**

```json
{
  "access_token": "<idp access token>",
  "refresh_token": "<idp refresh token or null>",
  "token_type": "Bearer",
  "expires_in": 3599,
  "provider": "entra",
  "obtained_at": 1727712000,
  "expires_at": 1727715599
}
```

**Error Cases:**

- 401: missing/invalid session cookie (or cookie without a valid user).
- 404: no stored record for this session's `token_ref` (covers legacy sessions, `token_ref` absent, storage disabled, and file-backend deployments).
- 410: record exists but `expires_at` has passed (TTL monitor has not collected it yet); the stale record is deleted on sight.
- 500: storage backend error while reading.

### Modified Endpoint: `GET /oauth2/logout/{provider}` (auth server)

Behavior unchanged externally. Internally, before clearing cookies, it best-effort deletes the stored token record referenced by the inbound session cookie.

### Internal config surface

None beyond the new environment variables below.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `OAUTH_SERVER_SIDE_TOKEN_STORAGE` | bool | `true` | No | Enable server-side storage of IdP tokens + `token_ref` cookie reference. When false, callback behaves exactly as today. |
| `OAUTH_TOKEN_STORAGE_TTL_SECONDS` | int | `28800` | No | TTL for stored tokens; 0 means "derive from session max_age_seconds". Clamped to [300, 86400]. |

### Settings / Config Class Updates

None in `registry/core/config.py` - the flags are read in `auth_server/server.py` exactly like the existing `OAUTH_STORE_TOKENS_IN_SESSION` (plain `os.environ.get` parsing at module scope), keeping the auth-server surface self-contained. The TTL default is aligned with `OAUTH2_CONFIG["session"]["max_age_seconds"]` (28800) at runtime when unset/zero.

### Deployment Surface Checklist

Mirror the wiring of `OAUTH_STORE_TOKENS_IN_SESSION` (verified locations in the tree):

- [ ] `.env.example` (new block after line 660)
- [ ] `auth_server/.env.template` (after line 49)
- [ ] `docker-compose.yml` (auth-server service environment)
- [ ] `docker-compose.prebuilt.yml` (auth-server service environment)
- [ ] `charts/auth-server/values.yaml` (`app.oauthServerSideTokenStorage`, `app.oauthTokenStorageTtlSeconds`)
- [ ] `charts/auth-server/templates/secret.yaml` (env passthrough)
- [ ] `terraform/aws-ecs/variables.tf` + `terraform/aws-ecs/main.tf` + `terraform/aws-ecs/modules/mcp-gateway/variables.tf` + `modules/mcp-gateway/ecs-services.tf`
- [ ] `docs/unified-parameter-reference.md` (Group 13 table row, same pattern as `OAUTH_STORE_TOKENS_IN_SESSION`)

## New Dependencies

None. `cryptography` (Fernet) and `motor`/`pymongo` are already dependencies. This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Encryption helpers
**File:** `registry/utils/oauth_token_encryption.py` (new)

Copy the structure of `registry/utils/credential_encryption.py` with two differences: a purpose-specific salt `b"mcp-gateway-oauth-token-storage"` and dict-free `encrypt_token` / `decrypt_token` signatures. `decrypt_token` returns `None` on `InvalidToken` (key mismatch or corruption) instead of raising.

```python
_KEY_DERIVATION_SALT: bytes = b"mcp-gateway-oauth-token-storage"

def encrypt_token(token: str) -> str: ...      # raises ValueError if SECRET_KEY missing
def decrypt_token(encrypted: str) -> str | None: ...
```

#### Step 2: Pydantic models
**File:** `registry/schemas/oauth_token_models.py` (new)

`OAuthTokenDocument` as specified under Data Models, plus module-level `_utc_now()` helper matching `backend_session_models.py`.

#### Step 3: Repository interface
**File:** `registry/repositories/interfaces.py` (append new ABC)

```python
class OAuthTokenRepositoryBase(ABC):
    @abstractmethod
    async def ensure_indexes(self) -> None: ...
    @abstractmethod
    async def store_tokens(self, doc: OAuthTokenDocument) -> None: ...
    @abstractmethod
    async def get_user_token(self, token_ref: str, username: str) -> OAuthTokenDocument | None: ...
    @abstractmethod
    async def delete_by_ref(self, token_ref: str) -> None: ...
```

#### Step 4: DocumentDB implementation
**File:** `registry/repositories/documentdb/oauth_token_repository.py` (new)

- Collection name: `get_collection_name("oauth_tokens")` -> `oauth_tokens_{namespace}`.
- `ensure_indexes()`: TTL index `[("expires_at", ASCENDING)]` with `expireAfterSeconds=0`, name `ttl_expires_at`; secondary index on `username` (name `idx_username`) for operator queries.
- `store_tokens`: `replace_one({"_id": token_ref}, doc.model_dump(mode="json"), upsert=True)` - `_id` is the `token_ref`, giving O(1) lookup and natural one-record-per-login semantics.
- `get_user_token`: `find_one({"_id": token_ref, "username": username})`; additionally check `expires_at` client-side and treat expired as not found (TTL monitor lag defense).
- `delete_by_ref`: `delete_one({"_id": token_ref})`.

#### Step 5: Factory
**File:** `registry/repositories/factory.py`

Add `_oauth_token_repo` singleton, `get_oauth_token_repository() -> OAuthTokenRepositoryBase | None` (returns `None` + warning for non-MongoDB backends, mirroring `get_backend_session_repository()`), and include it in `reset_repositories()`.

#### Step 6: Auth-server callback change
**File:** `auth_server/server.py` (in `oauth2_callback`, right after `session_data` construction, before `signer.dumps`)

```python
token_ref = None
if OAUTH_SERVER_SIDE_TOKEN_STORAGE and token_data.get("access_token"):
    repo = get_oauth_token_repository()
    if repo is not None:
        try:
            token_ref = "tr_" + secrets.token_urlsafe(32)
            ttl = _resolve_oauth_token_ttl()          # env or session max_age, clamped
            await repo.store_tokens(OAuthTokenDocument(
                token_ref=token_ref,
                username=mapped_user["username"],
                provider=provider,
                access_token_encrypted=encrypt_token(token_data["access_token"]),
                refresh_token_encrypted=encrypt_token(token_data["refresh_token"])
                    if token_data.get("refresh_token") else None,
                expires_in=token_data.get("expires_in"),
                expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            ))
            session_data["token_ref"] = token_ref      # ~60 bytes in the cookie
        except Exception as e:
            logger.warning(f"OAuth token server-side storage failed (login continues): {e}")
```

Failure semantics: ANY storage problem logs a warning and continues with today's behavior (no `token_ref` in the cookie). Login never fails because of the store. On duplicate-key error from the upsert (astronomically unlikely with a 256-bit ref), regenerate the ref once and retry a single time - never loop.

Logging invariants (normative): never log `token_data` or any token material; log token refs truncated to a 6-char prefix (`tr_abc123`); log usernames via the existing `hash_username()` helper; never include token material in exception messages.

#### Step 7: Retrieval endpoint
**File:** `auth_server/server.py` (new route near the other `/oauth2/*` routes)

```python
@app.get("/oauth2/tokens")
async def get_oauth_tokens(request: Request):
    # 1. Extract mcp_gateway_session cookie; invalid/expired -> 401.
    # 2. data = signer.loads(cookie, max_age=28800); no username -> 401.
    # 3. token_ref = data.get("token_ref"); absent -> 404 (legacy session).
    # 4. repo None -> 404. get_user_token(token_ref, data["username"]) None -> 404.
    # 5. Doc found but expired -> delete + 410. Else decrypt and return 200 payload.
    # Decryption failure -> 500 with generic detail (log includes ref prefix only).
```

Response model `StoredOAuthTokensResponse` (pydantic) declared next to the other response models.

#### Step 8: Logout revoke
**File:** `auth_server/server.py` (in `oauth2_logout`, early)

Load the inbound cookie best-effort (`signer.loads`, wrapped in try/except); if it yields a `token_ref`, call `delete_by_ref(token_ref)`. Never block logout on storage errors.

#### Step 9: Config flag + wiring
**File:** `auth_server/server.py` (module scope, next to `OAUTH_STORE_TOKENS_IN_SESSION`), plus every deployment surface from the checklist. `OAUTH_SERVER_SIDE_TOKEN_STORAGE` defaults to `true` (the whole point of the issue); operators opt out explicitly. `OAUTH_TOKEN_STORAGE_TTL_SECONDS` default `28800`, `0` -> derive from `OAUTH2_CONFIG["session"]["max_age_seconds"]`, clamped to `[300, 86400]`.

#### Step 10: Unit tests
**Files (pure-logic, under `tests/unit/`):** `tests/unit/utils/test_oauth_token_encryption.py`, `tests/unit/repositories/test_oauth_token_repository.py` (model validation + repository logic with a mocked Motor collection).
**Files (app-level, under `tests/auth_server/unit/`, where the conftest auto-mock environment lives):** `tests/auth_server/unit/test_oauth_token_routes.py` - endpoint via `TestClient` with mocked repo; set `SECRET_KEY` in `os.environ` BEFORE importing `auth_server.server` so cookie fixtures sign with a known key. Follow existing marking conventions (`pytestmark = [pytest.mark.unit, pytest.mark.auth]`).

### Error Handling

- Storage down at callback: warn + proceed without `token_ref` (feature degradation, auth unaffected).
- Storage down at retrieval: 500 with generic detail; log includes `token_ref` prefix only.
- Decrypt failure at retrieval: 500, generic detail (would indicate key rotation/corruption).
- Expired (TTL not yet collected): document exists and `expires_at <= now` -> delete on sight + 410; document missing -> 404.
- Logout with no/unreadable cookie: skip revoke silently (info log), continue logout.

### Logging

- Callback: one info line `Server-side OAuth token storage: stored ref tr_<6-char prefix> for user <hash>` on success; warning on failure (never log tokens, never log full refs).
- Retrieval: info on success with hashed username; warnings on 401/404 paths.
- Index creation: reuse the repository `logger.info(f"Created indexes for {collection} ...")` pattern.

## Observability

- Log events: `oauth_token_storage_enabled` at startup (mirroring the existing `OAUTH_STORE_TOKENS_IN_SESSION` log), `oauth_token_stored`, `oauth_token_storage_failed`, `oauth_token_revoked`, `oauth_token_retrieved`, `oauth_token_expired`.
- No new metrics (the auth-server metrics middleware already records per-route latency/status for the new endpoint automatically via `add_auth_metrics_middleware`).
- Operators can inspect `oauth_tokens_{namespace}` collection size and TTL index state via standard MongoDB tooling.

## Scaling Considerations

- One document per login; old documents age out via TTL. Document size is dominated by ciphertext (a few KB); at 10k logins/day with 8 h TTL the steady state is roughly 3-4k documents - trivial for MongoDB/DocumentDB.
- Lookup is `_id` point-read; no collection scans. Normal request validation adds zero reads (cookie-only).
- Horizontal scaling is safe: all state lives in MongoDB; the Fernet key derives from the shared `SECRET_KEY` present on every auth-server replica.
- Bottleneck: the TTL monitor deletes in batches; a login storm produces delayed deletions but correctness is preserved by the `expires_at` check on read.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `registry/utils/oauth_token_encryption.py` | Fernet encrypt/decrypt helpers, purpose-specific PBKDF2 salt |
| `registry/schemas/oauth_token_models.py` | `OAuthTokenDocument` model |
| `registry/repositories/documentdb/oauth_token_repository.py` | MongoDB repository with TTL index |
| `tests/unit/utils/test_oauth_token_encryption.py` | Encryption unit tests |
| `tests/unit/repositories/test_oauth_token_repository.py` | Model + repository unit tests (mocked collection) |
| `tests/auth_server/unit/test_oauth_token_routes.py` | Retrieval endpoint + callback wiring tests (app-level) |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/repositories/interfaces.py` | end | Add `OAuthTokenRepositoryBase` ABC |
| `registry/repositories/factory.py` | ~15 | Add singleton getter + reset wiring |
| `auth_server/server.py` | ~120 | Import new modules; two new flags; callback stores tokens + sets `token_ref`; new `GET /oauth2/tokens`; logout revoke; response model |
| `.env.example` | +8 | Document both new vars |
| `auth_server/.env.template` | +6 | Document both new vars |
| `docker-compose.yml` | +2 | Pass new vars to auth-server |
| `docker-compose.prebuilt.yml` | +2 | Pass new vars to auth-server |
| `charts/auth-server/values.yaml` | +2 | `app.oauthServerSideTokenStorage`, `app.oauthTokenStorageTtlSeconds` |
| `charts/auth-server/templates/secret.yaml` | +2 | Env passthrough |
| `terraform/aws-ecs/variables.tf` | +8 | Two new variables |
| `terraform/aws-ecs/main.tf` | +6 | Pass-through to module |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | +8 | Two new variables |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | +2 | Container env entries |
| `docs/unified-parameter-reference.md` | +2 | Reference-table rows |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~330 |
| New tests | ~400 |
| Modified code | ~180 |
| **Total** | **~910** |

## Testing Strategy

See `testing.md` for the full executable plan. Summary: unit tests for encryption roundtrip + at-rest guarantee, repository CRUD + TTL/user-scoping with a mocked Motor collection, endpoint authorization matrix (401/404/410/200), callback integration (stores encrypted, cookie stays small, degradation path), logout revoke, and legacy-cookie backwards compatibility. Tests are designed but NOT executed by this skill.

## Alternatives Considered

### Alternative 1: Shrink/split the cookie (chunking)
**Description:** Split the session across multiple cookies to fit the 4096-byte limit.
**Pros / Cons:** No new storage; but multiple cookies multiply request overhead, some proxies reject cumulative cookie size, and tokens still sit client-side in plaintext-readable form.
**Why Rejected:** Does not fix the root cause; still leaks credentials to the browser.

### Alternative 2: Encrypt tokens into the cookie (encrypted cookie)
**Description:** Keep tokens in the cookie but Fernet-encrypt the whole payload.
**Pros / Cons:** No server state; but the cookie grows even larger (ciphertext + base64 overhead), making the original problem worse.
**Why Rejected:** Directly conflicts with the 4096-byte constraint.

### Alternative 3: Redis with in-memory TTLs
**Description:** Store token records in Redis with per-record TTL.
**Pros / Cons:** Fast, natural TTLs; but introduces a brand-new infrastructure dependency for deployments that already run MongoDB, and the repo has no Redis client pattern to follow.
**Why Rejected:** New dependency when an owned store already exists and TTL indexes are a solved pattern in this codebase.

### Comparison Matrix

| Criteria | Chosen (MongoDB + token_ref) | Cookie chunking | Encrypted cookie | Redis |
|----------|------------------------------|-----------------|------------------|-------|
| Cookie size fixed | Yes | Partially | No | Yes |
| Tokens encrypted at rest | Yes | No | Yes | Optional |
| New infrastructure | None | None | None | Redis |
| Fits repo patterns | Yes | No | Partially | No |
| Complexity | Medium | Low | Low | Medium |

## Rollout Plan

- Phase 1: Implementation (this patch).
- Phase 2: Testing per `testing.md` (unit suite; manual callback run against a Keycloak/Entra dev tenant).
- Phase 3: Deployment - flag defaults on for MongoDB-backed deployments; file-backend deployments get the warning + no-op behavior; rollback is a single env var (`OAUTH_SERVER_SIDE_TOKEN_STORAGE=false`) with no schema migration needed.

## Open Questions

- Whether the registry's `/tokens/generate` response should embed the stored IdP access token (via a new internal auth-server route) in a later iteration; deferred to keep this patch focused (see review resolution R2).

## References

- `registry/utils/credential_encryption.py` - Fernet + PBKDF2 pattern replicated here.
- `registry/repositories/documentdb/backend_session_repository.py` - TTL index pattern replicated here.
- Issue #490 - prior removal of tokens from the session cookie.
- OWASP Session Management Cheat Sheet (cookie size and server-side storage guidance).
