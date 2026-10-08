# Low-Level Design: Derive Repository URL from SKILL.md URL and surface it in skill modals

*Created: 2026-09-29*
*Author: Claude (glm-5.3-flash run)*
*Status: Draft (revised after expert review, see `./review.md`)*

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
Two related gaps in skill registration and the skill detail modal:

1. The skill registration form requires the user to type the Repository URL by hand even though it is derivable from the SKILL.md URL they already pasted. Both supported URL shapes encode the same repository prefix:
   - `https://github.com/org/repo/blob/<branch>/<path>/SKILL.md`
   - `https://raw.githubusercontent.com/org/repo/refs/heads/<branch>/<path>/SKILL.md`
   
   The same holds for GitHub Enterprise hosts (`github.mycompany.com` blob URLs, `raw.github.mycompany.com` raw URLs). The existing Parse action auto-fills name/description/version/tags but not the Repository URL.

2. The skill detail (i) modal (and the equivalent modal in semantic-search results) shows a single "View on GitHub" link pointing at the SKILL.md file. The stored `repository_url` is never surfaced, and the list/semantic-search payloads do not carry the field, so users cannot reach the repository root.

### Goals
- Derive `https://<github-host>/<owner>/<repo>` from both supported SKILL.md URL shapes plus GitHub Enterprise raw hosts, in a pure helper on the backend.
- Return the derived value as `repository_url` in the `/api/skills/parse-skill-md` response.
- Auto-fill the Repository URL field in the registration form on Parse success, keeping the field editable.
- Carry the stored `repository_url` through `SkillInfo` and semantic-search skill results so the UI has data to show.
- Replace "View on GitHub" with "View Skill" (SKILL.md URL) + "View Repo" (repository root, only when present) in both skill modals.
- Add `repository_url` to the frontend `Skill` and `SemanticSkillHit` types.

