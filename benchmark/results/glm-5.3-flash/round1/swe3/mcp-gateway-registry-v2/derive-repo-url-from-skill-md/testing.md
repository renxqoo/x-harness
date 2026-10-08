# Testing Plan: Derive Repository URL from SKILL.md URL and surface it in skill modals

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies that (a) the backend derives `repository_url` from both supported SKILL.md URL shapes including GitHub Enterprise, (b) the field reaches the parse response, both skill-listing paths, and semantic-search results, and (c) the registration form auto-fills the field and both modals render "View Skill" / "View Repo" correctly, including the negative cases (non-GitHub hosts leave the field empty; missing `repository_url` renders no link).

### Prerequisites
- [ ] Registry API running locally (e.g. `docker compose up registry` or the repo's dev runner)
- [ ] A valid auth token for API calls (`$TOKEN`)
- [ ] Frontend dev server running for UX checks
- [ ] For semantic-search checks: the search/index service running with at least one indexed skill

### Shared Variables
```bash
export REGISTRY_URL="http://localhost"
export TOKEN="$(jq -r '.access_token' .oauth-tokens/ingress.json)"

# URLs used across the functional tests
GITHUB_BLOB='https://github.com/org/repo/blob/main/skills/foo/SKILL.md'
GITHUB_RAW='https://raw.githubusercontent.com/org/repo/refs/heads/main/skills/foo/SKILL.md'
GHE_BLOB='https://github.mycompany.com/org/repo/blob/main/SKILL.md'
GHE_RAW='https://raw.github.mycompany.com/org/repo/refs/heads/main/SKILL.md'
GITLAB_URL='https://gitlab.com/org/repo/-/blob/main/SKILL.md'
GENERIC_URL='https://example.com/SKILL.md'
GITHUB_NO_FILE='https://github.com/org/repo'
```

## 1. Functional Tests

### 1.1 curl / HTTP Tests

#### 1.1.1 Parse derives repository URL from GitHub blob shape
```bash
curl -s -X POST "$REGISTRY_URL/api/skills/parse-skill-md?url=$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['GITHUB_BLOB'],safe=''))")" \
  -H "Authorization: Bearer $TOKEN" | jq '.repository_url'
```
- Expected status: 200
- Expected output: `"https://github.com/org/repo"`
- Assertions: `repository_url` is non-null; `skill_md_url` equals the input; `skill_md_raw_url` is the `raw.githubusercontent.com/.../refs/heads/...` translation.

#### 1.1.2 Parse derives repository URL from GitHub raw shape
```bash
curl -s -X POST "$REGISTRY_URL/api/skills/parse-skill-md?url=$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['GITHUB_RAW'],safe=''))")" \
  -H "Authorization: Bearer $TOKEN" | jq '.repository_url'
```
- Expected: `"https://github.com/org/repo"` (raw host maps back to `github.com`).

#### 1.1.3 GitHub Enterprise blob shape
Request with `GHE_BLOB`; expected `.repository_url` = `"https://github.mycompany.com/org/repo"`.

#### 1.1.4 GitHub Enterprise raw shape
Request with `GHE_RAW`; expected `.repository_url` = `"https://github.mycompany.com/org/repo"`.

#### 1.1.5 Non-GitHub host yields null (GitLab)
Request with `GITLAB_URL`; expected `.repository_url` = `null`. The rest of the response is unchanged (`success: true`).

#### 1.1.6 Non-GitHub host yields null (generic domain)
Request with `GENERIC_URL`; expected `.repository_url` = `null`.

#### 1.1.7 GitHub host without a file path yields null
Request with `GITHUB_NO_FILE`; expected `.repository_url` = `null` (no guessing from 2-segment paths).

### 1.2 CLI Tests
**Not Applicable** - the change adds no CLI commands; the CLI skill paths are untouched by this patch.

## 2. Backwards Compatibility Tests

#### 2.1 Parse response keeps all prior keys
Repeat test 1.1.1 and assert the response still contains `success`, `name`, `name_slug`, `description`, `version`, `tags`, `content_version`, `skill_md_url`, `skill_md_raw_url` - `repository_url` is additive only.

#### 2.2 Skills registered before the change list without repository_url
```bash
curl -s "$REGISTRY_URL/api/skills?limit=100" -H "Authorization: Bearer $TOKEN" \
  | jq '[.skills[] | has("repository_url")] | all'
```
- Expected: `true` (the key is always present; value may be `null` for pre-change skills). No 500s, no missing-key errors for old documents.

#### 2.3 Registration without repository_url still succeeds
```bash
curl -s -X POST "$REGISTRY_URL/api/skills" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"compat-skill","description":"compat check","skill_md_url":"https://example.com/SKILL.md","tags":[]}' | jq '.repository_url'
```
- Expected: registration succeeds; `repository_url` is `null`.

#### 2.4 Semantic search without the new field
Query semantic search against an index entry created before the change: the skill hit must be returned with `repository_url: null` (or absent) and no error.

## 3. UX Tests

#### 3.1 Parse auto-fills the Repository URL field
1. Open the skill registration form (Register -> Skills).
2. Paste `$GITHUB_BLOB` into SKILL.md URL, click Parse.
3. Expected: Repository URL field now shows `https://github.com/org/repo`; success toast appears; name/description/version/tags also filled.

#### 3.2 Field remains editable after Parse
1. After 3.1, edit the Repository URL field to `https://github.com/org/repo-custom`.
2. Expected: the edited value persists (no re-render resets it); submitting registers with the edited value.

#### 3.3 Non-derivable parse leaves the field empty
1. Open a fresh registration form; paste `$GITLAB_URL`; click Parse.
2. Expected: Repository URL field is empty (and a previously auto-filled derived value from an earlier parse is cleared when re-parsing a non-derivable URL).

#### 3.4 Skill detail modal shows both links
1. Register a skill with a repository URL (or pick one that has it).
2. Open the skill card (i) modal.
3. Expected: "View Skill" link opens the SKILL.md URL; "View Repo" link opens `https://github.com/org/repo`; both open in a new tab.

#### 3.5 Skill detail modal with no repository_url
1. Open the (i) modal of a skill registered without a repository URL.
2. Expected: only "View Skill" renders; no empty "View Repo" link, no console errors.

#### 3.6 Semantic-search skill modal shows both links
1. Run a semantic search that returns a skill whose index entry has `repository_url`.
2. Open its modal. Expected: "View Skill" + "View Repo" with the same hrefs as 3.4.
3. Repeat with an entry lacking the field: only "View Skill".

## 4. Deployment Surface Tests

### 4.1 Docker wiring
**Not Applicable** - no new environment variables, volumes, or image changes; existing `docker-compose.yml` services are untouched.

### 4.2 Terraform / ECS wiring
**Not Applicable** - no new Terraform variables or task-definition changes.

### 4.3 Helm / EKS wiring
**Not Applicable** - no new Helm values.

### 4.4 Deploy and verify
Run the full unit suite in CI as part of the normal pipeline; no additional deploy steps:
```bash
uv run pytest tests/unit/test_url_utils.py tests/unit/test_skill_models.py tests/unit/api/test_skill_repository_url.py tests/unit/test_search_repository_repository_url.py
```
- Expected: all pass.

### 4.5 Rollback verification
Reverting the patch restores the prior behavior exactly (the only persistent state is skills' existing `repository_url` values, which older code simply ignores). Verify by rolling back and repeating 1.1.1: the response no longer includes `repository_url` and the parse still succeeds.

## 5. End-to-End API Tests

#### 5.1 Register via derived URL and verify modal data
```bash
# 1. Derive from parse
REPO=$(curl -s -X POST "$REGISTRY_URL/api/skills/parse-skill-md?url=$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['GITHUB_BLOB'],safe=''))")" -H "Authorization: Bearer $TOKEN" | jq -r '.repository_url')
# 2. Register using the derived value
curl -s -X POST "$REGISTRY_URL/api/skills" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"e2e-derive\",\"description\":\"e2e\",\"skill_md_url\":\"$GITHUB_BLOB\",\"repository_url\":\"$REPO\",\"tags\":[]}" | jq '.repository_url'
# 3. List and confirm round-trip
curl -s "$REGISTRY_URL/api/skills?limit=100" -H "Authorization: Bearer $TOKEN" | jq '.skills[] | select(.name=="e2e-derive") | .repository_url'
```
- Expected: step 2 and 3 both print `https://github.com/org/repo`; the UI modal for `e2e-derive` shows both links (per 3.4).

#### 5.2 Semantic search round-trip
After indexing `e2e-derive` (or any skill with `repository_url`), run a semantic query matching it and assert the skill hit carries `repository_url: "https://github.com/org/repo"` and the frontend modal renders "View Repo".

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) - only 4.4/4.5 apply; Docker/Terraform/Helm marked Not Applicable
- [ ] Section 5 (E2E) verified
- [ ] Unit tests added: `tests/unit/test_url_utils.py` (derivation helper: both public shapes, GHE blob + raw, GitLab/generic/no-file-path negatives, scheme/hostname garbage inputs)
- [ ] Unit tests added: `tests/unit/test_skill_models.py` (`SkillInfo.repository_url` default `None` and population)
- [ ] Unit tests added: `tests/unit/api/test_skill_repository_url.py` (parse response contains derived/null `repository_url`; BOTH `SkillInfo` listing paths expose the field - fast path in `skill_routes.py` and fallback via `skill_service.list_skills_for_user`)
- [ ] Unit tests added: `tests/unit/test_search_repository_repository_url.py` (index metadata stores `repository_url`; search-route `SkillSearchResult` carries it)
- [ ] Grep gate: `grep -c "repository_url" registry/repositories/documentdb/search_repository.py` reports at least 4 occurrences (1 index-time + 3 projections); a refactor dropping any projection site fails this gate
- [ ] `uv run pytest tests/` passes with no regressions
