# Expert Review: Server-Side OAuth Token Storage (token-reference sessions)

*Created: 2026-09-30*
*Reviewed design: `./lld.md` (initial draft) against `./github-issue.md`*

## Review Summary Table

| Role | Reviewer | Focus | Verdict |
|------|----------|-------|---------|
| Frontend Engineer | Pixel | UI/UX, token retrieval flow | APPROVED |
| Backend Engineer | Byte | API design, data model, correctness | APPROVED WITH CHANGES |
| SRE/DevOps Engineer | Circuit | Deployment, scaling, TTL behavior | APPROVED WITH CHANGES |
| Security Engineer | Cipher | AuthZ, encryption, leakage | NEEDS REVISION -> resolved |
| SMTS (Overall) | Sage | Architecture, maintainability | APPROVED WITH CHANGES |

---

## Frontend Engineer (Pixel)

**Strengths**
- No UI changes required: the existing `TokenGeneration.tsx` flow (`POST /api/tokens/generate`) keeps working; the fix is invisible to users, which is exactly right for a defect of this kind.
- Cookie shrinkage directly unblocks login for affected IdP users - the largest UX win is simply "authentication works again".

**Concerns**
1. The new endpoint returns raw IdP tokens to a browser caller. If any future page fetches it casually, tokens could end up in logs/devtools habitually. The design does not add any UI consumer now (good), but the endpoint response should be explicitly documented as "fetch on demand, never persist client-side".
2. Error surfaced to users on 404 (legacy session) should be actionable: "re-login required". The LLD does not state the error contract for a future UI consumer.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** None from the UI side; chunking would touch frontend code and is rightly rejected.

**Recommendations**
- Add one sentence to the endpoint docstring: response is intended for on-demand display/copy, not storage.
- Document a recommended client error mapping (401 -> redirect to login, 404 -> prompt re-login) for future consumers.

**Questions for author**
- Should `/oauth2/tokens` be CORS-restricted to the registry origin? (Deployments put auth-server on a sibling subdomain.)

**Verdict: APPROVED** (with the docstring/error-mapping note folded into the design)

---

## Backend Engineer (Byte)

**Strengths**
- Follows two existing, proven patterns in the repo: `BackendSessionRepository` (TTL, factory singleton, namespaced collection) and `credential_encryption.py` (Fernet + PBKDF2 from `SECRET_KEY`). Low novelty risk.
- `_id = token_ref` gives O(1) lookup and one-record-per-login semantics without extra indexes for the hot path.
- Read-path expiry check (`expires_at <= now` treated as gone) correctly compensates for the ~60 s TTL monitor lag.

**Concerns (must-fix)**
1. **CRITICAL - retrieval authorization is under-specified.** The endpoint must bind THREE things: valid session cookie -> `token_ref` from THAT cookie -> record whose `username` equals the cookie's `username`. The LLD says "scoped to the authenticated user" but the endpoint sketch passes `data["username"]` only in prose. If a future refactor drops the username predicate from the query, any logged-in user could fetch another user's tokens by forging a `token_ref` guess (impractical but defense in depth matters for credentials). The query MUST be `{"_id": token_ref, "username": username}` and the repository interface must take both arguments.
2. **must-fix - session fixation/replay window.** If an attacker obtains an old signed cookie still holding a `token_ref` whose record is alive, they can read tokens. TTL bounds this to the session lifetime (8 h default), which is acceptable, but the design should state it explicitly and NOT extend record TTL beyond the session max-age by default.
3. **should-fix - `expires_in` vs storage TTL mismatch.** The IdP access token may expire (e.g. 1 h) well before the storage TTL (8 h). Returning a dead access token with `expires_in: 3599` computed from storage time would be wrong. The response should return the ORIGINAL `expires_in` and `obtained_at` and let callers compute remaining validity - never a recomputed value. The LLD's response model should state this.

**Concerns (should-fix)**
4. `model_dump(mode="json")` for storage is correct for Motor (datetime -> ISO strings). But then `expires_at` comparisons on read must parse it back or compare consistently; recommend the repository normalize the document through the pydantic model on read (`OAuthTokenDocument.model_validate(doc)`) so `expires_at` is a real datetime.
5. Concurrent logins: each login creates a new ref; an old record for the same user is NOT deleted, so a user with many logins accumulates records until TTL. Acceptable (bounded by TTL), but worth one line in Scaling Considerations (it is there - confirmed).

**New libraries / infra dependencies required:** None (cryptography, motor already present).

**Better alternatives considered:** Storing tokens in the existing `backend_sessions` collection - rejected, mixing concerns and TTL semantics; separate collection is right.

**Recommendations**
- Make `get_user_token(token_ref, username)` the only read method; do not expose a ref-only read.
- Normalize documents through the pydantic model on read.
- State the replay-window bound explicitly in the LLD (done in revision).

**Questions for author**
- Should logout revoke ALL records for the user or only the current ref? (Current: current ref only - other devices stay logged in, which is correct.)