### Non-Goals
- Verifying the derived repository exists or is reachable.
- Deriving repository URLs for non-GitHub hosts (GitLab, Bitbucket, generic URLs).
- Backfilling `repository_url` for skills registered before this change.
- Re-indexing the semantic-search collection at deploy time (existing skills appear in semantic search without `repository_url` until re-indexed; see Open Questions).
- Changing `SkillRegistrationRequest` / `SkillCard` schemas; both already accept and store `repository_url`.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/utils/url_utils.py` | GitHub URL translation helpers (`translate_skill_url`, `_is_github_hostname`, `_is_raw_github_url`, `_translate_github_url_to_raw`) | Home of the new `derive_repository_url` helper; already models the github.com vs enterprise-host split and the blob vs raw URL shapes |
| `registry/services/skill_service.py` | Skill business logic; `_parse_skill_md_content` (line ~216) builds the parse result dict; `list_skills_for_user`/`get_skills_paginated` build `SkillInfo` | Parse result gains `repository_url`; `SkillInfo` construction gains the field |
| `registry/api/skill_routes.py` | `/parse-skill-md` route (line ~230) copies fields from the service result into the response; fast-path `SkillInfo` construction (line ~177) | Route response adds `repository_url`; fast-path listing adds the field |
| `registry/schemas/skill_models.py` | `SkillCard.repository_url` (line 132) and `SkillRegistrationRequest.repository_url` (line 293) already exist; `SkillInfo` (line 239) lacks the field | `SkillInfo` gains `repository_url: str \| None` |
| `registry/api/search_routes.py` | `SkillSearchResult` (line 160) shapes semantic-search skill hits | Gains `repository_url: str \| None` |
| `registry/repositories/documentdb/search_repository.py` | Indexes skills into the semantic-search collection (`metadata` dict at line ~817) and projects `result_entry` dicts for skill hits (lines ~1339, ~1596, ~1991) | Index metadata and all three hit projections gain `repository_url` |
| `frontend/src/pages/Dashboard.tsx` | Skill registration form state, `handleParseSkillMd` (line ~1420), Parse button (line ~3342), Repository URL input (line ~3403) | Auto-fill `repository_url` from parse response |
| `frontend/src/components/SkillCard.tsx` | Skill detail (i) modal action bar (line ~650) with the single "View on GitHub" link | Replace with "View Skill" + "View Repo" |
| `frontend/src/components/SemanticSearchResults.tsx` | `SkillContentModal` action bar (line ~336) with the same "View on GitHub" link | Same replacement |
| `frontend/src/types/skill.ts` | Shared `Skill` interface | Gains `repository_url?: string` |
| `frontend/src/hooks/useSemanticSearch.ts` | `SemanticSkillHit` interface (line 67) | Gains `repository_url?: string` |
| `tests/unit/test_skill_service_parsing.py` | Existing unit-test style for parse-related logic | Pattern for the new helper tests |
| `tests/unit/api/test_skill_inline_content.py` | Existing route-test style (TestClient + mocked service) | Pattern for the parse-route test |

### Existing Patterns Identified
1. **GitHub hostname classification**: `_is_github_hostname` treats `github.com`, `raw.githubusercontent.com`, and any host containing `github` (enterprise, e.g. `github.mycompany.com`) as GitHub. New helper must reuse this rather than re-implement.
   - Files: `registry/utils/url_utils.py`
   - How a future implementer should follow this: classify with `_is_github_hostname(hostname)`, then branch on raw-vs-blob shape.
2. **Raw URL shapes**: public GitHub raw = `raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/<path>`; enterprise raw = `raw.github.mycompany.com/...` (host starts with `raw.` and contains `github`). Blob shape = `/<owner>/<repo>/blob/<branch>/<path>` on any GitHub host.
   - Files: `registry/utils/url_utils.py` (`_translate_github_url_to_raw`)
   - How: reuse the same regex shape `^/([^/]+)/([^/]+)/(?:blob|raw)/...` for blob URLs and a `refs/heads/`-aware parse for raw URLs.
3. **Parse result copying**: the route copies fields one by one from the service dict; adding a key means touching both the service result and the route response.
   - Files: `registry/services/skill_service.py`, `registry/api/skill_routes.py`
4. **SkillInfo construction is duplicated** in two places (fast path in `skill_routes.py` and `skill_service.list_skills_for_user`); any new field must be added to both or the two paths diverge.
   - Files: `registry/api/skill_routes.py` (~177), `registry/services/skill_service.py` (~658)
5. **Semantic-search skill hits are projected in three near-identical dict literals** in `search_repository.py` (search path at ~1339, grouped-results paths at ~1596 and ~1991); the field must be added to all three plus the index-time `metadata` dict (~817) or results will be inconsistent between code paths.
6. **Frontend parse auto-fill**: `handleParseSkillMd` sets fields via `setSkillForm(prev => ({...prev, ...}))` using `data.<field> || prev.<field>` fallbacks.
   - Files: `frontend/src/pages/Dashboard.tsx` (~1429)
7. **Modal action links**: both modals render an `<a>` with `ArrowTopRightOnSquareIcon`, `text-amber-700 dark:text-amber-300 hover:underline`, `target="_blank" rel="noopener noreferrer"`.
   - Files: `frontend/src/components/SkillCard.tsx` (~652), `frontend/src/components/SemanticSearchResults.tsx` (~338)

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `translate_skill_url` | Reuses classification from | `derive_repository_url` shares `_is_github_hostname` / `_is_raw_github_url` |
| `/parse-skill-md` response | Extends | New `repository_url` key (string or null) |
| `SkillInfo` | Extends | New optional `repository_url` field, populated from `SkillCard` in both listing paths |
| `SkillSearchResult` (search_routes) | Extends | New optional `repository_url`, projected from search-repository hit entries |
| Semantic-search index `metadata` | Extends | `repository_url` stored at index time so hits can project it |
| Registration form | Uses | Parse response `repository_url` auto-fills the form field |
| Skill modals (2) | Use | `skill.repository_url` renders the "View Repo" link |

### Constraints and Limitations Discovered
- `SkillInfo` is the wire shape for skill listings; the frontend `Skill` type mirrors it. Without adding the field to `SkillInfo`, a modal-only change would render nothing for registry-listed skills.
- Semantic-search hits for already-registered skills keep their old indexed `metadata` until re-indexing; "View Repo" simply does not render for them (graceful degradation, matching the acceptance criterion for pre-change skills).
- `HttpUrl` serialization: `SkillCard.repository_url` is `HttpUrl | None`; when projecting into `SkillInfo`/search dicts it must be converted with `str(...)` (same pattern as `skill_md_raw_url`).
- The existing parse flow validates and fetches the URL; derivation is a pure string transform on the user-provided URL and must not add network calls (out of scope: repo existence checks).
- `asyncio_mode = "auto"` is set in `pyproject.toml`, so async test functions need no decorator.
- The skill modal in `SkillCard.tsx` and the one in `SemanticSearchResults.tsx` use different skill types (`Skill` vs `SemanticSkillHit`); both types need the field.

## Architecture

### System Context Diagram
```
+-------------------+       POST /api/skills/parse-skill-md?url=...        +----------------------+
| Registration Form  | --------------------------------------------------> | skill_routes         |
| (Dashboard.tsx)    | <--- { ..., repository_url: "https://github.com/   |   skill_service      |
|  - auto-fill field |          org/repo" | null }                        |     url_utils (NEW   |
+-------------------+                                                      |     derive helper)   |
                                                                           +----------------------+
