# Expert Review: Demo Video Index Page

*Created: 2026-09-30*
*Reviewed: `github-issue.md` + `lld.md` (draft)*
*Scope: documentation-only change adding `docs/demo-videos.md` and one README header link*

## Reviewer Roster

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | Markdown rendering, page UX, information architecture |
| Backend Engineer | Byte | Data fidelity (URLs), link integrity, verification mechanics |
| SRE/DevOps Engineer | Circuit | Docs deploy surface (mkdocs), maintenance burden |
| Security Engineer | Cipher | External link hygiene, secrets, supply chain |
| SMTS (Overall) | Sage | Architecture, scope discipline, maintainability |

---

## Pixel (Frontend Engineer)

**Focus:** How the page renders and reads on github.com (desktop and mobile), and whether a visitor can actually find "their" video in under 10 seconds.

### Strengths
- Two-level structure (Quick Index table up top, grouped sections below) matches how `docs/index.md` already presents videos, so it will feel native.
- Explicitly disambiguating the two Dynamic Tool Discovery recordings solves the single most confusing thing about the current scattered state.

### Concerns
1. **Should fix:** The Quick Index table as drafted has a "Feature Area" column plus per-section "Also referenced in" lines. On mobile, a 5-column table turns into horizontal scroll. Keep the table to 3 columns (Video | Platform | Feature Area) and keep cross-reference detail in the per-video sections only. (The drafted LLD already does this; making it an explicit constraint so it survives implementation.)
2. **Should fix:** The bare-URL video from `README.md` ("MCP Servers, Agents and Skills Registry") must be visibly marked as an inferred title, or readers will assume it is the video's real name.
3. **Nit:** Emoji in section headings render inconsistently across GitHub themes; keep headings plain text and keep the emoji only in the README link line, matching the existing header style.

### New libraries / infra dependencies
None. Correct for a docs-only change.

### Better alternatives considered
Rendering embedded `<video>`/iframe players in the page. Rejected: GitHub sanitizes iframes, and Vidcast does not offer a plain embeddable player; plain links are the only reliable cross-host pattern here.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES**
(Both "should fix" items are page-content constraints; fold into the LLD page skeleton.)

---

## Byte (Backend Engineer)

**Focus:** The inventory is the "dataset" of this change. Its correctness is the whole game.

### Strengths
- The inventory was derived from a mechanical scan (`grep -rnoE ...` over `*.md`), 24 occurrences deduplicated to 13 unique URLs, with per-URL "also linked from" provenance. That is the right method.
- The two distinct Tool Discovery URLs (`cee25b31...` vs `cee1847d...`) are correctly treated as separate videos.

### Concerns
1. **Must fix - URL fidelity verification.** Every video URL is an opaque UUID that cannot be spell-checked by eye, and GitHub asset URLs are unforgiving: one transposed character produces a dead link that no review will catch. The LLD says "byte-for-byte" but specifies no mechanism. The design MUST add a mechanical check: after writing the page, run a literal fixed-string grep for each of the 13 URLs inside `docs/demo-videos.md` and confirm every URL also still matches its source file(s). This check belongs in both `testing.md` (as the runnable procedure) and the LLD testing strategy.
2. **Must fix - completeness re-scan at implementation time.** The 13-URL inventory was computed before implementation. The implementation step must re-run the scan pattern and confirm no URL appears in the repo markdown that is absent from the new page (guards against the page being written from a stale inventory).
3. **Should fix:** The scan pattern should be recorded verbatim inside `docs/demo-videos.md` (as a maintenance footnote) so the next author can regenerate the inventory rather than hand-maintaining it.

### New libraries / infra dependencies
None.

### Better alternatives considered
A CI link checker for markdown. Good idea upstream, out of scope for this change.

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES**
(Items 1 and 2 are blocking; they change the testing strategy, not the page content.)

---

## Circuit (SRE/DevOps Engineer)

**Focus:** Where this page surfaces in deployed/ rendered docs and what it costs to maintain.

### Strengths
- Explicitly leaves `mkdocs.yml` untouched with the constraint documented as a non-goal rather than silently skipped.
- No build, image, or deployment surface changes; zero operational risk.

