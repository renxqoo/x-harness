# Testing Plan: Demo Video Index Page

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
This is a documentation-only change (one new markdown page, one README link edit), so testing is verification of content correctness and link integrity, not execution. The two acceptance gates are mechanical: (1) every one of the 13 inventoried video URLs appears in the new page byte-identical to its source, and (2) a re-scan of repo markdown finds no video URL missing from the page (set equality). The target repo's build, dev servers, and test suites are never run.

### Prerequisites
- [ ] A checkout of the repository at tag `1.24.3` with the patch applied (`git apply patch.diff`)
- [ ] `grep`, `git`, and a browser (for GitHub render checks) available
- [ ] No services, tokens, or fixtures required

### Shared Variables
```bash
REPO=/path/to/checkout           # repo root with the patch applied
PAGE="$REPO/docs/demo-videos.md" # the new index page
SCAN='https://(www\.youtube\.com/watch\?v=[A-Za-z0-9_-]+|app\.vidcast\.io/share/[A-Za-z0-9_-]+(\?playerMode=vidcast)?|github\.com/user-attachments/assets/[A-Za-z0-9-]+)'
```

## 1. Functional Tests (link/content verification)

### 1.1 The index page exists and is linked from the README
```bash
test -s "$PAGE" && echo "PASS: page exists and is non-empty" || echo "FAIL"
grep -n 'docs/demo-videos.md' "$REPO/README.md"
# Expected: exactly one hit, on the "Demo Videos:" header line, as the first link:
#   **Demo Videos:** 📺 [All Demo Videos](docs/demo-videos.md) | 🎥 [AWS Show & Tell](...)
```

### 1.2 URL fidelity: every inventory URL is byte-identical in the page (ACCEPTANCE GATE 1)
Run one literal fixed-string search per URL against the page; every count must be >= 1. Any count of 0 means a transcription error (opaque UUIDs cannot be proofread by eye).
```bash
while read -r u; do
  c=$(grep -cF "$u" "$PAGE")
  [ "$c" -ge 1 ] && echo "OK   ($c) $u" || echo "MISSING  $u"
done <<'EOF'
https://www.youtube.com/watch?v=dk0qVukHLGU
https://github.com/user-attachments/assets/98200866-e8bd-4ac3-bad6-c6d42b261dbe
https://github.com/user-attachments/assets/5ffd8e81-8885-4412-a4d4-3339bbdba4fb
https://github.com/user-attachments/assets/3c3a570b-29e6-4dd3-b213-4175884396cc
https://github.com/user-attachments/assets/cee25b31-61e4-4089-918c-c3757f84518c
https://github.com/user-attachments/assets/cee1847d-ecc1-406b-a83e-ebc80768430d
https://github.com/user-attachments/assets/5d1f227a-25f8-480d-9ff9-acba2498844b
https://app.vidcast.io/share/954e6296-f217-4559-8d86-88cec25af763
https://github.com/user-attachments/assets/97c640db-f78b-4a6c-9662-894f975f66e2
https://github.com/user-attachments/assets/9450f027-ef7f-4ed7-a55c-ce970bf26fd8
https://app.vidcast.io/share/c2240a78-8899-46ad-9375-6fb0cc1345f3?playerMode=vidcast
https://app.vidcast.io/share/6d2e0a43-4a68-477e-b5b9-2b3e2aa59f83?playerMode=vidcast
https://github.com/user-attachments/assets/630ce847-b151-4eaa-9cc9-2ec77797f2b5
EOF
# Expected: 13 lines of "OK", 0 lines of "MISSING"
```