+-------------------+       GET /api/skills (list)                      +----------------------+
| SkillCard modal    | <--- SkillInfo { ..., repository_url } ---------- | skill_routes/service |
+-------------------+                                                   +----------------------+

+-------------------------+   POST /api/search/semantic                  +----------------------+
| SemanticSearchResults   | <--- SkillSearchResult { ...,               | search_routes        |
| modal                   |        repository_url } ------------------- |  search_repository   |
+-------------------------+                                             |  (index + projection)|
                                                                        +----------------------+
```

### Sequence Diagram
```
User            Dashboard            Backend                url_utils
 |  paste URL      |                    |                      |
 |--------------->|  POST parse-skill-md(url)                 |
 |                |------------------------------------------->|
 |                |                    | derive_repository_url|
 |                |                    |--------------------->|
 |                |                    |   "https://github.com/org/repo" | None
 |                |   {success, name, ..., repository_url}    |
 |<------------------------------------------------------------|
 |  edit any field (Repository URL stays editable)             |
```

### Component Diagram
```
url_utils.py
  _is_github_hostname / _is_raw_github_url   (existing)
  derive_repository_url(url) -> str | None   (NEW, pure function)

skill_service._parse_skill_md_content        (adds key to result dict)
skill_routes.parse_skill_md                  (adds key to response)
skill_routes.list_skills + skill_service     (SkillInfo gains repository_url)
search_repository                            (index metadata + 3 projections gain field)
search_routes.SkillSearchResult              (schema gains field)

Dashboard.handleParseSkillMd                 (auto-fill)
SkillCard modal                              (View Skill + View Repo)
SemanticSearchResults modal                  (View Skill + View Repo)
types/skill.ts + useSemanticSearch.ts        (type fields)
```

## Data Models

### New Models
None. All changes extend existing models.

### Model Changes
- `registry/schemas/skill_models.py` - `SkillInfo`:
  ```python
  repository_url: str | None = Field(
      None, description="URL to the git repository containing the skill"
  )
  ```
  placed directly after `skill_md_raw_url`, mirroring `SkillCard`.
- `registry/api/search_routes.py` - `SkillSearchResult`:
  ```python
  repository_url: str | None = None
  ```
- Frontend `frontend/src/types/skill.ts` - `Skill`:
  ```ts
  repository_url?: string;
  ```
- Frontend `frontend/src/hooks/useSemanticSearch.ts` - `SemanticSkillHit`:
  ```ts
  repository_url?: string;
  ```

## API / CLI Design

### New Endpoints / Commands
None; the existing endpoint gains a response field.

**Modified endpoint:** `POST /api/skills/parse-skill-md?url=<SKILL.md URL>`

**Request:**
```bash
curl -X POST "http://localhost/api/skills/parse-skill-md?url=https%3A%2F%2Fgithub.com%2Forg%2Frepo%2Fblob%2Fmain%2Fskills%2Ffoo%2FSKILL.md" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected Response (derivable):**
```json
{
  "success": true,
  "name": "foo",
  "name_slug": "foo",
  "description": "...",
  "version": "1.0.0",
  "tags": ["pdf"],
  "content_version": "abc123",
  "skill_md_url": "https://github.com/org/repo/blob/main/skills/foo/SKILL.md",
  "skill_md_raw_url": "https://raw.githubusercontent.com/org/repo/refs/heads/main/skills/foo/SKILL.md",
  "repository_url": "https://github.com/org/repo"
}
```

