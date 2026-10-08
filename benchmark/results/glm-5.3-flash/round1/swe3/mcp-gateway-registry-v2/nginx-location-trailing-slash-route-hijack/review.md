# Expert Review: Nginx location trailing-slash fix (route-hijack prevention)

*Created: 2026-09-30*
*Reviewed: `github-issue.md` + `lld.md` (draft) against code at tag 1.27.1 (commit 5f725c1d)*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | UI/UX, SPA routing, browser-visible behavior |
| Backend Engineer | Byte | nginx config generation, auth-server mcp-proxy hop, version routing |
| SRE/DevOps Engineer | Circuit | Deployment convergence, reload safety, rollback |
| Security Engineer | Cipher | Route-hijack class, injection surface, auth boundaries |
| SMTS (Overall) | Sage | Architecture, code quality, maintainability |

---

## Frontend Engineer (Pixel)

**Strengths**
- Directly fixes the reported user-visible failure: post-logout navigation to SPA routes (`/about`, `/auth`, `/assets`, ...) is no longer intercepted by a short server path's `auth_request`-guarded block, so users see the app instead of `{"error": "Authentication required"}`.
- Bare-path behavior is explicit rather than accidental: `POST /name` (the `append_mcp_path=False` connection style) keeps proxying through the new exact-match block, and a browser `GET /name` on such a server reaches the same auth gate as before. For ordinary servers (transport endpoint under the subtree) a browser `GET /name` now reaches the registry app via the catch-all instead of the JSON auth error - the behavior a user who types the path expects.
- No frontend code or route definitions change; the fix is entirely in generated server config.

**Concerns**
1. (Minor) The registry UI's server-detail links target `/name/mcp` (the MCP endpoint), not the bare path, so no link changes behavior. Worth a manual click-through in QA of the server detail page on a deployment with a short server path.
2. (Minor) SPA client-side routing is unaffected: the SPA router only ever sees paths served by the catch-all, which is strictly a superset of the paths it received pre-fix on hijacked prefixes.

**New libraries / infra dependencies:** None.

**Better alternatives considered:** None from the UI side; serving the bare path from the app is more useful than a redirect for discoverability.

**Recommendations**
- QA checklist entry: log out, then navigate to a SPA route whose first character matches a registered short server path; expect the app page (redirect to login), never raw JSON.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Backend Engineer (Byte)

**Strengths**
- Correct root cause and correct mechanism: nginx prefix matching plus the missing trailing slash; the fix lands in the single generator method that owns the shape.
- Preserves the auth-server mcp-proxy contract: `proxy_pass .../mcp-proxy/<name>/` is unchanged; the hop's capture and sub-path append logic (server.py:6447-6450) is tolerant of the new shape.
- The bare-path exact block is the right call for `append_mcp_path=False` servers: `_registered_server_from_proxy_path` (server.py:1465) already keys on the first segment and tolerates a missing transport segment, and the sub-path append is a no-op when there is no `/` in the capture - so a bare POST to `/name` reaches the upstream exactly as it did through the old prefix block.
- Verified the version map (`~^{path}(/.*)?:...`) is anchored at `^{path}` with a `(/.*)?` tail, so `$uri` matching still hits for `/name` and `/name/mcp` URIs - version routing is unaffected.