**Verdict: APPROVED WITH CHANGES** (items 1-3 are incorporated in the revised LLD)

**Resolution:** (1) Repository read signature is `get_user_token(token_ref, username)` with the compound query `{"_id": token_ref, "username": username}`; the endpoint never calls a ref-only read. (2) Non-goal added: record TTL never exceeds session max-age by default (TTL env clamped, default derives FROM session max-age). (3) Response returns original `expires_in` and `obtained_at` as stored from the IdP; no recomputation. (4) Documents are validated through `OAuthTokenDocument.model_validate` on read. (5) Acknowledged in Scaling Considerations.

---

## SRE/DevOps Engineer (Circuit)

**Strengths**
- Zero-downtime rollout: purely additive collection, additive cookie key, feature flag with instant rollback (`OAUTH_SERVER_SIDE_TOKEN_STORAGE=false`).
- File-backend degradation mirrors `BackendSessionRepository` exactly - operators on file backend see a warning, not an outage.
- TTL index with `expireAfterSeconds=0` on a computed `expires_at` is the right pattern (per-record TTL, matches backend_sessions).

**Concerns**
1. **must-fix - deployment surface completeness.** The repo wires `OAUTH_STORE_TOKENS_IN_SESSION` through EIGHT surfaces (.env.example, auth_server/.env.template, two compose files, Helm values+secret, three Terraform files, docs). The new flags must appear on all of them or operators get silent default drift between deployment styles. The checklist exists in the LLD; the patch must actually tick every box.
2. **should-fix - default-on flag changes behavior on upgrade.** `OAUTH_SERVER_SIDE_TOKEN_STORAGE` defaulting to `true` means existing MongoDB-backed deployments suddenly start persisting IdP tokens. That IS the issue's intent, but it must be called out in release notes / parameter reference so security teams are not surprised by a new collection containing credentials.
3. **should-fix - TTL default must track session lifetime.** If an operator raises session max-age to 24 h but leaves token TTL at 8 h, tokens vanish mid-session (404s from the retrieval endpoint). The derive-from-session-max-age default (0 -> session value) handles this; document that `0` is the recommended setting.
4. **nice-to-have - observability.** No new metric; per-route metrics cover the endpoint. A startup log line stating enabled/disabled + effective TTL makes support tractable.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Cleanup cron job instead of TTL index - rejected, the repo already standardizes on TTL indexes and a cron adds a moving part.

**Recommendations**
- Tick every deployment-surface box in the patch (verified in implementation review below).
- Set the docs' recommended value for `OAUTH_TOKEN_STORAGE_TTL_SECONDS` to `0` (derive).
- Add the startup log line (already in LLD Observability section).

**Questions for author**
- DocumentDB (AWS) honors TTL indexes identically? Yes - `expireAfterSeconds` is supported; noted for the ECS path.

**Verdict: APPROVED WITH CHANGES** (items 1-3 incorporated)

**Resolution:** (1) Deployment checklist is part of the LLD and every listed surface is wired in the patch (verified in implementation.md). (2) The parameter-reference row and env templates explicitly say the default enables server-side storage on MongoDB-backed deployments. (3) Docs recommend `0` (derive from session max-age); clamp range documented. (4) Startup log included.

---

## Security Engineer (Cipher)

**Strengths**
- Tokens leave the browser entirely; the cookie now carries a 256-bit random opaque reference - no credential material, no user-identifying claim beyond what was already in the cookie.
- Encryption at rest with a purpose-separated PBKDF2 salt prevents cross-store ciphertext replay (a ciphertext stolen from the server-credential store cannot be reused here and vice versa).
- Logout revokes the record immediately rather than waiting for TTL.

