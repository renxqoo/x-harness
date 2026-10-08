# Low-Level Design: Demo Video Index Page

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Revised after expert review (see review.md)*

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
Demo videos are scattered across the README and about a dozen files under `docs/`, hosted on three platforms (YouTube, GitHub user-attachment recordings, Vidcast). A visitor who wants to watch a demo has no single place to look. The same video is sometimes linked from two or three places while others are linked from only one deep page, and one video is embedded as a bare, untitled URL. A complete scan of the repository markdown (run during this design; see the inventory in [Implementation Details](#implementation-details)) found **13 unique video URLs**.

### Goals
- Create `docs/demo-videos.md`, a single page that indexes every demo video in the repository, grouped by feature area.
- Every entry states what the video shows, which platform hosts it, and where else in the repo it is linked.
- Add a prominent link to the new page from the README header "Demo Videos" line.
- Guarantee completeness by deriving the inventory from a markdown scan, not from memory.

### Non-Goals
- Removing or consolidating existing per-page video links (they still work; deduplication is a separate cleanup).
- Fixing the broken `README#demo-videos` anchor link in `docs/index.md:266` (separate issue).
- Adding the page to `mkdocs.yml` nav: the task constrains this change to Markdown only, and `mkdocs.yml` is build configuration. The page remains reachable on GitHub and via the README link.
- Indexing GIF animations (`docs/img/*.gif`) or the slide deck PDF; they are not videos.
- Video transcriptions, durations, or thumbnails.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `README.md` | Project landing page; header line 14 carries a "Demo Videos:" link list; line 108 embeds a bare video URL; Documentation table at line 826 | The README link addition targets line 14; line 108's bare video must be titled in the index |
| `docs/index.md` | Docs landing page with its own 3-video "Demo Videos" table (lines 12-18) and a broken `#demo-videos` anchor link (line 266) | Shows the existing grouping/table pattern the new page should follow and generalize |
| `docs/dynamic-tool-discovery.md` | Feature guide that embeds a distinct demo video twice (lines 145, 323) | Source of the second, easily-confused Tool Discovery video |
| `docs/security-scanner.md`, `docs/agent-skills-operational-guide.md`, `docs/federation-operational-guide.md`, `docs/aws-agent-registry-federation.md`, `docs/virtual-server-operations.md`, `docs/design/ans-integration.md` | Deep pages whose videos are only discoverable there | Each contributes one video plus the description text for its index entry |
| `release-notes/v1.0.3.md` | Historical release notes repeating the 3 original videos (lines 191-193) | Confirms which videos are "canonical" vs duplicated; release notes are not updated |
| `mkdocs.yml` | Docs site build config with a hand-curated nav (line 98+) | Read-only: nav changes are out of scope (Markdown-only constraint) |

### Existing Patterns Identified
1. **Docs landing table pattern**: `docs/index.md` uses a two-column `| Feature | Demo |` markdown table linking videos by title.
   - Files: `docs/index.md`
   - How a future implementer should follow this: reuse the table style for the quick-index at the top of the new page, then per-video sections with richer descriptions.
2. **Video link labeling patterns**: pages use varied forms - bold label + link (`docs/design/ans-integration.md`), badge + duplicate plain link (`docs/virtual-server-operations.md`), bare URL (`README.md:108`, `docs/agent-skills-operational-guide.md:5`, `docs/federation-operational-guide.md:7`).
   - Files: see table above
   - How a future implementer should follow this: the index normalizes all entries to `Title (Platform)` links with consistent descriptions; source pages stay untouched.
3. **README header quick links**: a single delimited line of pipe-separated links under the badges.
   - Files: `README.md` (line 14)
   - How a future implementer should follow this: add the index link at the front of that line for prominence.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `README.md` header | Extends | One link added to the "Demo Videos:" line pointing to `docs/demo-videos.md` |
| GitHub rendering | Uses | Relative link `docs/demo-videos.md` resolves on github.com from the repo root |
| Existing video pages | References | The index links to the same URLs; no source pages are modified |

### Constraints and Limitations Discovered
- **Vidcast is behind Cisco's player**: entries cannot promise inline embedding; plain links are the norm in this repo already.
- **GitHub user-attachment URLs are opaque UUIDs**: titles must come from surrounding link text, and one video (README:108) has none, so its title is derived from the heading directly above it ("MCP Servers, Agents and Skills Registry").
- **Two distinct Dynamic Tool Discovery videos exist** (`cee25b31...` from README/index, `cee1847d...` inside the feature guide); the index must present both with distinguishing descriptions.
- **URL fidelity matters**: `?playerMode=vidcast` appears on some Vidcast links but not others; the index must reproduce each URL byte-for-byte.

## Architecture

### System Context Diagram
```
                  +--------------------------------------------+
                  |                 README.md                  |
                  |  "Demo Videos:" line --> docs/demo-videos.md |
                  +---------------------+----------------------+
                                        | (one new link)
                                        v
+------------------+     +------------------------------+     +------------------+
| docs/index.md    |---->|      docs/demo-videos.md     |<----| deep guides      |
| (3-video table,  |     |   canonical complete index   |     | (security, fed,  |
|  stays as-is)    |     |   of 13 unique videos        |     |  ANS, agentcore) |
+------------------+     +---------------+--------------+     +------------------+
                                         | links out to
                       +-----------------+------------------+
                       v                 v                  v
                 YouTube           GitHub user-attachments   Vidcast
```

### Sequence Diagram
```
Visitor -> GitHub README: opens repo landing page
Visitor -> README: clicks "All Demo Videos" (docs/demo-videos.md)
Visitor -> docs/demo-videos.md: scans grouped quick-index table
Visitor -> docs/demo-videos.md: jumps to section for the feature area
Visitor -> Video host (YouTube / GitHub / Vidcast): clicks the specific video link
```

### Component Diagram
```
docs/demo-videos.md
  |- Quick Index (13-row table: title | platform | feature area)
  |- Section: Platform Overviews & Getting Started (4 videos)
  |- Section: Authentication & Security (2 videos)
  |- Section: Dynamic Tool Discovery (2 videos, distinguished)
  |- Section: Agent Skills & Virtual MCP Servers (2 videos)
  |- Section: Federation & Integrations (3 videos)
  '- Related resources (slide deck PDF, GIF demos pointer)
```

## Data Models

Not applicable - this is a documentation-only change with no runtime data models. The only "data" is the video inventory below (title, URL, platform, description, also-linked-from), which is realized as markdown tables and lists.

## API / CLI Design

**Not Applicable** - no endpoints or CLI commands are added or changed. The only "interface" is the markdown page itself, navigable on GitHub and any markdown renderer.

## Configuration Parameters

**Not Applicable** - no new environment variables, settings, or feature flags. (`mkdocs.yml` nav is deliberately not touched; see Non-Goals.)

## New Dependencies

This change uses only existing dependencies. It adds no packages, no build steps, and no tooling.

## Implementation Details

### Video Inventory (ground truth, from a full markdown scan at tag 1.24.3)

The scan pattern used (run in the repo root): `grep -rnoE 'https://(www\.youtube\.com/watch\?v=[A-Za-z0-9_-]+|app\.vidcast\.io/share/[A-Za-z0-9_-]+(\?playerMode=vidcast)?|github\.com/user-attachments/assets/[A-Za-z0-9-]+)' --include='*.md' .` - it returns 24 occurrences mapping to the 13 unique URLs below. URLs are reproduced byte-for-byte.

| # | Title | URL | Platform | Also linked from |
|---|-------|-----|----------|------------------|
| 1 | AWS Show & Tell presentation | `https://www.youtube.com/watch?v=dk0qVukHLGU` | YouTube | README header only |
| 2 | MCP Registry CLI Demo | `https://github.com/user-attachments/assets/98200866-e8bd-4ac3-bad6-c6d42b261dbe` | GitHub | README header only |
| 3 | Full End-to-End Functionality | `https://github.com/user-attachments/assets/5ffd8e81-8885-4412-a4d4-3339bbdba4fb` | GitHub | README header; `docs/index.md` Demo Videos table; `release-notes/v1.0.3.md` |
| 4 | OAuth 3-Legged Authentication | `https://github.com/user-attachments/assets/3c3a570b-29e6-4dd3-b213-4175884396cc` | GitHub | README header; `docs/index.md`; `release-notes/v1.0.3.md` |
| 5 | Dynamic Tool Discovery and Invocation (README version) | `https://github.com/user-attachments/assets/cee25b31-61e4-4089-918c-c3757f84518c` | GitHub | README header; `docs/index.md`; `release-notes/v1.0.3.md` |
| 6 | Dynamic Tool Discovery - agent integration walkthrough | `https://github.com/user-attachments/assets/cee1847d-ecc1-406b-a83e-ebc80768430d` | GitHub | `docs/dynamic-tool-discovery.md` (embedded twice: Agent Integration section and Demo section) |
| 7 | Agent Skills in action | `https://github.com/user-attachments/assets/5d1f227a-25f8-480d-9ff9-acba2498844b` | GitHub | README header; `docs/agent-skills-operational-guide.md` |
| 8 | Virtual MCP Servers demo | `https://app.vidcast.io/share/954e6296-f217-4559-8d86-88cec25af763` | Vidcast | README header; `docs/virtual-server-operations.md` (badge + plain link, same URL) |
| 9 | MCP Servers, Agents and Skills Registry overview (bare link in README, no title) | `https://github.com/user-attachments/assets/97c640db-f78b-4a6c-9662-894f975f66e2` | GitHub | README "MCP Servers, Agents and Skills Registry" section only |
| 10 | Security Scanning demo | `https://github.com/user-attachments/assets/9450f027-ef7f-4ed7-a55c-ce970bf26fd8` | GitHub | `docs/security-scanner.md` only |
| 11 | ANS Integration Walkthrough | `https://app.vidcast.io/share/c2240a78-8899-46ad-9375-6fb0cc1345f3?playerMode=vidcast` | Vidcast | README ANS feature bullet; `docs/design/ans-integration.md` |
| 12 | AWS Agent Registry Federation demo | `https://app.vidcast.io/share/6d2e0a43-4a68-477e-b5b9-2b3e2aa59f83?playerMode=vidcast` | Vidcast | `docs/aws-agent-registry-federation.md` only |
| 13 | Peer-to-Peer Federation demo | `https://github.com/user-attachments/assets/630ce847-b151-4eaa-9cc9-2ec77797f2b5` | GitHub | `docs/federation-operational-guide.md` only |

### Review-Driven Revisions (Step 7.5 feedback loop)

The expert review (`review.md`) raised two must-fix and four should-fix items; the design below incorporates all of them:

1. **Mechanical URL-fidelity check (must fix).** Opaque UUID URLs cannot be proofread. After writing the page, run a literal fixed-string grep (`grep -F`) for each of the 13 URLs in `docs/demo-videos.md`; every hit must be exact, and each URL must still match its source file(s). See *Testing Strategy*.
2. **Completeness re-scan at implementation time (must fix).** Re-run the inventory scan after the page is written and confirm set equality: URLs found in repo markdown minus URLs in the new page = empty set. See *Testing Strategy*.
3. **Page content constraints (should fix).** Quick Index table stays at 3 columns (Video | Platform | Feature Area); the bare-URL README video title is explicitly marked "(title inferred)"; section headings are plain text (no emoji).
4. **Maintenance note (should fix).** The page ends with a note naming the exact mkdocs nav follow-up (`- Demo Videos: demo-videos.md` under an appropriate nav section) and the broken `docs/index.md:266` `#demo-videos` anchor, and states the page was last verified against v1.24.3.
5. **Scan regex footnote (should fix).** The page includes the grep pattern used to build the inventory so the next author can regenerate it.
6. **Surgical README edit (should fix).** The README change is limited to inserting `📺 [All Demo Videos](docs/demo-videos.md)` as the first link on the existing line 14; no other byte of that line may change (it carries 7 existing URLs).

### Step-by-Step Plan (for a future implementer)

#### Step 1: Create the index page
**File:** `docs/demo-videos.md` (new file)

Structure and content:

```markdown
# Demo Videos

One paragraph: this page indexes every demo video in the repository in one
place; videos are grouped by feature area; each entry says what the video
shows and where else it is linked; note it was last verified against v1.24.3.

## Quick Index

| Video | Platform | Feature Area |
|-------|----------|--------------|
(rows for all 13 videos, linking the title to the URL, matching inventory above)

## Platform Overviews & Getting Started

### AWS Show & Tell presentation
What it shows (1-2 lines from README context).
Watch: [YouTube](URL)
Also referenced in: [README](../../README.md)

### Full End-to-End Functionality Walkthrough
...
(repeat per video, 4 in this section: #1, #2, #3, #9)

## Authentication & Security
(#4 OAuth 3-Legged Authentication, #10 Security Scanning)

## Dynamic Tool Discovery
(#5 README/index version; #6 agent integration walkthrough - explicitly note
 these are two different recordings)

## Agent Skills & Virtual MCP Servers
(#7 Agent Skills, #8 Virtual MCP Servers)

## Federation & Integrations
(#11 ANS Integration Walkthrough, #12 AWS Agent Registry Federation,
 #13 Peer-to-Peer Federation)

## Related Resources

- Slide deck: docs/slides/mcp-gateway-registry-presentation.pdf (linked from
  the README header, not a video)
- Animated GIF demos referenced from docs pages (not videos, not indexed):
  docs/img/MCP_tools.gif, docs/img/dynamic-tool-discovery-demo.gif,
  docs/img/iam.gif, docs/img/auth-scheme.gif, docs/img/mcp-server-versioning.gif
- The three original launch videos also appear in release-notes/v1.0.3.md.
```

Each per-video entry MUST carry: a heading title, a one-line "what it shows"
derived from the surrounding documentation text of its source page, the
`Watch:` link with the exact URL, and an `Also referenced in:` line. Relative
links back into the repo must work from `docs/` (use `../README.md` for
README, plain filenames for sibling docs pages, `design/ans-integration.md`
for the design doc, `../release-notes/v1.0.3.md` for release notes).

Additional page constraints (from expert review):

- Quick Index table is exactly 3 columns: `| Video | Platform | Feature Area |`.
- Video #9's heading is "MCP Servers, Agents and Skills Registry (title inferred)"
  because the source is a bare URL with no link text.
- Section headings are plain text; no emoji anywhere in this file.
- The page closes with a "Maintenance" note containing: the scan regex footnote
  (so the inventory can be regenerated), the instruction to add one row + one
  section entry when a new video lands, the mkdocs nav follow-up line
  (`- Demo Videos: demo-videos.md`), the note that `docs/index.md:266` links a
  broken `#demo-videos` anchor, and the sentence "Last verified against v1.24.3."

#### Step 3: Verification gate (must pass before capture)

Run both mechanical checks from *Testing Strategy* against the clone:

1. **Fidelity:** for each of the 13 inventory URLs, `grep -cF '<url>' docs/demo-videos.md`
   must be >= 1 and the URL text must equal the source-file occurrence byte-for-byte.
2. **Completeness:** re-run the inventory scan over repo markdown excluding the new
   page; every returned URL must be one of the 13 (set equality).

If either check fails, fix the page and re-run before writing `patch.diff`.

#### Step 2: Add the README link
**File:** `README.md`
**Lines:** 14 (the "Demo Videos:" line inside the centered header block)

Insert the index as the first link on that line, directly after the
"Demo Videos:" label, so it is the most prominent video link on the page:

```markdown
**Demo Videos:** 📺 [All Demo Videos](docs/demo-videos.md) | 🎥 [AWS Show & Tell](https://www.youtube.com/watch?v=dk0qVukHLGU) | ⭐ [MCP Registry CLI Demo](...) | ... (rest of line unchanged)
```

Nothing else in the README changes. In particular, do not restructure the
line, do not remove existing links, and do not touch the bare URL at line 108
(it stays; the index gives it a title).

### Error Handling
Not applicable (documentation-only). The completeness safeguard is the grep-based inventory: any future video URL pattern that does not match the three hosts above would be missed by the scan, so the page includes a maintenance note telling future authors to update the index when adding a demo video.

### Logging
Not applicable.

## Observability

Not applicable - no runtime component. Success is observable as: the page exists, the README links to it, and a grep over the repo for video URLs returns no URL that is absent from the page.

## Scaling Considerations

- The page is static markdown; it scales trivially.
- Growth path: when a new demo video is added anywhere in the repo, append one row to the Quick Index and one section entry. The grouping keeps the page navigable well past 13 videos.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `docs/demo-videos.md` | Complete, grouped index of all 13 demo videos with descriptions, platforms, and cross-references |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `README.md` | 14 | Add `📺 [All Demo Videos](docs/demo-videos.md)` as the first link on the header "Demo Videos:" line |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (markdown) | ~130 |
| New tests | 0 (documentation-only change) |
| Modified code (markdown) | ~1 |
| **Total** | **~131** |

## Testing Strategy

See `testing.md` for the full plan. Because the change is markdown-only, verification is mechanical and grep-based; two checks are the acceptance gate (must pass before `patch.diff` is captured):

1. **URL fidelity:** for each of the 13 inventory URLs, a literal fixed-string search (`grep -F`) finds the URL in `docs/demo-videos.md`, byte-identical to its occurrence in the source markdown (opaque UUIDs cannot be proofread by eye; this check catches any transcription error).
2. **Completeness (set equality):** re-running the inventory scan over all repo markdown (excluding the new page itself) yields no URL that is absent from `docs/demo-videos.md`.

Supplementary manual checks: relative links from the page resolve (`../README.md`, sibling filenames, `design/ans-integration.md`), and the page renders correctly on GitHub.

## Alternatives Considered

### Alternative 1: Consolidate all video links into the index and delete them from source pages
**Description:** Make `docs/demo-videos.md` the only place videos are linked.
**Pros / Cons:** Single source of truth vs. breaks in-page context and invalidates deep links people may have saved.
**Why Rejected:** The task asks for an index plus a README link, not a deduplication refactor; keeping source links preserves behavior.

### Alternative 2: Add the videos to the README Documentation table instead of a new page
**Description:** Extend the README's Documentation section with a demo-video column.
**Pros / Cons:** No new file vs. makes the README even longer (it is already ~1000 lines) and does not help readers inside the docs tree.
**Why Rejected:** The task explicitly calls for a single `docs/demo-videos.md`.

### Alternative 3: Also add the page to `mkdocs.yml` nav
**Description:** One-line nav entry so the page shows in the rendered docs site.
**Pros / Cons:** Better docs-site discoverability vs. the task constrains the change to Markdown only, and `mkdocs.yml` is build configuration.
**Why Rejected:** Out of scope for this change; recorded as a follow-up.

### Comparison Matrix

| Criteria | Chosen (new page + README link) | Alt 1 (consolidate) | Alt 2 (README table) |
|----------|--------------------------------|---------------------|----------------------|
| Diff size | Small | Large | Small |
| Preserves existing links | Yes | No | Yes |
| Discoverability gain | High | High | Medium |
| Matches task statement | Yes | No | No |

## Rollout Plan
- Phase 1: Implementation (this change; markdown-only, lands via normal PR)
- Phase 2: Verification per `testing.md` (grep completeness, link check, GitHub render check)
- Phase 3: Follow-ups (mkdocs nav entry, broken `#demo-videos` anchor fix) tracked separately

## Open Questions
- None blocking. Optional follow-ups: mkdocs nav entry; fixing the `docs/index.md:266` anchor.

## References
- Issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1190
- Existing partial index pattern: `docs/index.md` ("Demo Videos" table)
- README header link list: `README.md` line 14
