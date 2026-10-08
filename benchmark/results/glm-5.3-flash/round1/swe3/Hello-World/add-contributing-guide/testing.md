# Testing Plan: Add CONTRIBUTING.md Contributor Guide

*Created: 2026-09-26*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing

The change is a single new static file, `CONTRIBUTING.md`. Testing verifies file presence and location, required content per the issue's acceptance criteria, Markdown renderability, and that no other file was touched. GitHub-surface behavior (the contributing-guidelines notice) can only be verified after the change is merged.

### Prerequisites

- [ ] A checkout of the repository at `master` with the patch applied.
- [ ] `git` and standard shell tools (`grep`, `wc`) available.

### Shared Variables

```bash
REPO=/tmp/swe-clone-add-contributing-guide/Hello-World
```

## 1. Functional Tests

### 1.1 CLI / File-Content Tests

#### 1.1.1 File exists at the repository root

```bash
test -f "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS`.

#### 1.1.2 Required sections are present

```bash
grep -q '^# Contributing to Hello-World' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q '^## Filing an Issue' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q '^## Opening a Pull Request' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q '^## Expectations for Contributions' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS` four times.

#### 1.1.3 Issue guidance contains the tracker URL and duplicate check

```bash
grep -q 'https://github.com/octocat/Hello-World/issues' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -qi 'existing issue' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS` twice.

#### 1.1.4 Pull-request guidance contains the full flow, targets `master`, and requires issue linking

```bash
grep -q 'fork' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q 'git checkout -b' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q 'git commit' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q 'git push' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q 'master' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -q 'Fixes #' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS` six times.

#### 1.1.5 Expectations mention conduct, focused changes, style, and the absence of tests/CI

```bash
grep -qi 'respect' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -qi 'focused' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -qi 'style' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
grep -qi 'no test suite' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS` four times.

#### 1.1.6 Negative case: no secrets-warning omission

```bash
grep -qi 'sensitive' "$REPO/CONTRIBUTING.md" && echo PASS || echo FAIL
```

**Expected:** `PASS` (the public-issue caution from the security review is present).

#### 1.1.7 Document size stays in the short range

```bash
wc -l "$REPO/CONTRIBUTING.md"
```

**Expected:** roughly 45 to 70 lines; more than 120 lines is a failure of the design's brevity goal.

## 2. Backwards Compatibility Tests

**Not Applicable** - the change adds a new file and modifies no endpoint, schema, CLI command, default, or model. There is no prior behavior to preserve; the only pre-existing file, `README`, must remain byte-identical, which test 3.1 verifies as a side effect of the diff scope.

## 3. UX Tests

### 3.1 Diff scope: only CONTRIBUTING.md is added, nothing else changes

```bash
git -C "$REPO" diff --name-status HEAD
```

**Expected output, exactly one line:**

```
A	CONTRIBUTING.md
```

### 3.2 Markdown renderability

Verify by eye (or with a Markdown renderer) that `CONTRIBUTING.md` shows: exactly one top-level heading; heading levels increment without skips; all list items render as lists; the git command blocks render as code with no `$` prompt prefixes or inline comments; the `<username>` placeholder renders as text, not swallowed as HTML.

## 4. Deployment Surface Tests

**Not Applicable** - the change adds no configuration parameter, so there is no Docker, Terraform, ECS, or Helm surface to test. GitHub auto-detects a root `CONTRIBUTING.md` with zero configuration.

## 5. End-to-End Tests

### 5.1 Post-merge GitHub surface (requires the change to be merged upstream)

1. Open `https://github.com/octocat/Hello-World/compare` and start creating a new issue in a fork-derived view, or visit the repository's new-issue page.
2. **Expected:** GitHub displays a contributing-guidelines notice linking `CONTRIBUTING.md`.

### 5.2 Contributor walkthrough (dry run of the documented flow)

Follow `CONTRIBUTING.md` from top to bottom in a scratch fork: search issues, open a draft issue, fork, clone, branch, commit, push, open a draft pull request against `master` referencing an issue with `Fixes #<n>`. **Expected:** every command in the guide runs as written with only `<username>` substituted.

## 6. Test Execution Checklist

- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/` - **Not Applicable**: documentation-only change; the repository has no test suite
- [ ] Integration tests added under `tests/integration/` - **Not Applicable**: documentation-only change
- [ ] `uv run pytest tests/` passes with no regressions - **Not Applicable**: no test suite exists in this repository

**Note:** per the benchmark's constraints these checks were designed but not executed against the repository; they are the verification recipe for a reviewer.
