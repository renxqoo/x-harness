# GitHub Issue: Derive Repository URL from SKILL.md URL during parse and surface it in the skill detail modals

## Title
Derive repository_url from the SKILL.md URL in /parse-skill-md and show "View Repo" alongside "View Skill" in skill modals

## Labels
- enhancement
- backend
- frontend
- developer-experience

## Description

### Problem Statement
Two related gaps in skill registration and the skill detail modal.

First, the registration form makes the user type the Repository URL by hand even though it is derivable from the SKILL.md URL they already pasted. Both supported URL shapes encode the same `https://<github-host>/<owner>/<repo>` prefix:

- `https://github.com/org/repo/blob/<branch>/<path>/SKILL.md` (GitHub blob)
- `https://raw.githubusercontent.com/org/repo/refs/heads/<branch>/<path>/SKILL.md` (GitHub raw)

The same derivation applies to GitHub Enterprise hosts (for example `github.mycompany.com`, with raw content at `raw.github.mycompany.com`). The Parse action already auto-fills name, description, version, and tags, but does not touch the Repository URL field.

Second, the skill detail (i) modal shows a single "View on GitHub" link that points at the SKILL.md file. Even when the registry stores a `repository_url` for the skill, the modal never surfaces it, and the listing payloads (`SkillInfo`, semantic-search skill hits) do not carry the field at all. The same limitation exists in the skill modal shown in semantic-search results.

### Proposed Solution
1. **Backend:** add a URL-derivation helper in `registry/utils/url_utils.py` that extracts `https://<github-host>/<owner>/<repo>` from both supported SKILL.md URL shapes (and GitHub Enterprise raw hosts). Return the derived value as `repository_url` in the `/api/skills/parse-skill-md` response. Only GitHub-shaped URLs are derived; for anything else return `None` so the frontend can leave the field empty rather than guessing.
2. **Frontend:** on Parse success, auto-fill the Repository URL field from the parse response (only when the backend derived one; the field remains editable afterwards). Add `repository_url` to the frontend `Skill` and `SemanticSkillHit` types, plumb the stored `repository_url` through `SkillInfo` and the semantic-search skill results, and replace the single "View on GitHub" link in both skill detail modals with two links:
   - "View Skill" pointing at the SKILL.md URL (existing behavior, relabeled), and
   - "View Repo" pointing at the repository root, rendered only when a repository URL exists.

### User Stories
- As a skill author registering a new skill, I want the Repository URL to be derived automatically from the SKILL.md URL I pasted so that I do not have to retype it.
- As a registry user viewing a skill's details, I want a link to the repository root so that I can browse the skill's source (README, issues, releases), not just its SKILL.md file.
- As a GitHub Enterprise user, I want repository derivation to work for my company's GitHub host so that I get the same convenience as public GitHub users.

### Acceptance Criteria
- [ ] `POST /api/skills/parse-skill-md?url=https://github.com/org/repo/blob/main/skills/foo/SKILL.md` returns `"repository_url": "https://github.com/org/repo"`.
- [ ] `POST /api/skills/parse-skill-md?url=https://raw.githubusercontent.com/org/repo/refs/heads/main/skills/foo/SKILL.md` returns `"repository_url": "https://github.com/org/repo"`.
- [ ] A GitHub Enterprise blob URL (`https://github.mycompany.com/org/repo/blob/main/SKILL.md`) returns `"repository_url": "https://github.mycompany.com/org/repo"`.
- [ ] A GitHub Enterprise raw URL (`https://raw.github.mycompany.com/org/repo/refs/heads/main/SKILL.md`) returns `"repository_url": "https://github.mycompany.com/org/repo"`.
- [ ] A non-GitHub URL (for example `https://gitlab.com/org/repo/-/blob/main/SKILL.md` or `https://example.com/SKILL.md`) returns `"repository_url": null`.
- [ ] A GitHub hostname without a repo/file path shape (for example `https://github.com/org/repo`) returns `"repository_url": null` (nothing derivable from a non-file URL).
- [ ] Clicking Parse with a derivable URL auto-fills the Repository URL field; the field remains editable afterwards.
- [ ] Clicking Parse with a non-derivable URL leaves the field empty and clears any previously auto-filled derived value from an earlier parse.
- [ ] The skill detail (i) modal shows "View Skill" (SKILL.md URL) and, when `repository_url` is present, "View Repo" (repository root).
- [ ] The semantic-search skill modal shows the same pair of links under the same conditions.
- [ ] The frontend `Skill` and `SemanticSkillHit` types include `repository_url`.
- [ ] Skills registered before this change (no stored `repository_url`) show only "View Skill"; no error and no empty link.

### Out of Scope
- Verifying that the derived repository URL exists or is reachable.
- Deriving repository URLs for non-GitHub hosts such as GitLab or Bitbucket.
- Changing `SkillRegistrationRequest` / `SkillCard` schemas (both already accept and store `repository_url`).
- Backfilling `repository_url` for skills registered before this change (they keep `None` until re-saved).

### Dependencies
- None. The parse endpoint, the `SkillCard.repository_url` field, and both modals already exist.

### Related Issues
- #846
