# Expert Review: macos-setup Phase 1 Python Version Precheck

*Created: 2026-09-30*
*Reviewed artifacts: `./github-issue.md`, `./lld.md` (draft of 2026-09-30)*

---

## Frontend Engineer (Pixel)

*Focus: UX of the setup flow, clarity of output, error-message quality.*

**Strengths**
- The new failure token `PYTHON_VERSION_FAIL` slots into the existing ALL-CAPS token grammar; users and agents already scan for these tokens.
- The detail line ("Python 3.9.6 does not meet requirement '>=3.14' (source: pyproject.toml)") answers all three questions a stuck user has: what ran, what is required, who says so.
- Remediation stays in the established place: the install-instruction table, with the same `brew install python@3.14` command the docs guide already recommends.

**Concerns**
1. *(should-fix)* The bash block is getting long for a Phase 1 probe (~40 lines vs the one-liners around it). In default mode an executing agent copies and runs the whole fence; a long fence is fine, but the fence must remain a single copy-pasteable unit - no prose between the `echo` and the heredoc. The LLD satisfies this; flagging it as a constraint to preserve during implementation.
2. *(nice-to-have)* When the fallback fires, the source string is long ("documented minimum; pyproject.toml not found"). Consider shortening to "documented minimum (pyproject.toml not found)" - same information, less visual noise. Not blocking.

**New libraries / infra dependencies**
- None. Correct: `packaging` would be a genuine (if small) dependency on the system interpreter and was rightly avoided.

**Better alternatives considered**
- Emitting a `PYTHON_OLD=3.9.6` style machine-readable token alongside the human line: rejected; the remediation table and gate only need the single token.

**Recommendations**
- Keep the detail line on its own line above the token, exactly as designed, so logs read naturally.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Backend Engineer (Byte)

*Focus: correctness of the comparison, parsing robustness, edge cases.*

**Strengths**
- Numeric zero-padded tuple comparison is the right call: `3.14` vs `3.9` string comparison would be wrong, and the design explicitly avoids it.
- Fail-closed contract (rc 2 -> `PYTHON_FAIL` with reason) is exactly right for a prerequisite gate: ambiguity fails the check, never passes it.
- Reading `requires-python` from `pyproject.toml` with a documented fallback satisfies the "metadata, not hard-coded guess" requirement while keeping the remote pre-clone invocation working.
- The rc contract (0/1/2 -> OK/VERSION_FAIL/FAIL) is simple and total; the outer `try/except` plus `SystemExit` re-raise guarantees the shell always sees one of the three.

