# Implementation Summary: macos-setup Phase 1 Python Version Precheck

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## What Changed

The macos-setup skill's Phase 1 Python check no longer passes any `python3` found on PATH. After a presence probe (unchanged behavior when the interpreter is missing), the check reads the project's minimum from metadata - `requires-python` in `pyproject.toml`, looked up in the current directory and then in `${INSTALL_DIR}` - falling back to the documented minimum (`>=3.14`) only when no metadata file is reachable (the skill's remote, pre-clone invocation mode). It compares the running interpreter against the requirement with numeric zero-padded tuple comparison, emits `PYTHON_OK` on pass, `PYTHON_VERSION_FAIL` with a detail line (running version, requirement text, source) when the interpreter is too old, and `PYTHON_FAIL` with a reason when the requirement itself cannot be evaluated (fail closed). The remediation table gained a `PYTHON_VERSION_FAIL` row and the do-not-proceed gate now includes the version minimum, so an unsupported interpreter stops setup at Phase 1 instead of surfacing four phases later as a `uv sync` error.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `.claude/skills/macos-setup/SKILL.md` | modified | +97 / -2 | Phase 1 check block replaced (lines 129-224); `PYTHON_VERSION_FAIL` row added to remediation table (line 248); do-not-proceed gate extended (line 255) |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry.git repo && cd repo
git apply /path/to/patch.diff
```

## Deviations from the LLD

None of substance. The implemented check block follows the LLD's Step 1 snippet (metadata lookup order, rc contract 0/1/2, quoted `PYEOF` heredoc, `fail2` helper, outer fail-closed except, `INSTALL_DIR` passed inline); only comment wording differs slightly from the design snippet. The remediation row and gate sentence match LLD Steps 2 and 3 verbatim.

## Not Implemented / Follow-ups

None. All three LLD file changes are in the patch; Phase 5 and other probes were intentionally left untouched per the LLD's non-goals.

## Verification (not executed)

- `git apply --check` passed on the clone after resetting to the baseline commit, so the patch applies cleanly onto a fresh `1.27.1` checkout.
- Tests were designed but not run, per skill constraints (no execution of the target project). The full verification procedure - fixture-driven check-block tests, backwards-compat checks, UX and rollback checks - lives in `./testing.md`.