**Expected Response (not derivable):** identical shape with `"repository_url": null`.

**Error Cases:**
- 400 (unchanged): URL fails validation/SSRF/HTTP checks - the derivation never introduces new failure modes.

## Configuration Parameters

### New Environment Variables
None.

### Settings / Config Class Updates
None.

### Deployment Surface Checklist
No deployment surface changes: no new env vars, no Docker/Terraform/Helm values, no schema migrations (DocumentDB stores skills as flexible documents; the semantic-search `metadata` dict accepts the new key without migration; old documents simply lack it and project as `None`).

## New Dependencies
This change uses only existing dependencies. (The frontend already imports no new packages; backend uses stdlib `urllib.parse` / `re` already in use.)

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Add the derivation helper
**File:** `registry/utils/url_utils.py`
**Lines:** append after `_translate_github_url_to_raw` (before `translate_skill_url`)

```python
def derive_repository_url(
    url: str,
) -> str | None:
    """Derive the repository root URL from a SKILL.md URL.

    Supports the URL shapes users paste into the registration form:

    - https://github.com/org/repo/blob/<branch>/<path>/SKILL.md
      -> https://github.com/org/repo
    - https://raw.githubusercontent.com/org/repo/refs/heads/<branch>/<path>/SKILL.md
      -> https://github.com/org/repo
    - Enterprise equivalents:
      https://github.mycompany.com/org/repo/blob/<branch>/<path>/SKILL.md
        -> https://github.mycompany.com/org/repo
      https://raw.github.mycompany.com/org/repo/refs/heads/<branch>/<path>/SKILL.md
        -> https://github.mycompany.com/org/repo

    Args:
        url: The SKILL.md URL provided by the user

    Returns:
        The repository root URL, or None when the URL is not a
        GitHub file URL whose repository can be derived (non-GitHub
        hosts, GitHub hosts without a repo/file path, or unparseable URLs).
    """
    url = (url or "").strip()
    if not url:
        return None

    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or not hostname:
        return None

    # Only GitHub instances (public or enterprise) are supported.
    if not _is_github_hostname(hostname):
        return None

    # Strip scheme for uniform handling below.
    hostname_lower = hostname.lower()

    # Path may describe a blob/tree file URL on any GitHub host, or a raw
    # URL on a raw.* GitHub host.
    path = parsed.path or ""

    # Case 1: raw URL on a raw.* host (raw.githubusercontent.com or
    # raw.github.mycompany.com). Shape:
    #   /<owner>/<repo>/refs/heads/<branch>/<path>
    #   /<owner>/<repo>/<branch>/<path>   (legacy raw shape)
    if _is_raw_github_url(hostname_lower):
        raw_pattern = re.compile(r"^/([^/]+)/([^/]+)/(?:refs/heads/)?([^/]+)(?:/.+)?$")
        match = raw_pattern.match(path)
        if not match:
            return None
        owner, repo = match.group(1), match.group(2)
        repo_host = "github.com" if hostname_lower == "raw.githubusercontent.com" else hostname_lower[4:]
        return f"https://{repo_host}/{owner}/{repo}"

    # Case 2: blob/tree file URL on a github.com or enterprise host.
    # Shape: /<owner>/<repo>/(blob|raw)/<branch>/<path>
    blob_pattern = re.compile(r"^/([^/]+)/([^/]+)/(?:blob|raw)/([^/]+)(?:/.+)?$")
    match = blob_pattern.match(path)
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    return f"https://{hostname_lower}/{owner}/{repo}"
```

Behavior notes:
- `https://github.com/org/repo` (no blob/raw file path) returns `None`: there is no file-path evidence, and the task scopes derivation to the two supported SKILL.md shapes.
- Enterprise blob host is returned as-is (`github.mycompany.com`); enterprise raw host loses its `raw.` prefix (`raw.github.mycompany.com` -> `github.mycompany.com`), the inverse of `_translate_github_url_to_raw`.
- Public raw (`raw.githubusercontent.com`) maps back to `github.com`.

#### Step 2: Return `repository_url` from the parse service
**File:** `registry/services/skill_service.py`
**Lines:** ~243 (derive early, before validation, so it derives from the user-provided URL) and ~279 (result dict)

After `user_url, raw_url = translate_skill_url(url)` add:
```python
repository_url = derive_repository_url(url)
```
(import `derive_repository_url` alongside `translate_skill_url` at line 41.)