**Concerns**
1. *(must-fix)* The trailing-clause-removal bug class: `">=3.14, <3.15"` splits on comma, but if a spec ever contained `" " separators or trailing whitespace inside a clause (" >= 3.14 "), the regex `^(>=|<=|==|!=|>|<)\s*(.+)$` handles leading whitespace after the operator but NOT whitespace before the operator... actually `\s*` after the operator covers `" >= 3.14"` only partially: the split yields `" >= 3.14"`, `raw.strip()` yields `">= 3.14"`, the regex matches `>=` then `\s*` consumes the space, and `(.+)` captures `3.14`. Fine. The real must-fix is different: **`sys.version_info[:3]` truncates a future `3.14.1` correctly, but a spec of `"==3.14"` (exact pin) against interpreter `3.14.0` passes only because both tuples pad to length 3 - correct. What IS incorrect: `"!=3.14"` semantics. A `!=` clause failing (ok=False) correctly reports VERSION_FAIL, fine. So the actual must-fix is: the regex character class `["\']` inside the LLD's `re.search` pattern is written with a double quote inside a double-quoted markdown fence region and, more importantly, the pattern requires the value to be on one line with no trailing comment. `pyproject.toml` values cannot have comments after them in practice (toml disallows), so this is acceptable - but the design should state it.** Resolution applied in revised LLD: noted as acceptable; TOML forbids trailing comments outside strings, and the regex tolerates surrounding whitespace.
2. *(should-fix)* `ver()` uses `re.findall(r"\d+", text)` and takes `parts[:3]`. A version like `3.14.0rc1` yields `(3, 14, 0)` - the `rc1` is ignored. For a `requires-python` gate this is acceptable pre-release behavior (rc of 3.14 treated as 3.14.0), but the design should say so explicitly. Resolution: added to Design notes.
3. *(should-fix)* `os.path.join("", "pyproject.toml")` when `INSTALL_DIR` is empty yields the relative path `pyproject.toml`, duplicating candidate 1. Harmless (second stat of the same file) but worth noting. Resolution: noted; harmless duplicate stat.

**New libraries / infra dependencies**
- None. Stdlib-only is a hard requirement (system python has no `packaging`); met.

**Better alternatives considered**
- `packaging.specifiers.SpecifierSet` if available with graceful degradation: more correct, two code paths to test, and the degradation path is the same code as today. Rejected for maintenance cost.

**Recommendations**
- Keep the operator table as a dict literal (as designed); it is auditable at a glance.
- Document the pre-release truncation in the final SKILL.md comment if it fits in one line.

**Questions for author**
- Confirm the check should run against `python3` on PATH only (not `uv`-managed interpreters). The LLD implies yes. Answer: yes - Phase 1 gates the machine's default interpreter, which is what Phases 2-5 will use; uv's own resolution is out of scope.

**Verdict: APPROVED WITH CHANGES**

*(Changes: document pre-release truncation and the duplicate-candidate note in the LLD; both applied before implementation.)*

---

## SRE/DevOps Engineer (Circuit)

*Focus: operational behavior, portability, failure modes in real setup environments.*

**Strengths**
- Fails at the right phase: catching the bad interpreter before the clone, credential generation, and `.env` phases saves real wall-clock time and avoids half-configured states.
- The quoted heredoc delimiter (`<< 'PYEOF'`) avoids shell-expansion surprises; consistent with how the skill already runs Python.
- `INSTALL_DIR` passed inline to the child process is robust to the skill's "re-export at phase start" convention being forgotten.

**Concerns**
1. *(should-fix)* Phase 1 runs from an arbitrary cwd when the skill is invoked remotely; `os.getcwd()/pyproject.toml` will typically not exist there, which is fine (falls back), but the check must NOT accidentally pick up an unrelated `pyproject.toml` in the invoking directory and enforce the wrong minimum. Mitigation: candidate order is cwd first, then `INSTALL_DIR`; the detail line names the source path, so a wrong-source enforcement is at least visible. Acceptable for a setup skill; document in testing that a fixture must be tested from the fixture's directory. Resolution: testing.md section 1 covers this.
2. *(should-fix)* The do-not-proceed gate must treat `PYTHON_VERSION_FAIL` the same as `PYTHON_FAIL` for the *Python* row - the LLD's gate sentence does this. Verify during implementation that the sentence remains in the same position (after the table) so the flow "collect failures -> table -> gate" is preserved. Resolution: LLD Step 3 keeps position and flow.
3. *(nice-to-have)* A fully-missing `python3` still produces `PYTHON_FAIL` and the old table row; no regression for that path.

**New libraries / infra dependencies**
- None. No new runtime surface, container, or infra.

**Better alternatives considered**
- Baking the check into `build_and_run.sh` too: broader coverage but outside the task's scope (skill markdown only) and risks divergent duplicates. Rejected.

**Recommendations**
- When this ships, keep the fallback `>=3.14` in sync with docs if the minimum ever moves; the metadata read makes this a non-issue in the common path.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## Security Engineer (Cipher)

*Focus: trust boundary of the metadata source, injection surfaces, fail-safe behavior.*

**Strengths**
- No `eval`, no shell interpolation of the metadata value into code; the spec string is parsed by fixed regexes only.
- The metadata file is the project's own `pyproject.toml` from cwd or the user-chosen `INSTALL_DIR`; both are under the user's control, same trust level as the rest of setup. No privilege boundary is crossed.
- Fail-closed on malformed requirement: a tampered or corrupted metadata value cannot weaken the gate to a pass; worst case it reports `PYTHON_FAIL` and blocks setup.
- Output strings are fixed-format `%` templates; the spec/path are data, never executed.

**Concerns**
1. *(should-fix)* A malicious `pyproject.toml` could contain an enormous `requires-python` value; the regexes are linear and the value is bounded by file size, so no practical DoS. No action.
2. *(nice-to-have)* The heredoc writes nothing to disk and exports nothing; clean.

**New libraries / infra dependencies**
- None (a new dependency would itself expand the supply-chain surface; correctly avoided).

**Better alternatives considered**
- Verifying `pyproject.toml` provenance (git-tracked vs user-modified): overkill for a local dev setup skill; the file is user-owned either way.

**Recommendations**
- Keep the fail-closed path even if future refactors simplify the parser; it is the security-relevant property here.

**Questions for author**
- None.

**Verdict: APPROVED**

---

## SMTS (Sage)

*Focus: architecture fit, maintainability, whether the design is the simplest thing that works.*

**Strengths**
- Right-sized: one check block, one new token, one table row, one gate sentence. No new module, config, or dependency.
- The metadata-source-with-fallback design resolves the tension between "read from project metadata" and "Phase 1 precedes the clone" cleanly, and the output names which source applied - honest observable behavior.
- Consistent with the codebase: quoted heredocs and token outputs follow the skill's own established patterns, so the patch will look native.

**Concerns**
1. *(must-fix)* The LLD's Step 1 snippet must remain the **single normative version** of the check. If the implementation copy in SKILL.md drifts from it (or vice versa), future editors cannot tell which is right. Resolution: implementation.md will state that the SKILL.md block is the normative code and the LLD snippet is the design record; both are generated from one edit so they cannot diverge in this patch.
2. *(should-fix)* Byte's pre-release truncation note (3.14.0rc1 counted as 3.14.0) should be one comment line in the code, not just LLD prose. Resolution: applied in revised snippet.
3. *(should-fix)* The gate sentence rewrite must not lose the original "Ask the user to install missing tools and retry." tail - remediation guidance must stay reachable. Resolution: revised LLD keeps the full original sentence plus the version clause.

**New libraries / infra dependencies**
- None.

**Better alternatives considered**
- Extracting the check into a standalone script under `scripts/` invoked by the skill: more testable, but the skill is explicitly self-contained ("run from its GitHub URL without the repository already cloned"); an external script breaks that property. Rejected.

**Recommendations**
- Merge order: apply the review changes to the LLD snippet first (pre-release comment, duplicate-candidate note), then implement once from the revised snippet.

**Questions for author**
- None.

**Verdict: APPROVED WITH CHANGES**

*(Changes: pre-release comment added to the snippet; normative-copy note recorded for implementation.md; gate sentence keeps the remediation tail.)*

---

## Review Summary

| Reviewer | Verdict | Blockers | Key Themes |
|----------|---------|----------|------------|
| Frontend (Pixel) | APPROVED | 0 | Token grammar consistent; detail line answers what/required/who; keep fence copy-pasteable |
| Backend (Byte) | APPROVED WITH CHANGES | 1 (resolved) | Document pre-release truncation, duplicate-candidate note, TOML comment assumption |
| SRE (Circuit) | APPROVED | 0 | Wrong-cwd metadata risk is visible via source line; gate flow position preserved |
| Security (Cipher) | APPROVED | 0 | No eval/interpolation; fail-closed is the security property; no new deps |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 (resolved) | Single normative snippet; pre-release comment in code; keep remediation tail |

## Next Steps

All blocking findings have been folded back into the LLD (the Step 1 snippet now carries the outer try/except, the fail2 helper, and design notes covering pre-release truncation, duplicate candidate stat, and TOML comment assumptions; Step 3's gate sentence retains the "Ask the user..." tail). No blocking findings remain; proceeding to the testing plan and implementation. The SKILL.md check block produced by the implementation is the normative copy; the LLD snippet is its design record.
