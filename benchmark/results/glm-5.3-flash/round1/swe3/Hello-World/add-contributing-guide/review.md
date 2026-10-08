# Expert Review: Add CONTRIBUTING.md Contributor Guide

*Created: 2026-09-26*
*Reviewed artifacts: `github-issue.md`, `lld.md` (draft)*

## Review Summary Table

| Role | Reviewer | Verdict | Blocking Findings |
|------|----------|---------|-------------------|
| Frontend Engineer | Pixel | APPROVED WITH CHANGES | 1 should-fix (copy-pasteable commands) |
| Backend Engineer | Byte | APPROVED WITH CHANGES | 1 should-fix (contribution requirements must not reference nonexistent tests/CI) |
| SRE/DevOps Engineer | Circuit | APPROVED | 0 |
| Security Engineer | Cipher | APPROVED WITH CHANGES | 1 should-fix (advise against posting secrets in public issues) |
| SMTS (Overall) | Sage | APPROVED WITH CHANGES | 1 should-fix (require issue linking in PRs, tighten scope statement) |

---

## Frontend Engineer (Pixel)

Focus: document structure, readability, rendering on GitHub.

**Strengths**
- The document outline is logical and mirrors the three acceptance criteria in order; a reader can scan headings and find their path (issue vs PR) in seconds.
- Keeping the guide under roughly 60 lines is the right call; long contributing guides go unread.
- Root placement means GitHub auto-links the file from the new-issue page, which is where readers actually need it.

**Concerns**
- (should-fix) The LLD says "copy-pasteable commands" but does not pin the format. Commands written with a `$` prompt prefix or inline comments cannot be pasted directly into a terminal. The design must state: fenced code blocks, `bash` language tag, one command per line, no prompt characters, no inline comments on command lines.
- (minor) The fork/clone commands should use a `<username>` placeholder consistently so readers know to substitute their own GitHub handle.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- None. Root `CONTRIBUTING.md` beats a README section for scannability and platform integration.

**Recommendations**
- Adopt the fenced `bash` block format rule in the LLD's implementation details.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

---

## Backend Engineer (Byte)

Focus: content correctness of the described workflows, factual accuracy of instructions.

**Strengths**
- The pull-request flow (fork, branch, commit, push, open against `master`) matches how this repository is actually hosted: single branch `master`, no protected branches or review rules visible.
- Correctly identified that the guide must target `master`, not `main`; the repo's default branch is `master`.
- Scope discipline: additive single file, no existing files touched.

**Concerns**
- (should-fix) The LLD's expectation that contributors follow "the repository's existing style" is fine, but the guide must not instruct contributors to run tests, linters, or a build: this repository has none. Any such instruction would be factually wrong on day one. The expectations section should say plainly that there is no test suite or build system and that reviewers check changes by reading them.
- (minor) "Search existing issues first" is correct; the LLD should also allow that the guide can suggest searching both open and closed issues to avoid duplicates of already-fixed problems.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- Generating the guide from a template (e.g. GitHub's community standards): unnecessary for a one-file change and adds nothing.

**Recommendations**
- State explicitly in the expectations section that no tests/build exist and reading the diff is the review mechanism.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

---

## SRE/DevOps Engineer (Circuit)

Focus: deployment surface, operational impact, rollout.

**Strengths**
- Zero runtime footprint: a static file, no configuration, no environment variables, no deployment surface to wire (confirmed: the LLD's configuration section is correctly empty).
- Rollout plan is honest about what can be verified pre-merge (file presence, grep checks) versus post-merge (GitHub new-issue notice).

**Concerns**
- None blocking. One observation: there is no CI in this repository to enforce anything the guide says, so the guide is advisory by nature. That is acceptable and the design does not pretend otherwise.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- Adding a docs lint CI workflow: out of scope for a documentation-only change and there is no CI to hang it on.

**Recommendations**
- None.

**Questions for author**
- None.

**Verdict:** APPROVED

---

## Security Engineer (Cipher)

Focus: data exposure, safe guidance in a public forum.

**Strengths**
- The change introduces no attack surface: static documentation, no code paths, no dependencies, no configuration.

**Concerns**
- (should-fix) The issue-filing section asks contributors to include "environment details" in a public tracker. Without a caution, users routinely paste tokens, internal hostnames, or credentials into issue reports. The design should include one line advising contributors not to include secrets or sensitive data in issues.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- Private vulnerability reporting instructions: out of scope; this repository has no security policy, and adding one is listed as a follow-up, which is the right call.

**Recommendations**
- Add the "no secrets in issues" line to the Filing an Issue section of the LLD's content requirements.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

---

## SMTS (Sage)

Focus: architecture of the docs, scope, maintainability.

**Strengths**
- The design resists scope creep well: explicit non-goals for templates, license, code of conduct, and tooling.
- The alternatives section engages with the two real placement choices (root vs `.github/`, separate file vs README section) with correct reasoning.

**Concerns**
- (should-fix) The acceptance criteria in the issue and the content requirements in the LLD are aligned, but the LLD does not require that a pull request link the issue it resolves. For a guide whose whole purpose is making contributions reviewable, "link the related issue (`Fixes #<n>`)" should be a hard content requirement in the PR section, not an incidental mention.
- (minor) The guide will define the repository's documentation baseline; the closing "Questions?" section pointing back at the issue tracker is the right lightweight feedback loop.

**New libraries / infra dependencies**
- None required.

**Better alternatives considered**
- None; single-file design is correct at this repository's size.

**Recommendations**
- Elevate issue linking to a required content item in the LLD.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

---

## Blocking Findings and Resolutions (Step 7.5)

Four should-fix findings were raised; per the feedback loop, the LLD was revised before implementation. Resolutions:

1. **Pixel - copy-pasteable command format.** Resolution: the LLD now mandates fenced code blocks tagged `bash`, one command per line, no `$` prompt prefixes, no inline comments on command lines, and a consistent `<username>` placeholder.
2. **Byte - do not reference nonexistent tests/CI.** Resolution: the LLD now requires the expectations section to state explicitly that the repository has no test suite, linter, or build system, and that review is done by reading the change.
3. **Cipher - secrets in public issues.** Resolution: the LLD now requires a caution line telling contributors not to include secrets or sensitive data in issue reports.
4. **Sage - require issue linking in pull requests.** Resolution: the LLD now lists linking the related issue with `Fixes #<n>` as a required content item of the pull-request section, not an optional mention.

No finding required restructuring the design; all four are content-level requirements absorbed into the LLD's Implementation Details. No critical or NEEDS REVISION verdicts were issued. Proceeding to the testing plan and implementation against the revised LLD.