In the `result` dict literal add:
```python
"repository_url": repository_url,
```

Also update the function docstring's "Returns" list to mention `repository_url`.

#### Step 3: Return `repository_url` from the parse route
**File:** `registry/api/skill_routes.py`
**Lines:** ~243-253

Add to the response dict:
```python
"repository_url": result.get("repository_url"),
```

#### Step 4: Carry `repository_url` in `SkillInfo` (both listing paths)
**File:** `registry/schemas/skill_models.py` - add the field to `SkillInfo` after `skill_md_raw_url` (see Data Models).

**File:** `registry/services/skill_service.py` (~658) and `registry/api/skill_routes.py` (~177) - in each `SkillInfo(...)` constructor add:
```python
repository_url=str(s.repository_url) if s.repository_url else None,
```

#### Step 5: Carry `repository_url` through semantic search
**File:** `registry/repositories/documentdb/search_repository.py`
- Index-time `metadata` dict (~817): add
  ```python
  "repository_url": str(skill.repository_url) if skill.repository_url else None,
  ```
- All three skill `result_entry` dict literals (~1339, ~1596, ~1991): add
  ```python
  "repository_url": metadata.get("repository_url"),
  ```

**File:** `registry/api/search_routes.py`
- `SkillSearchResult` gains `repository_url: str | None = None` (line ~166).
- The `SkillSearchResult(...)` construction (~662) adds `repository_url=skill.get("repository_url"),`.

#### Step 6: Frontend - auto-fill on Parse
**File:** `frontend/src/pages/Dashboard.tsx`
**Lines:** ~1429-1435 (`handleParseSkillMd` success branch)

```ts
if (data.success) {
  setSkillForm(prev => ({
    ...prev,
    name: data.name_slug || prev.name,
    description: data.description || prev.description,
    version: data.version || prev.version,
    tags: data.tags?.length > 0 ? data.tags.join(', ') : prev.tags,
    repository_url: data.repository_url || '',
  }));
  ...
}
```

Notes:
- Assignment (not fallback to `prev.repository_url`): a re-parse of a non-derivable URL must clear a previously auto-filled derived value, per the issue. A value the user typed manually before clicking Parse is overwritten by `null` too - accepted trade-off recorded in review (the Parse button is the fill-trigger; the field stays editable afterwards and on subsequent edits).
- The field's `onChange` is untouched, so the user can edit the value after Parse.

#### Step 7: Frontend - modals
**File:** `frontend/src/components/SkillCard.tsx` (~652-662): replace the single link with:
```tsx
{skill.skill_md_url && (
  <a
    href={skill.skill_md_url}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1 text-sm text-amber-700 dark:text-amber-300 hover:underline"
  >
    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
    View Skill
  </a>
)}
{skill.repository_url && (
  <a
    href={skill.repository_url}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1 text-sm text-amber-700 dark:text-amber-300 hover:underline"
  >
    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
    View Repo
  </a>
)}
```

**File:** `frontend/src/components/SemanticSearchResults.tsx` (~338-348): identical replacement in `SkillContentModal`.

#### Step 8: Frontend - types
- `frontend/src/types/skill.ts`: add `repository_url?: string;` after `skill_md_raw_url`.
- `frontend/src/hooks/useSemanticSearch.ts`: add `repository_url?: string;` to `SemanticSkillHit` after `skill_md_raw_url`.

### Error Handling
- The helper is total: any malformed/foreign input returns `None`; it never raises.
- Parse-route error behavior is unchanged (400 on `SkillUrlValidationError`).
- Frontend: `data.repository_url || ''` keeps the form field a controlled string.

### Logging
- `logger.debug` inside `derive_repository_url` when derivation returns `None` for a GitHub hostname whose path does not match either pattern (mirrors the debug logging style of `_translate_github_url_to_raw`). No new log levels or configuration.

## Observability
### Tracing / Metrics / Logging Points
- Debug log on derivation miss (Step 1). No new metrics: the field is derived in-line with the existing parse request, so existing `/parse-skill-md` request metrics already cover the feature.

## Scaling Considerations
- The helper is O(path length) string work per parse call - negligible next to the HTTP fetch the parse already performs.
- `SkillInfo` and semantic-search payloads grow by one short string (or null) per skill; no pagination or index changes.
- No caching considerations: derivation is deterministic and cheap.

