# GitHub Issue: Create a single demo video index page

## Title
Create `docs/demo-videos.md`: a single, complete index of every demo video, linked from the README

## Labels
- documentation
- good first issue
- developer-experience

## Description

### Problem Statement
Demo videos for the MCP Gateway & Registry are scattered across the README and roughly a dozen individual files under `docs/`. They live on three different hosts (YouTube, GitHub user-attachment recordings, and Vidcast shares), and there is no single place a visitor can look to find them. Concretely, at the time of filing there are **13 unique demo videos** referenced from markdown in the repository:

- The README header links 7 videos in one long line, and embeds an 8th video as a bare URL (no title) in the "MCP Servers, Agents and Skills Registry" section.
- `docs/index.md` repeats 3 of those videos in its own "Demo Videos" table.
- Several videos are only discoverable from a single deep documentation page (`docs/security-scanner.md`, `docs/aws-agent-registry-federation.md`, `docs/federation-operational-guide.md`, `docs/dynamic-tool-discovery.md`).
- There are **two different** Dynamic Tool Discovery videos (one linked from the README and `docs/index.md`, and a different one embedded twice inside `docs/dynamic-tool-discovery.md`), which is easy to conflate when hunting for "the tool discovery demo".
- `docs/index.md` links to a `README#demo-videos` anchor that does not exist (the README renders "Demo Videos" as bold text, not a heading).

A visitor who wants to watch a demo has nowhere single to look, and the same video is sometimes linked from two or three places while others are linked from only one deep page.

### Proposed Solution
A documentation-only change:

1. Create `docs/demo-videos.md` that indexes **every** demo video in the repository in one place, grouped by theme (Platform Overviews, Authentication & Security, Dynamic Tool Discovery, Agent Skills & Virtual MCP Servers, Federation). Each entry carries a title, a one-line description of what it shows, the hosting platform, and a pointer to where else in the repo it is linked. The list must be built by scanning the markdown files for video URLs (YouTube, `github.com/user-attachments`, `app.vidcast.io`), not from memory, so it is complete.
2. Add a prominent link to the new page from the README "Demo Videos" line in the page header.

No code, build system, test, or dependency changes are involved. Existing video links elsewhere are left in place (they still work); the index becomes the canonical complete list.

### User Stories
- As a new visitor evaluating the project, I want one page listing all demo videos so that I can see the platform in action without reading the whole README and a dozen docs pages.
- As an existing user, I want to find the walkthrough for a specific feature (e.g. security scanning, federation, virtual servers) so that I can watch exactly the video I need.
- As a documentation maintainer, I want a canonical video index so that adding a new demo video means adding one row, and readers stop relying on whichever deep page they happened to land on.

### Acceptance Criteria
- [ ] `docs/demo-videos.md` exists and lists every demo video URL found in the repository's markdown files (13 at the time of writing), with zero omissions and no invented entries.
- [ ] Each video URL in the index is byte-identical to the URL as it appears in the source markdown (including query strings such as `?playerMode=vidcast`).
- [ ] Videos are grouped so a reader can find the one they want by feature area, and each entry states what the video shows and where else it is linked from.
- [ ] The two distinct Dynamic Tool Discovery videos are listed as separate entries and are clearly distinguishable.
- [ ] The README links prominently to `docs/demo-videos.md` (the header "Demo Videos" line).
- [ ] The change touches only markdown files: no code, build config, tests, or dependencies are modified.

### Out of Scope
- Removing or consolidating the existing per-page video links (they still work; deduplication is a separate cleanup).
- Fixing the broken `README#demo-videos` anchor link in `docs/index.md` (separate issue).
- Indexing GIF animations (`docs/img/*.gif`) and the slide deck PDF; they are not videos, though the page may point to the slide deck as a related resource.
- Transcribing video contents or adding durations; descriptions come from the surrounding documentation text.

### Dependencies
- None.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1190