### Concerns
1. **Should fix:** Because the page is not in the mkdocs nav, the rendered docs site will not list it in the left nav (it would only be reachable by URL). Acceptable per the Markdown-only constraint, but the LLD should name the exact follow-up (add `Demo Videos: demo-videos.md` under an appropriate nav section) so it is a one-line change later, and the page itself should carry a maintenance note pointing at both follow-ups (nav entry, broken `#demo-videos` anchor in `docs/index.md`).
2. **Nit:** The page should state the tag it was verified against (v1.24.3) so future readers know how fresh the inventory is. The drafted skeleton includes this; keep it.

### New libraries / infra dependencies
None.

### Better alternatives considered
Generating the page at build time from a link scan. Rejected: adds a build step to a docs-only change and diverges from how every other docs page here is maintained (by hand).

### Questions for author
- None.

### Verdict: **APPROVED WITH CHANGES**

---

## Cipher (Security Engineer)

**Focus:** External link hygiene and exposure introduced by the new page.

### Strengths
- No new domains: YouTube, `github.com/user-attachments`, and `app.vidcast.io` are all already referenced throughout the repo; the page only re-links existing URLs.
- No secrets, tokens, internal hostnames, or build surface introduced.

### Concerns
1. **Informational:** GitHub user-attachment asset URLs are effectively permanent but unversioned; if a video is ever deleted upstream the index will accumulate dead links. The maintenance note in the page (already in the skeleton) covers this - keep it.
2. **Informational:** All links are plain `https://`; no `http://`, no redirector services. Nothing to change.

### New libraries / infra dependencies
None.

### Better alternatives considered
None worth recording.

### Questions for author
- None.

### Verdict: **APPROVED**

---

## Sage (SMTS, Overall)

**Focus:** Scope discipline and whether this design actually closes issue #1190.

### Strengths
- Scope is exactly the issue: one new page + one README link; deduplication and anchor fixes correctly deferred to non-goals rather than scope-crept in.
- The inventory-with-provenance table is the strongest part of the design; it makes completeness auditable instead of aspirational.
- Alternatives considered (consolidation, README-table, build-time generation) are the right three and correctly rejected.

### Concerns
1. **Should fix:** Make the acceptance check executable, not prose. "Lists every demo video" must be operationally defined as: the literal-grep set equality between URLs found in repo markdown (excluding the new page itself) and URLs present in the new page. Byte's must-fix items produce exactly this; endorse them.
2. **Should fix:** The README edit must be minimal and surgical - insert the index link as the first item on the existing "Demo Videos:" line, changing nothing else on the line. The LLD says this; keep it as a hard implementation constraint since a careless edit of that long line is the easiest way to accidentally mangle 7 URLs.
3. **Nit:** Estimated ~130 lines for the new page is realistic; do not let it balloon past ~200 lines - the quick index is the product, the per-video sections should stay one to two lines each.

### Verdict: **APPROVED WITH CHANGES**

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Recommendations |
|----------|---------|----------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Keep quick-index table to 3 columns; mark inferred title; no emoji in headings |
| Backend (Byte) | APPROVED WITH CHANGES | 2 | Mechanical per-URL literal-grep fidelity check; completeness re-scan at implementation time |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | Name the mkdocs nav follow-up; page carries maintenance note + verified-against tag |
| Security (Cipher) | APPROVED | 0 | No new domains; dead-link maintenance note |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | Executable acceptance check (set equality); surgical README line edit; page size cap |

### Consolidated Blocking / Should-Fix Items to Fold into the LLD

1. (Must fix, Byte) Add mechanical URL-fidelity verification: literal fixed-string grep of each of the 13 URLs in the new page, cross-checked against source files. Record in LLD testing strategy and testing.md.
2. (Must fix, Byte) Re-run the inventory scan at implementation time and confirm set equality before capture.
3. (Should fix, Pixel) Mark the README bare-URL video title as inferred; keep table at 3 columns; plain-text section headings.
4. (Should fix, Circuit) Record the exact mkdocs nav follow-up line and the broken-anchor follow-up in the page's maintenance note; state "last verified against v1.24.3" on the page.
5. (Should fix, Byte) Include the scan regex as a footnote in the page for future maintainers.
6. (Should fix, Sage) README edit constrained to inserting the first link on the "Demo Videos:" line; nothing else on the line changes.

**Resolution:** All six items were folded back into `lld.md` before implementation: items 1-2 into *Testing Strategy* and *Implementation Details* (Step 3 verification gate), items 3-5 into the *Step 1* page skeleton, item 6 into *Step 2*. No blocking findings remain; proceeding to implementation with the revised LLD.
