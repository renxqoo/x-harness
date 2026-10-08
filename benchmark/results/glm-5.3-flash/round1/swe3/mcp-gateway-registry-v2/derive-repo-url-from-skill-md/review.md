# Expert Review: Derive Repository URL from SKILL.md URL and surface it in skill modals

*Created: 2026-09-29*
*Reviewed artifacts: `./github-issue.md`, `./lld.md`*

## Frontend Engineer (Pixel)

**Strengths**
- The modal change reuses the exact existing link pattern (icon, colors, `target="_blank" rel="noopener noreferrer"`), so both modals stay visually consistent.
- Adding `repository_url?` as optional on `Skill` and `SemanticSkillHit` keeps every existing call site compiling; no required-prop churn.
- Auto-fill placement inside the existing `handleParseSkillMd` success branch is the right spot; no new state or effects.

**Concerns**
1. **Strict overwrite of the Repository URL field on Parse.** The LLD sets `repository_url: data.repository_url || ''`. If a user typed a repository URL manually and then clicks Parse, their input is wiped even when the new URL is non-derivable. In realistic flows (paste SKILL.md URL, then Parse; or re-parse with a different URL, where refilling is correct) this is acceptable, but it is a real behavior choice that should be stated in the artifact, not silent.
2. **Two different skill types.** `SkillCard.tsx` uses `Skill`, `SemanticSearchResults.tsx` uses `SemanticSkillHit`. Both must gain the field or one modal renders nothing. The LLD covers both; an implementer skipping `useSemanticSearch.ts` would ship a half-working feature.
3. Pre-existing skills in semantic search will not show "View Repo" until re-index. The UI degrades gracefully (link simply absent) - acceptable, but worth a line in UX test expectations.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- Tracking the last auto-filled repository URL in a ref and only clearing the field when its current value equals that derived value (preserves manual edits across re-parse). Rejected for this iteration: the extra state buys little in the realistic flow and complicates the diff.

**Recommendations**
- Document the overwrite trade-off explicitly in the LLD (it currently does note it; keep that line).
- In testing, assert the negative UI case: non-derivable parse leaves the field empty.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (changes are documentation/type-completeness items already reflected in the LLD; no rework required).

---

## Backend Engineer (Byte)

**Strengths**
- Putting `derive_repository_url` in `registry/utils/url_utils.py` next to `translate_skill_url` is exactly where this logic belongs; it can reuse `_is_github_hostname` / `_is_raw_github_url` instead of duplicating hostname classification.
- The helper is pure and total (returns `None`, never raises), so it cannot introduce new failure modes in the parse path.
- `SkillCard` / `SkillRegistrationRequest` already carry `repository_url`; the design touches only the read paths that were missing it.

**Concerns**
1. **MUST-FIX: the two `SkillInfo` construction sites can diverge.** `SkillInfo` is built twice - fast path in `registry/api/skill_routes.py` (~177) and `registry/services/skill_service.py` (~658). If the implementer adds `repository_url` to only one, admins and restricted users see different modal behavior. The design must mandate tests covering **both** listing paths.
2. **MUST-FIX: three semantic-search projection sites.** `search_repository.py` builds skill hit entries at ~1339, ~1596, and ~1991. Missing any one yields inconsistent search results depending on which code path served the query. Same requirement: tests or explicit verification for all three.
3. **Edge semantics to lock in tests:** a GitHub host without a blob/raw file path (e.g. `https://github.com/org/repo`) returns `None` - correct per the issue ("both supported URL shapes"), but this must be pinned so a later refactor does not start "guessing" from 2-segment paths. Non-GitHub hosts return `None` (GitLab, Bitbucket explicitly out of scope).
4. `SkillInfo.repository_url` as `str | None` matches the local convention (`skill_md_url: str`, `skill_md_raw_url: str | None`); do not use `HttpUrl` there.

**New libraries / infra dependencies**
- None. Stdlib `re` / `urllib.parse` already in use.

**Better alternatives considered**
- Deriving at registration time when the client omits `repository_url`. Rejected: changes stored data beyond the task scope and can surprise users who deliberately left the field empty.

**Recommendations**
- Derive from the user-provided URL (before raw translation) so both pasted shapes behave identically - the LLD already places the call on `url`, keep it that way.
- Add one debug log line on derivation miss for a GitHub hostname (aids support without noise).

**Questions for author**
- Should `derive_repository_url` also accept `tree` URLs (`/org/repo/tree/main/path`)? Out of the stated scope; recommend leaving them `None` and noting it in the docstring.

**Verdict: APPROVED WITH CHANGES** (the two MUST-FIX items are test-coverage mandates that must land in the LLD before implementation).

---

## SRE/DevOps Engineer (Circuit)

**Strengths**
- Zero new configuration, zero migrations: DocumentDB stores skills as flexible documents and the semantic-search `metadata` dict accepts the new key without schema changes; old documents project as `None`.
- No new dependencies means no supply-chain or image-rebuild considerations beyond the normal release.

