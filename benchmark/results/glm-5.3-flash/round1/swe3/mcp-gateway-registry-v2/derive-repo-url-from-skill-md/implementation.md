# Implementation Summary: Derive Repository URL from SKILL.md URL and surface it in skill modals

*Created: 2026-09-29*
*Baseline ref: `v1.0.19` (commit `9d031852c1acc2a095e33021bb8906b0affed4f4`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
The `/api/skills/parse-skill-md` response now includes `repository_url`, derived server-side from the pasted SKILL.md URL for both supported GitHub shapes (`github.com/.../blob/...` and `raw.githubusercontent.com/.../refs/heads/...`) plus GitHub Enterprise hosts (blob and `raw.*` shapes); non-GitHub URLs and GitHub URLs without a repo/file path yield `null` rather than a guess. The registration form auto-fills its Repository URL field from that response (the field stays editable), and the stored `repository_url` is now transported end to end - through `SkillInfo` (both listing paths), the semantic-search index metadata, all three semantic-search skill-hit projections, and `SkillSearchResult` - so both skill detail modals can render "View Skill" (SKILL.md URL) and "View Repo" (repository root, only when present) in place of the single "View on GitHub" link.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/utils/url_utils.py` | modified | +75 / -0 | New pure helper `derive_repository_url` (blob/raw/public/enterprise, never guesses, never raises) |
| `registry/services/skill_service.py` | modified | +11 / -1 | Import helper; derive from user URL in `_parse_skill_md_content` and add to result; `SkillInfo` fallback path carries `repository_url` |
| `registry/api/skill_routes.py` | modified | +2 / -0 | Parse response includes `repository_url`; fast-path `SkillInfo` construction includes it |
| `registry/schemas/skill_models.py` | modified | +3 / -0 | `SkillInfo.repository_url: str \| None` |
| `registry/repositories/documentdb/search_repository.py` | modified | +3 / -0 | Index-time `metadata` + both grouped-result skill projections carry the field (3 total sites here, 4 across the search layer) |
| `registry/api/search_routes.py` | modified | +2 / -0 | `SkillSearchResult.repository_url` + its construction from hit entries |
| `frontend/src/types/skill.ts` | modified | +1 / -0 | `Skill.repository_url?: string` |
| `frontend/src/hooks/useSemanticSearch.ts` | modified | +1 / -0 | `SemanticSkillHit.repository_url?: string` |
| `frontend/src/pages/Dashboard.tsx` | modified | +1 / -0 | Parse success auto-fills `repository_url` (strict refill, so a non-derivable re-parse clears the field) |
| `frontend/src/components/SkillCard.tsx` | modified | +12 / -1 | Detail (i) modal: "View Skill" + conditional "View Repo" |
| `frontend/src/components/SemanticSearchResults.tsx` | modified | +12 / -1 | Same modal change in `SkillContentModal` |
| `tests/unit/test_url_utils.py` | added | +152 / -0 | Derivation helper: public blob/raw, GHE blob/raw, enterprise infix host, negatives (GitLab, Bitbucket, generic, no-file-path, malformed, userinfo spoof), translate/derive round-trip |
| `tests/unit/api/test_skill_repository_url.py` | added | +277 / -0 | Parse response carries derived/null `repository_url`; BOTH `SkillInfo` listing paths expose it (review must-fix #1) |
| `tests/unit/test_search_repository_repository_url.py` | added | +104 / -0 | `SkillSearchResult` transport + gate asserting all 4 `repository_url` sites in `search_repository.py` (review must-fix #2) |
| `tests/unit/test_skill_models.py` | modified | +23 / -0 | `SkillInfo.repository_url` default + population |

## How to Apply

```bash
git clone --branch v1.0.19 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` verified against a fresh `v1.0.19` checkout.

## Deviations from the LLD
- The LLD's helper sketch derived from `url` after `translate_skill_url`; implementation passes the same user-provided `url` (the LLD text already specified deriving from the user-provided URL, so behavior matches).
- The LLD sketched route-level tests via a `create_app` factory; the repo wires a singleton `registry.main.app`, so the tests use the existing `registry.main.app` + `nginx_proxied_auth` override pattern from `test_skill_inline_content.py`. Coverage is identical.
- The search-layer "three projection sites" are covered by a source-inspection gate test plus the `SkillSearchResult` construction test rather than full DocumentDB integration tests (the repo's existing tests do not spin up DocumentDB either); the grep gate in `testing.md` Section 6 additionally pins the count.
- `derive_repository_url` also accepts the legacy raw shape without `refs/heads/` (e.g. `raw.githubusercontent.com/org/repo/main/SKILL.md`); the LLD described this shape in the helper comment and the implementation keeps it, tested in `test_raw_url_legacy_shape`.

## Not Implemented / Follow-ups
- Semantic-search re-indexing of pre-existing skills (operators should re-run indexing so old skills gain `repository_url` in search results; registry listings pick the field up immediately). Documented in LLD Open Questions.
- Repo-existence verification and non-GitHub host derivation remain out of scope per the task.

## Verification (not executed)
Per skill constraints, the target repo's tests were designed (see `./testing.md` and the three new unit-test files in the patch) but NOT run. No pytest, lint, build, or app execution was performed; correctness was verified by re-reading the edits and by `git apply --check` on a fresh checkout.