**Concerns**
1. (**Should fix**) The exact-match block duplicates ~60 lines of directive wiring (auth_request, auth_request_set chain, proxy_set_header set, limit_req). Duplication is a maintenance hazard: a future directive added to the prefix block but not the exact block creates a divergence bug (e.g. a new auth_request_set captured only on the subtree path). Mitigate by constructing both blocks from the SAME `transport_settings` + `common_settings` f-string fragments in one `return` (as the LLD's Step 2 does) so there is a single source for the shared directives, and add a unit test asserting both blocks carry identical `auth_request` / `X-Upstream-Url` / `limit_req` wiring.
2. (Minor) `location = {ROOT_PATH}/name` for a multi-segment path (`/peer/server`) still works (exact match on the literal), and the hop receives `/mcp-proxy/peer/server` whose first segment is the peer name - same handling as today's prefix block for that shape. No action needed, but the unit test should include a two-segment path to pin it.
3. (Minor) The exact block must NOT be emitted for the root path (`/`): `location = {ROOT_PATH}` (or `location = `) is either invalid or would shadow the whole site. The LLD handles this (skip the exact block when normalized path is `/`); pin it in a test.

**New libraries / infra dependencies:** None.

**Better alternatives considered:** 308-redirect for the bare path (rejected: breaks non-redirect-following MCP clients POSTing bare paths for `append_mcp_path=False` servers); see lld.md Alternatives.

**Recommendations**
- Single-source the shared directives between the two blocks; add the equality unit test.
- Keep the `logger.info` naming the normalized path so operators can correlate generated blocks to registrations.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (concern 1 is a should-fix, addressed in the revised LLD: shared f-string fragments + equality test)

---

## SRE/DevOps Engineer (Circuit)

**Strengths**
- Existing deployments self-heal: `registry/main.py:827-836` regenerates the config unconditionally at startup, and `NginxReloadScheduler` rewrites within one debounce tick on any rendered-hash change. No operator action beyond a normal restart/upgrade.
- The write path is already gated by `_write_and_validate_config` (temp file + `nginx -t` + promote-or-restore last-good), so a malformed block can never take the live config down - the safety net for THIS change is pre-existing.
- Rollback is trivial: redeploy the previous image; the next startup regenerates the old shape. No config surgery, no data migration.

**Concerns**
1. (Minor) First restart after upgrade triggers exactly one extra nginx reload (rendered hash changes). Trivial, but do not be surprised by the `Debounced nginx reload completed` log line immediately after rollout.
2. (Minor) Config file grows by ~20 lines per registered server (the exact-match block). At realistic server counts this is noise for nginx; no hash-table or memory concern at any plausible scale.
3. (Observability) During rollout, `nginx -t` failing would indicate a pathological stored path the normalizer mishandles; the promote-or-restore path keeps the old config live and the registry logs the error. Suggested runbook line: if `nginx -t` fails after upgrade, check for non-slug server paths in the DB (should be impossible via `_SERVER_PATH_RE`); the service stays up on the last-good config meanwhile.

**New libraries / infra dependencies:** None.

**Better alternatives considered:** None; the convergence mechanism is already in place and proven.

**Recommendations**
- Release note: "nginx location blocks for registered servers now carry a trailing slash; config regenerates on next restart."

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Security Engineer (Cipher)

**Strengths**
- Fixes a genuine route-confinement weakness: today ANY registered server path that is a string-prefix of a sensitive route (or vice versa) captures that route into the auth_request flow. Beyond the UX bug, that broadens the attack surface of the MCP edge (rate-limit zones, Lua body capture, error_page rewrites) onto unrelated routes.
- The normalizer cannot be abused to inject directives: `_SERVER_PATH_RE` (`^[A-Za-z0-9._\-/]+$`) guarantees no nginx metacharacters ever reach the location name position; normalization only moves/adds slashes. Defense-in-depth story is unchanged and adequate.
- The exact-match block carries the full auth wiring (`auth_request /validate` + internal token capture + limit_req), so the bare path does NOT become an unauthenticated bypass - the same identity/scope/token constraints apply on both blocks.

**Concerns**
1. (**Must verify, design is correct**) The duplicated auth wiring in the exact block must be byte-identical to the prefix block's; a missing `auth_request_set` in one block would mint a token missing claims (functional break) or, worse, if someone later "simplifies" the exact block by dropping `auth_request`, the bare path becomes an auth bypass into the hop. The hop itself verifies `X-Internal-Token` (defense holds), but the gateway's scope check happens at `/validate`, so keep `auth_request` in both. The single-source construction + equality test closes this.
2. (Minor) A operator registering a server at `/validate` or `/oauth2/...` would generate a block that collides with template locations (exact or prefix); this fix does not change that pre-existing hazard (registration-time reservation is out of scope, correctly).
3. (Minor) Root-path registration degenerates to catch-all ownership both before and after the fix; documented as out of scope. Reasonable.

**New libraries / infra dependencies:** None.

**Better alternatives considered:** Registration-time prefix reservation (reject a new server path that is a prefix/suffix of an existing route namespace). Good future hardening; orthogonal to this fix and heavier to land.

**Recommendations**
- Keep the equality test between the two blocks' auth wiring (closes concern 1).
- Future hardening (follow-up): reject registrations whose path is a prefix of `/api`, `/oauth2`, `/validate`, etc.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (concern 1 addressed in the revised LLD: shared-fragment construction + wiring-equality test)

---

## SMTS (Sage)

**Strengths**
- The design is the minimal correct one: fix the generator, do not touch templates, schemas, or the auth hop. All in-repo precedent (unhealthy commented blocks, A2A agent blocks, `/api/` template locations) already uses trailing-slash prefix locations, so this change makes the codebase internally consistent rather than introducing a new style.
- The bare-path exact block is justified by a real, verified consumer (`append_mcp_path=False`), not speculative. The alternatives section honestly evaluates the smaller designs and rejects them for concrete compatibility reasons.
- Self-heal + rollback story relies entirely on mechanisms that already exist (startup regeneration, hash-diff debounce, `nginx -t` gate) - no new operational machinery.

**Concerns**
1. (**Should fix**) Directive duplication between the two generated blocks (same as Byte's concern 1). Single-sourcing via shared f-string fragments is the right pattern; without it, the design ships a divergence hazard.
2. (Minor) The normalizer is a pure function with a wide input space (three historical shapes); its unit tests should enumerate the shapes (leading-slash-less, trailing-slash, both, root) so the canonical form is pinned, not incidental.
3. (Minor) Docstring of `_create_location_block` currently says users control the path format "with or without trailing slash" - the revised docstring must contradict that explicitly or a future maintainer will "fix" it back.

**New libraries / infra dependencies:** None.

**Better alternatives considered:** None beyond those recorded in lld.md.

**Recommendations**
- Land with the wiring-equality test and the input-shape enumeration tests; update the docstring as specified.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (concern 1 addressed in the revised LLD)

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | QA click-through on short-path deployment; expect app pages post-logout |
| Backend (Byte) | APPROVED WITH CHANGES | 0 should-fix | Single-source shared directives across the two blocks; wiring-equality test; two-segment + root-path tests |
| SRE (Circuit) | APPROVED | 0 | Expect one reload on upgrade restart; config grows ~20 lines/server; runbook note for `nginx -t` failure |
| Security (Cipher) | APPROVED WITH CHANGES | 0 must-verify | Byte-identical auth wiring in both blocks (closes bypass/divergence hazard); future: registration-time prefix reservation |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 should-fix | Same single-sourcing; enumerate input shapes in tests; docstring must supersede the old "with or without trailing slash" comment |

**Consensus:** All five approve contingent on single-sourcing the shared directives between the prefix and exact blocks and pinning both blocks' auth wiring with a test. The revised lld.md (Step 2/Step 3: both blocks constructed in one `return` from the same `transport_settings` + `common_settings` fragments; testing.md: wiring-equality + shape-enumeration + two-segment + root-path tests) incorporates these. No NEEDS REVISION verdicts; no critical findings outstanding.

**Next Steps:**
1. Implement per revised lld.md Steps 1-4.
2. Add the tests specified in testing.md Sections 1 and 2.
3. Note the release-note line from Circuit's review.
