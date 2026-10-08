# Expert Review: Portable .env secret generation in build_and_run.sh

*Created: 2026-09-30*
*Reviewed artifacts: `./github-issue.md`, `./lld.md`*

| Role | Reviewer | Focus |
|------|----------|-------|
| Frontend Engineer | Pixel | CLI output, error messages, developer experience |
| Backend Engineer | Byte | Script correctness, shell semantics, edge cases |
| SRE/DevOps Engineer | Circuit | Deployment, CI, rollback, environment differences |
| Security Engineer | Cipher | Secret handling, file permissions, failure modes |
| SMTS (Overall) | Sage | Architecture, maintainability, scope discipline |

---

## Pixel (Frontend Engineer - developer experience)

**Strengths**
- Keeps all existing `log` output on the happy path, so CI logs on Linux stay byte-identical; nobody's dashboard or muscle memory breaks.
- Failure message includes the offending regex pattern, which is the single most useful thing when a rewrite misfires.

**Concerns**
- (should-fix, UX) The error strings say "Failed to filter .env" / "Failed to update .env" but never mention *why* the old code failed silently. One clause naming the macOS `sed -i` portability would help the next maintainer who greps the logs. Minor.
- (nice-to-have) `handle_error` exits before any hint that re-running the script is safe. A short "re-run this script to regenerate" line would reduce support load. Optional.

**New libraries / infra dependencies**
- None. Correct for a bootstrap script.

**Better alternatives considered**
- Print a per-secret warning when the helper actually filters zero lines vs. some lines. Rejected: more log noise for a case that previously "worked" by accident; silence-on-success is the right default.

**Recommendations**
- Include the portability rationale in the error text (one line).

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (one cosmetic should-fix)

---

## Byte (Backend Engineer - shell correctness)

**Strengths**
- The `grep -E -v` + `mktemp` sibling + `mv` rewrite is genuinely portable: no GNU-only `sed -i`, no perl, no OS sniffing. Works on bash 3.2 (macOS).
- Correctly models `grep` exit semantics: 1 = "filtered everything" is a valid outcome, >= 2 aborts. Most naive ports get this wrong and either die on `set -e` or swallow real errors.
- `--` before the pattern, `-E` for the alternation collapsing the two historical `sed` calls: both right.
- Guarding `mktemp` failure and `mv` failure with temp cleanup (`rm -f`) on every error path prevents partial-file litter next to `.env`.

**Concerns**
- (must-fix, correctness) The loop call `remove_env_lines "^${ENV_VAR_NAME}="` is anchored only at the start. The old `sed` pattern `"/^$ENV_VAR_NAME=/d"` had the same anchoring, so behavior is preserved, but note the prefix-collision consequence: `METRICS_API_KEY_AUTH_SERVER=` also matches (and deletes) a hypothetical line `METRICS_API_KEY_AUTH_SERVER_EXTRA=...`. This is a *pre-existing* property faithfully ported, not a regression - acceptable for this patch; worth a comment in the LLD rather than a code change. -> LLD updated with a note.
- (should-fix) The helper hardcodes the filename `.env`. The script always runs from the repo root (enforced by the `.env` existence check), so this is fine, but a comment stating the assumption should be added to the helper so nobody "generalizes" it later without noticing. -> Addressed in helper comment.
- (nice-to-have) `local tmp_file grep_rc=0` re-initializes `grep_rc` on every call; correct as written.
- (verified) `grep -E` on macOS BSD grep supports `|` alternation and `--`; `-E` is POSIX. `mktemp .env.XXXXXX` with a trailing template is supported on BSD mktemp. No compatibility gap found.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- `awk`-based rewrite (single pass, also portable). Rejected: awk's in-script programming makes the failure modes harder to reason about than grep's exit codes; no functional gain.
- `sed 'expr' .env > tmp` (no `-i` at all). Equally portable; grep -v is the clearer statement of intent ("drop matching lines"). Either is defensible; grep chosen.

**Recommendations**
- Add the prefix-collision note and the hardcoded-`.env` assumption comment (both cheap, both done in the revised LLD).

**Questions for author**
- None blocking.

**Verdict:** APPROVED WITH CHANGES (documentation-grade; code as designed is correct)

---

## Circuit (SRE/DevOps Engineer)

**Strengths**
- Loud failure is the right call: a bootstrap script that half-succeeds is the worst possible failure mode in dev onboarding. Exit 1 with a clear message beats "auth-server crash-loops 3 minutes later" by a mile.
- No CI log changes on GNU userlands - zero-blast-radius for existing automation that parses script output.
- Atomicity reasoning is correct: sibling `mktemp` + `mv` rename keeps the rewrite same-filesystem and atomic-ish; a crash mid-write leaves the old `.env` intact.