## File Changes

### New Files
None (unit tests extend existing files; see below).

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/utils/url_utils.py` | append (~55 new) | Add `derive_repository_url` helper |
| `registry/services/skill_service.py` | ~41, ~243, ~279, ~658 | Import helper; add `repository_url` to parse result and to `SkillInfo` construction |
| `registry/api/skill_routes.py` | ~177, ~251 | Add `repository_url` to fast-path `SkillInfo` and parse response |
| `registry/schemas/skill_models.py` | ~249 | Add `repository_url` to `SkillInfo` |
| `registry/repositories/documentdb/search_repository.py` | ~817, ~1339, ~1596, ~1991 | Index and project `repository_url` |
| `registry/api/search_routes.py` | ~166, ~662 | Add field to `SkillSearchResult` and its construction |
| `frontend/src/types/skill.ts` | ~44 | Add `repository_url?` to `Skill` |
| `frontend/src/hooks/useSemanticSearch.ts` | ~73 | Add `repository_url?` to `SemanticSkillHit` |
| `frontend/src/pages/Dashboard.tsx` | ~1435 | Auto-fill `repository_url` on parse success |
| `frontend/src/components/SkillCard.tsx` | ~652 | "View Skill" + conditional "View Repo" |
| `frontend/src/components/SemanticSearchResults.tsx` | ~338 | Same modal change |
| `tests/unit/test_skill_models.py` | append | `SkillInfo.repository_url` default/population coverage |
| `tests/unit/test_url_utils.py` | new | Unit tests for `derive_repository_url` |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (helper + plumbing) | ~90 |
| New tests | ~150 |
| Modified code | ~40 |
| **Total** | **~280** |

## Testing Strategy
See `./testing.md` for the full executable plan: helper unit tests (both shapes, enterprise, negatives), parse-route response test, `SkillInfo`/search plumbing tests, and manual UI verification steps.

## Alternatives Considered

### Alternative 1: Derive on the frontend only
**Description:** parse the SKILL.md URL client-side in `handleParseSkillMd` and fill the field without backend involvement.
**Pros:** no API change.
**Cons:** duplicates URL logic in TS, cannot enrich the API contract for other consumers (CLI, federation), the issue explicitly requires the backend parse response to return `repository_url`.
**Why Rejected:** the task requires the backend response field.

### Alternative 2: Derive at registration time server-side when `repository_url` is absent
**Description:** auto-populate `SkillCard.repository_url` from `skill_md_url` during registration even without Parse.
**Pros:** backfills silently for all future skills.
**Cons:** changes stored data beyond what the task asks; a user explicitly submitting an empty repository URL would get a surprise value.
**Why Rejected:** out of the stated scope; registration payload handling stays untouched.

### Alternative 3: Store a separate derived field on `SkillCard`
**Description:** add e.g. `derived_repository_url` distinct from the user-supplied `repository_url`.
**Pros:** preserves provenance.
**Cons:** schema bloat; `SkillCard.repository_url` already exists and the registration flow treats it as the single source of truth.
**Why Rejected:** unnecessary schema change.

### Comparison Matrix

| Criteria | Chosen (helper + plumbing) | Alt 1 (frontend-only) | Alt 2 (registration-time) |
|----------|----------------------------|------------------------|----------------------------|
| Complexity | Low | Low | Medium |
| Matches task requirements | Yes | No (no API field) | Partial (extra behavior) |
| Reuse across consumers | Yes (API, CLI, UI) | No | Yes |
| Schema changes | `SkillInfo` + search result only | None | `SkillCard` write-path change |

## Rollout Plan
- Phase 1: Implementation (this patch).
- Phase 2: Testing per `./testing.md`.
- Phase 3: Deployment - no migration or config change; optionally trigger a semantic-search re-index so existing skills gain `repository_url` in semantic results (out of scope for the patch, noted for operators).

## Open Questions
- Should operators re-run the semantic-search indexing job after deploying so pre-existing skills show "View Repo" in semantic search? The registry listing path picks the field up immediately; only the semantic-search index lags. Deferred as a deploy-time action, not a code change.

## References
- `registry/utils/url_utils.py` - existing GitHub URL translation (basis for the new helper).
- Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/846