### 1.3 Completeness: no repo video URL is absent from the page (ACCEPTANCE GATE 2)
```bash
cd "$REPO"
grep -rEoh "$SCAN" --include='*.md' . | sort -u > /tmp/repo-urls.txt
grep -rEoh "$SCAN" "$PAGE"          | sort -u > /tmp/page-urls.txt
# URLs in repo markdown but not in the page (must be empty):
comm -23 /tmp/repo-urls.txt /tmp/page-urls.txt
# Expected: no output. If non-empty, the page is incomplete.
# Note: URLs only in the page but not in repo markdown would indicate an invented
# entry: comm -13 /tmp/repo-urls.txt /tmp/page-urls.txt  (must also be empty)
```

### 1.4 Source URLs unchanged
The change must not alter any existing video link elsewhere.
```bash
cd "$REPO"
git diff --name-only HEAD -- '*.md' | grep -v -e '^README.md$' -e '^docs/demo-videos.md$'
# Expected: no output (only README.md modified plus the new page added).
```

### 1.5 README line edit is surgical
```bash
cd "$REPO"
git diff HEAD -- README.md
# Expected: a single hunk on the "Demo Videos:" line; the only inserted text is
# the "All Demo Videos" link; all seven pre-existing links survive unchanged.
```

## 2. Backwards Compatibility Tests
Pre-change entry points keep working: the README header video links, `docs/index.md`'s "Demo Videos" table, and every deep-page video link are untouched (verified in 1.4/1.5). Readers of any existing page see no change.
```bash
cd "$REPO"
git diff HEAD --stat
# Expected: README.md | ~1 +-  and  docs/demo-videos.md | N +  and nothing else.
```
**Result: covered by 1.4/1.5; no separate cases.**

## 3. UX Tests
Manual, on the github.com rendering of the page:
- [ ] The page renders: title, intro paragraph, 13-row quick table, five grouped sections, Related Resources, Maintenance note.
- [ ] Quick table has exactly 3 columns (Video | Platform | Feature Area).
- [ ] Video #9's heading reads "MCP Servers, Agents and Skills Registry (title inferred)".
- [ ] The two Tool Discovery entries are distinguishable (different descriptions, different URLs).
- [ ] Section headings are plain text (no emoji).
- [ ] Relative links resolve from `docs/`: `../README.md` for the README, plain filenames for sibling pages, `design/ans-integration.md` for the design doc.
- [ ] README header shows the new "All Demo Videos" link first on the Demo Videos line; clicking it opens the new page.
**Automated portions:** none (GitHub rendering is not reproducible headlessly here).

## 4. Deployment Surface Tests

### 4.1 Docker wiring
**Not Applicable** - no container, image, or compose changes.

### 4.2 Terraform / ECS wiring
**Not Applicable** - no infrastructure changes.

### 4.3 Helm / EKS wiring
**Not Applicable** - no chart changes.

### 4.4 Deploy and verify
**Not Applicable** - static markdown ships with the repo; there is no deployment step. (Follow-up out of scope: a mkdocs nav entry would make the page appear in the rendered docs site nav.)

### 4.5 Rollback verification
```bash
cd "$REPO" && git apply -R patch.diff && test ! -e docs/demo-videos.md && echo "rollback clean"
# Expected: page removed, README restored to its original line.
```

## 5. End-to-End API Tests
**Not Applicable** - no endpoints, commands, or workflows are added; the change is a documentation page.

## 6. Test Execution Checklist
- [ ] 1.1 page exists; README links it on the header line
- [ ] 1.2 ACCEPTANCE GATE 1: all 13 URLs found byte-identical in the page
- [ ] 1.3 ACCEPTANCE GATE 2: repo-scan minus page = empty set (and reverse direction empty)
- [ ] 1.4 no other markdown file modified
- [ ] 1.5 README diff is the single surgical insertion
- [ ] Section 2 (Backwards Compat) verified via diff inspection
- [ ] Section 3 (UX) rendered-page checks on github.com
- [ ] Section 4 (Deployment) marked Not Applicable (no surfaces changed)
- [ ] Section 5 (E2E) marked Not Applicable (no workflows changed)
- [ ] No unit/integration tests added: the repo has no markdown test suite, and the skill prohibits executing the target repo's tooling
