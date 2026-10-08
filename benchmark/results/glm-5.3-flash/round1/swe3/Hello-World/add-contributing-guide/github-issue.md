# GitHub Issue: Add CONTRIBUTING.md contributor guide

## Title

Add a CONTRIBUTING.md that explains how to file issues, open pull requests, and what contributions should look like

## Labels

- docs
- enhancement
- good first issue

## Description

### Problem Statement

The repository currently contains only a `README` and gives contributors no guidance on how to participate. There is no documented process for filing an issue, no explanation of how to open a pull request, and no statement of the basic expectations a contribution must meet. New and returning contributors have to guess at the process, which produces vague issues, unfocused pull requests, and avoidable back-and-forth during review. A `CONTRIBUTING.md` at the repository root is the standard, GitHub-recognized place for this guidance.

### Proposed Solution

Add a single short `CONTRIBUTING.md` at the repository root that covers, in plain Markdown:

1. How to file an issue: where the issue tracker is, checking for duplicates first, and what details to include.
2. How to open a pull request: the standard fork, branch, commit, push, and pull-request flow against `master`.
3. Basic expectations: respectful conduct, small and focused changes, and following the existing style of the repository.

This is a documentation-only change. No build system, tests, or code are involved, and no existing file is modified.

### User Stories

- As a new contributor, I want one place that explains the contribution process so that I can participate without having to ask maintainers directly.
- As a returning contributor, I want the contribution expectations in writing so that my pull requests arrive in a reviewable shape.
- As a maintainer, I want issues and pull requests to follow a consistent, documented process so that I spend less time asking for missing details.

### Acceptance Criteria

- [ ] A `CONTRIBUTING.md` file exists at the repository root.
- [ ] It explains how to file an issue: the issue tracker location, checking for existing issues first, and what details a useful issue contains.
- [ ] It explains how to open a pull request: fork, create a branch, commit, push, and open the pull request against `master`, linking any related issue.
- [ ] It states basic expectations for a contribution (respectful conduct, small focused changes, existing style).
- [ ] It is written in Markdown and renders correctly on GitHub (heading hierarchy, lists, fenced code blocks).
- [ ] The change touches no files other than the new `CONTRIBUTING.md`.

### Out of Scope

- Any change to `README`, build configuration, CI, or code; there is none involved.
- `CODE_OF_CONDUCT.md`, `LICENSE`, and issue/pull-request templates; these are separate follow-ups if maintainers want them.
- Translated versions of the guide.
- Any enforcement tooling (documentation linters, CI checks).

### Dependencies

- None. The change is a single static Markdown file.

### Related Issues

- None.