**Concerns**
1. **Operational lag in semantic search.** Existing indexed skills keep their old metadata until re-indexed, so "View Repo" appears in registry listings immediately but in semantic-search results only after a re-index. This is documented in the LLD Open Questions; it should remain an operator action, not silent behavior.
2. No new metrics were added. Acceptable: derivation rides the existing `/parse-skill-md` request path, so existing request metrics and error rates already observe it. Do not add a counter for a pure string transform.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- A background re-index job shipped with the patch. Rejected: deploy-time re-index is already an operational lever; shipping it here widens the blast radius.

**Recommendations**
- Add one line to the rollout notes for operators: "optionally trigger semantic-search re-indexing so pre-existing skills gain repository_url in search results."

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Security Engineer (Cipher)

**Strengths**
- The helper validates scheme (`http`/`https`) and requires a hostname before deriving anything, so `javascript:`/`data:` inputs yield `None`.
- No new network calls: derivation never fetches the derived URL, so no SSRF surface is added (repo verification is explicitly out of scope).
- Host spoofing is handled by `urlparse`: `https://github.com@evil.com/...` parses with hostname `evil.com` and is rejected by the GitHub-hostname check.

**Concerns**
1. **Rendered href provenance.** The modal renders `skill.repository_url` as an anchor. The value is safe today because every write path stores it through Pydantic `HttpUrl` (which rejects non-http(s) schemes) and the search index only mirrors that validated value. This invariant must be preserved: never populate `repository_url` from an unvalidated string. The LLD's plumbing (from `SkillCard.repository_url`) respects it; noted so future contributors do not bypass the schema.
2. Owner/repo path segments are echoed into the derived URL. They cannot contain `/`, `?`, or `#` (urlparse splits those out), and percent-encoded sequences stay encoded - the worst case is a malformed-but-inert https URL, later rejected by `HttpUrl` if a user registers it. Acceptable.
3. The user-facing negative requirement ("non-GitHub URL must leave the field empty rather than guessing") is satisfied by returning `None` for any host failing `_is_github_hostname`; tests should pin `gitlab.com` and a bare non-GitHub domain.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Post-derivation HTTP HEAD to verify the repo exists. Rejected: explicitly out of scope and it adds an SSRF/checks path for no user value.

**Recommendations**
- Keep the derivation helper pure; if verification is ever added, it needs its own SSRF review.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## SMTS (Sage)

**Strengths**
- The design resolves the actual root cause of the second gap: the data was stored (`SkillCard.repository_url`) but never transported (`SkillInfo`, search results) nor rendered. Plumbing all three layers is the correct minimal fix.
- The helper mirrors the inverse of `_translate_github_url_to_raw` (blob -> raw becomes raw -> repo root), keeping the URL algebra in one module.

**Concerns**
1. **Duplication is the maintainability hazard.** After this change, `repository_url` is wired through five hand-rolled construction sites (2x `SkillInfo`, 3x search projection). Nothing today enforces that a refactor adding a `SkillInfo` field remembers all sites. Tests pinning each site are the minimum viable guardrail; longer term, a shared mapper would be better (out of scope for this patch - do not widen the diff).
2. The frontend strict-overwrite semantics (Pixel's concern 1) is acceptable; keep it documented.
3. Keep the helper's contract narrow: the two supported shapes plus enterprise raw, everything else `None`. Resist the temptation to "best effort" 2-segment paths - guessing is exactly what the issue forbids.

**New libraries / infra dependencies**
- None required by architecture.

**Better alternatives considered**
- Introduce a `SkillInfo.from_card(skill)` mapper to collapse the duplicated constructors. Right call eventually; wrong patch. Record as a follow-up, not in this change.

**Recommendations**
- Land the route-level tests for both listing paths and the parse response before considering the implementation complete (matches Byte's MUST-FIX).

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES** (test-coverage mandate, same as Byte's).

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Document strict-overwrite trade-off; keep both skill types in sync; test the empty-field negative case |
| Backend (Byte) | APPROVED WITH CHANGES | 2 | Test both `SkillInfo` paths and all three search projections; pin no-guessing edge cases |
| SRE (Circuit) | APPROVED | 0 | Note re-index action for operators; no new metrics |
| Security (Cipher) | APPROVED | 0 | Keep helper pure; preserve `HttpUrl` validation invariant on every write path |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 | Tests pinning all five construction sites; keep helper contract narrow; shared mapper as follow-up |

**Blocking findings consolidated:**
1. (Byte #1, Sage #1) Both `SkillInfo` construction sites must be covered by tests, plus the parse response.
2. (Byte #2, Sage #1) All three semantic-search projection sites must be verified (targeted tests plus grep-based check).

### Next Steps
Per the mandatory feedback loop, the LLD has been revised before implementation:
- **Resolution (finding 1):** LLD "File Changes" and "Testing Strategy" now mandate `tests/unit/api/test_skill_repository_url.py` covering the parse response and `SkillInfo` construction in *both* listing paths (fast path in `skill_routes.py`, fallback in `skill_service.list_skills_for_user`), plus `SkillInfo` schema default coverage in `tests/unit/test_skill_models.py`.
- **Resolution (finding 2):** LLD now mandates a new `tests/unit/test_search_repository_repository_url.py` exercising the index-metadata projection and a grep-based assertion in `testing.md` that all three `result_entry` sites include `repository_url`.
- Non-blocking items (overwrite trade-off, re-index note, no-guessing edge pins) are recorded in the LLD (Implementation Details / Open Questions) and testing.md.