**Concerns (critical, blocking)**
1. **CRITICAL - plaintext tokens must never reach logs.** The callback handles `token_data` and the LLD adds logging around it. The design MUST state: log refs truncated to a prefix, log usernames hashed (the file already has `hash_username()`), NEVER log `token_data`, and never place token material in exception messages. Make this an explicit implementation invariant, not an aside.
2. **CRITICAL - retrieval authorization** (same as Byte #1, but from the security angle this is THE control): the compound `(token_ref, username)` query, session-cookie-only auth (no Bearer), and 401-before-any-store-access ordering must be normative. Also the endpoint must not leak whether a ref exists for ANOTHER user: with the compound query, a mismatched username is indistinguishable from a missing record (both 404). Good - keep it that way.
3. **must-fix - secrets in responses.** The retrieval response intentionally returns credentials over the wire. Require: no caching headers (`Cache-Control: no-store`), and the response documented as sensitive. Without `no-store`, a shared proxy could retain IdP tokens.

**Concerns (should-fix)**
4. `secrets.token_urlsafe(32)` for the ref is good (256-bit). Add a uniqueness guard: on the (astronomically unlikely) duplicate-key error from `replace_one` upsert, regenerate once; do not loop.
5. Timing: `_id` point lookup is not constant-time, but with a 256-bit random ref, enumeration is infeasible - accepted residual risk, note it.
6. CSRF on `GET /oauth2/tokens`: GET is read-only and the response is same-origin JSON (no JSONP); cross-origin reads are blocked by CORS defaults. Acceptable; state that CORS must not be opened for this route.
7. Revocation completeness: logout only revokes when the cookie is readable. If a user clears cookies without logging out, the record lives until TTL - acceptable and bounded; document as residual risk.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Per-record data keys wrapped by a KMS master key - strictly better key management, but it introduces cloud-provider coupling the repo does not have today; the PBKDF2 approach matches the existing accepted pattern (`credential_encryption.py`), so consistent. Recommended as a follow-up upstream.

**Recommendations**
- Add `Cache-Control: no-store` to the retrieval response.
- Codify the logging invariants in the LLD Implementation Details section.
- Document residual risks (cookie replay window, uncollectable records after cookie loss) as explicit Non-Goals/limitations.

**Questions for author**
- Should records be keyed to the session signature (binding ref -> cookie issuance time) to shrink the replay window? Possible future hardening; not required for parity with the current session model.

**Verdict: NEEDS REVISION** -> **resolved in revised LLD** (items 1-3 incorporated; 4-7 documented)

**Resolution:** (1) Logging invariants are now normative in the LLD (prefix-truncated refs, hashed usernames, never log token data, never in exception messages) and the implementation follows them. (2) Authorization control is normative: session-cookie-only, compound `(token_ref, username)` query, 401 ordering, indistinguishable 404s. (3) `Cache-Control: no-store` added to the endpoint contract and implemented. (4) One-shot duplicate-ref regeneration added to the design. (5)-(7) Residual risks documented in the revised LLD (replay window bounded by session TTL; records orphaned until TTL if cookies are cleared without logout; CORS must remain closed for the route).

---

## SMTS (Overall) (Sage)

**Strengths**
- The design is the textbook fix for oversized auth cookies: server-side state + opaque reference. It also re-uses two in-repo patterns so a new contributor can implement it from the LLD alone.
- The hot path (request validation) is provably untouched - the requirement "no extra database read" is structural (the ref is never resolved during validation), not just an optimization note.
- Failure semantics are right: storage failures degrade to today's behavior at login time; retrieval failures are contained 4xx/5xx with no auth impact.

**Concerns**
1. **must-fix - keep the patch cohesive.** The LLD lists registry-side touching (`/tokens/generate` surfacing IdP tokens) as an open question. Do not half-implement it: this patch should ship the storage + retrieval + wiring + tests, and leave the registry `/tokens/generate` integration explicitly deferred. A cohesive core beats a sprawling first change.
2. **should-fix - module placement.** Encryption helper in `registry/utils/`, models in `registry/schemas/`, repository under `registry/repositories/` matches existing layering (auth_server already imports these). Correct as designed; do not invent a new top-level package.
3. **should-fix - test placement.** Endpoint tests that import `auth_server.server` need the conftest auto-mock environment (`tests/auth_server/...`); pure-logic tests (encryption, models, repository with fake collection) belong in `tests/unit/...`. The LLD's test file list should split accordingly if importing the app in `tests/unit` proves heavy - keep unit tests dependency-light by constructing the endpoint logic against mocks rather than the full app.
4. **should-fix - testability note:** the LLD says "TestClient with mocked signer/repo" - signing requires `SECRET_KEY` set before import; the test must set it in `os.environ` before importing `auth_server.server` (the module generates a random key otherwise, which is fine for the endpoint tests but makes cross-test cookie fixtures impossible). Pin this in the test plan.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** None beyond those in the LLD's Alternatives section; the comparison matrix is fair.

**Recommendations**
- Ship the cohesive core; defer the `/tokens/generate` IdP-token embedding (R2/R4 aligned).
- Split tests by dependency weight (pure unit vs app-level).
- Keep the retrieval endpoint logic thin: extract a small helper (cookie -> validated session data) so tests can exercise 401/404/410 paths without the full app where convenient.

**Questions for author**
- None - design is sound once Cipher's items land.

**Verdict: APPROVED WITH CHANGES** (items 1 and 3-4 incorporated)

**Resolution:** (1) Registry `/tokens/generate` integration is explicitly deferred (LLD Open Questions + Non-Goals); this patch ships storage, retrieval, logout revoke, wiring, tests. (2) Module placement confirmed as designed. (3)-(4) Test plan split: pure unit tests for encryption/models/repository-with-fake-collection under `tests/unit/`; app-level endpoint tests under `tests/auth_server/unit/` where the auto-mock conftest lives, with `SECRET_KEY` pinned via env before import.

---

## Next Steps

1. LLD revised to incorporate all must-fix / should-fix items above (authorization compound query, logging invariants, `no-store`, TTL-vs-session alignment, deployment surface completion, test split, deferred registry integration).
2. No verdict is NEEDS REVISION after the revisions; proceeding to `testing.md` and implementation per Step 7.5.
3. Implementation must realize the REVISED LLD; deviations recorded in `implementation.md`.
