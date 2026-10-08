# GitHub Issue: Server-side OAuth token storage to keep session cookies under the browser size limit

Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/399

## Title
Store OAuth access/refresh tokens server-side (encrypted, TTL-expired) and keep only a token reference in the session cookie

## Labels
- enhancement
- security
- auth
- backend

## Description

### Problem Statement

OAuth session cookies exceed the browser's 4096-byte per-cookie limit. A session that carries user metadata (~500 bytes), a JWT access token (2-3 KB), a refresh token (2-3 KB), and serialization overhead lands around 7 KB. Browsers silently drop oversized cookies, which breaks authentication entirely for identity providers that issue large JWTs - Microsoft Entra ID with group claims and Keycloak with custom attributes are the reported cases.

Because of this, OAuth tokens were removed from the session cookie (issue #490; the `OAUTH_STORE_TOKENS_IN_SESSION` flag defaults to `false`, and only token *metadata* is stored even when enabled). The direct consequence is that the "Get JWT Token" feature has no IdP token material to work from for OAuth users: the UI token generator issues a self-signed registry JWT, but the user's actual IdP access/refresh tokens are gone right after login.

### Proposed Solution

Adopt a token-reference pattern:

1. At the OAuth2 callback, store the IdP `access_token` and `refresh_token` server-side in MongoDB, encrypted at rest with Fernet (key derived from the existing `SECRET_KEY` via PBKDF2, following `registry/utils/credential_encryption.py`).
2. Put only user metadata plus a short opaque random token reference (`tr_` + 32 url-safe bytes, about 50 chars) in the session cookie.
3. Add an authenticated retrieval endpoint that returns the current user's stored tokens on demand, scoped to the authenticated username, so the "Get JWT Token" flow works again for OAuth users.
4. Expire stored tokens automatically with a MongoDB TTL index aligned to the session lifetime.

Normal request validation continues to validate the signed session cookie only - no extra database read is added to the hot path, and the flow is backwards compatible: cookies without a token reference (legacy sessions, or deployments where storage is unavailable) keep working exactly as today.

### User Stories

- As an end user behind Microsoft Entra ID with group claims, I want to log in without my session cookie being dropped so that authentication works at all.
- As an end user of the "Get JWT Token" page, I want my IdP tokens to be available after login so that tooling that needs the actual IdP token can retrieve it.
- As an operator, I want IdP tokens encrypted at rest and automatically expired so that a database dump does not leak long-lived credentials and the store does not grow unbounded.
- As an operator running the file storage backend, I want the feature to degrade gracefully (no token storage, existing behavior) so that nothing breaks.

### Acceptance Criteria

- [ ] OAuth2 callback stores `access_token` and `refresh_token` encrypted in MongoDB and places only user metadata plus an opaque `token_ref` in the session cookie.
- [ ] The session cookie for typical large-token IdPs stays well under 4096 bytes (metadata + ~50-char reference).
- [ ] Stored tokens are encrypted at rest (Fernet, PBKDF2-derived key with a purpose-specific salt); plaintext tokens never appear in the database or in logs.
- [ ] `GET /oauth2/tokens` (auth server) returns the caller's stored tokens only when the request is authenticated via a valid session cookie whose `token_ref` matches a record owned by the same username; returns 404 when no record exists, 401 when unauthenticated, 410 when the record was revoked.
- [ ] Lookup is scoped: a record can only be retrieved by the username stored with it.
- [ ] A TTL index on `expires_at` (default 8 hours, aligned with the session `max_age_seconds`) auto-deletes expired records; an explicit logout revoke deletes the record immediately.
- [ ] Normal request validation (`/validate`, session cookie middleware) performs zero additional database reads; cookie-only validation is unchanged.
- [ ] Backwards compatibility: sessions without `token_ref` behave exactly as today; retrieval returns 404 (not an error) for legacy sessions; the `OAUTH_STORE_TOKENS_IN_SESSION` legacy metadata flag keeps its meaning.
- [ ] On deployments without a MongoDB backend, token storage is skipped with a warning and login still succeeds.
- [ ] Unit tests cover store/retrieve roundtrip, encryption at rest, user scoping, expired-and-revoked cases, legacy-session behavior, and cookie-size reduction.

### Out of Scope

- Refresh-token rotation or background refresh of IdP tokens.
- Storing IdP tokens for the M2M/client-credentials flow.
- Migration of existing sessions (existing cookies simply lack a `token_ref` until the next login).
- New UI pages; the existing "Get JWT Token" page keeps its flow (its backend can now also surface the stored IdP token).
- Multi-key Fernet rotation machinery (single derived key, same as existing credential encryption).

### Dependencies

- MongoDB/DocumentDB storage backend (already a supported `storage_backend`); reuses the shared DocumentDB client and collection-name namespacing.
- `cryptography` (Fernet) - already a dependency in both root `pyproject.toml` and `auth_server/pyproject.toml`.

### Related Issues

- #399 (this issue)
- #490 (prior art: removed tokens from the session cookie, introduced `OAUTH_STORE_TOKENS_IN_SESSION`)