**Concerns**
- (should-fix, ops) File mode change: `.env` goes from `0644` to `0600` after the first `mv`. For a file full of secrets this is a security *improvement*, but operators with multi-user dev boxes or bind-mounted compose setups relying on world-readable `.env` would see a behavior change. Must be documented in the LLD (it is) and in testing.md as an explicit check (added). Accept.
- (nice-to-have) If `.env` were a symlink, `mv` would replace the symlink rather than the target. The repo ships `.env` as a real file and the script errors if it's missing; symlinked `.env` is not a supported setup. Document, don't engineer around.
- (verified) No deployment surface changes: no compose/Terraform/Helm values touched. Section 4 of the testing plan will be "Not Applicable" - correct.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- A `trap` for temp cleanup on unexpected signals. Rejected: `set -e` plus explicit `rm -f` on each error path already covers the realistic cases; a global trap adds bookkeeping to a 757-line script for marginal benefit.

**Recommendations**
- Document the mode change and symlink caveat in the LLD (done: Constraints section).

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (documentation already updated)

---

## Cipher (Security Engineer)

**Strengths**
- This fix is security-positive twice over: it makes secret generation actually work on macOS (no more empty SECRET_KEY / OPENBAO_TOKEN / MARKER_SECRET in the effective config), and it removes `2>/dev/null || true` - silencing failures around secret material is an anti-pattern.
- Removing `sed -i.bak`-style approaches (Alternative 2) avoids leaving plaintext secret copies in `.env.bak`; the chosen design never duplicates the file.
- `mktemp` with `XXXXXX` gives a securely-created (0600) temp file; the file briefly holds the secret-bearing `.env` content, and `rm -f` on failure paths prevents residue. Temp filename collision is not a concern (mktemp guarantees O_EXCL).

**Concerns**
- (should-fix) Temp file contains secrets and lives in the repo working directory during the rewrite window. On a workstation this is equivalent to `.env` itself (0600 either way). Acceptable; the LLD should state the exposure window explicitly. -> Noted in LLD constraints.
- (must-fix, disclosure) The rewrite is not atomic against a *reader* that opens `.env` between generation calls... but this was equally true of the old append-only flow (append via `>>` is a separate write anyway). No regression. No action beyond awareness.
- (nice-to-have) Could `shred`/`rm -P` the temp file on error paths? Overkill for a dev script; plain `rm -f` matches repo norms (and BSD `rm -P` is non-portable to common Linux builds).

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Generate secrets via a temp *staging* file and single final `mv` (batch all five secrets into one rewrite). Rejected for this patch: larger diff, reorders log output, and the five sequential rewrites are each atomic already.

**Recommendations**
- Keep the `2>/dev/null` removal total - do not let any new call site reintroduce it.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES (exposure-window note added to LLD)

---

## Sage (SMTS - overall)

**Strengths**
- Correct root-cause analysis: GNU-only `sed -i` + silenced failure + first-assignment-wins consumer = empty secrets on macOS. The fix removes the dependency on `sed -i` semantics rather than detecting the environment - the only robust shape for this fix.
- Scope discipline is right: one file, one helper, all 6 call sites (11 sed invocations), other `sed -i` users explicitly ruled out of scope with reasons (Linux containers, already-suffixed). "Fix the pattern everywhere it appears" is satisfied *within the named script* without a drive-by audit.
- The review loop was exercised: Byte's prefix-collision observation, Circuit's mode-change note, Cipher's exposure-window note, and Pixel's error-message tweak are folded into the revised LLD rather than deferred to memory.

**Concerns**
- (should-fix, process) The helper is defined but never unit-tested by the repo (no shell test harness exists for `build_and_run.sh`). testing.md compensates with manual GNU/BSD checks. Acceptable for this repo's conventions; flagged as known limitation.
- (nice-to-have) A future refactor could route *all* `.env` writes (including the appends) through one "set_env_value" helper. Rightly out of scope - this patch is a portability fix, not a rewrite.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- OS-detecting `sed -i ''` wrapper: rejected (see LLD Alternatives) - environment sniffing is the bug class we are removing.

**Recommendations**
- Land as-is with the revised LLD; file the repo-wide `sed -i` audit follow-up issue.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

---

## Review Summary

| Reviewer | Verdict | Blockers (must-fix) | Key Recommendations |
|----------|---------|---------------------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 0 | Name the macOS portability reason in the error text |
| Backend (Byte) | APPROVED WITH CHANGES | 0 | Note prefix-collision heritage + hardcoded `.env` assumption in helper comments/LLD |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 | Document the `.env` mode change (0644 -> 0600) and symlink caveat |
| Security (Cipher) | APPROVED WITH CHANGES | 0 | State the temp-file secret exposure window; keep `2>/dev/null` ban total |
| SMTS (Sage) | APPROVED WITH CHANGES | 0 | Land with revised LLD; file repo-wide `sed -i` audit follow-up |

No reviewer raised a critical/must-fix blocker against the design as specified. All should-fix items are addressed by revising the LLD (helper comments naming the `.env` assumption and the portability rationale; Constraints section extended with the mode change, symlink caveat, and temp-file exposure window; a note that the loop's prefix-anchored pattern is faithfully inherited from the original sed). Error-text wording updated in the LLD's helper to mention portability. **No blocking findings; proceeding to implementation** with the LLD as revised.

## Next Steps
1. Implement per revised `lld.md` (Step 8.5).
2. Execute `testing.md` manually on macOS + Linux when running the project (out of scope for this skill run).
3. Follow-up issue: repo-wide `sed -i` portability audit (`keycloak/setup/clean-keycloak.sh` first).
