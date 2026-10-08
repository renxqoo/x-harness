# GitHub Issue: macos-setup Phase 1 must enforce the project's minimum Python version

## Title
macos-setup skill: Phase 1 prerequisite check accepts any python3, deferring version failures to the uv sync step

## Labels
- bug
- developer-experience
- setup

## Description

### Problem Statement
The macos-setup skill's Phase 1 prerequisite check only verifies that `python3` exists on PATH (`python3 --version 2>/dev/null && echo "PYTHON_OK" || echo "PYTHON_FAIL"`). The project itself requires a newer minimum, declared in `pyproject.toml` as `requires-python = ">=3.14"`. On a machine whose default `python3` is older (for example the macOS system interpreter 3.9, or an outdated Homebrew install), Phase 1 reports `PYTHON_OK` and setup continues through clone, credentials, and `.env` phases before failing at Phase 5 (`uv sync`) with an error that blames uv rather than the unmet prerequisite. The user has no reason to connect that late failure to their Python interpreter, which turns a 10-second prerequisite fix into a debugging session.

### Proposed Solution
Tighten the Phase 1 Python check so it:
1. Still reports `PYTHON_FAIL` when `python3` is absent (unchanged behavior).
2. When `python3` exists, reads the minimum requirement from the project's own metadata (`requires-python` in `pyproject.toml`, looked up in the current directory and in `INSTALL_DIR`) instead of hard-coding a guessed version, falling back to the documented minimum (`>=3.14`, which matches `docs/macos-setup-guide.md`) only when metadata is unreachable, such as when the skill runs remotely before Phase 2 clones the repo.
3. Compares the running interpreter against that requirement using numeric (not string) version comparison, and prints a `PYTHON_VERSION_FAIL` line naming both the running version and the exact requirement and its source when the interpreter is below it.
4. Fails closed: if the requirement cannot be evaluated (malformed metadata, unsupported specifier), it prints `PYTHON_FAIL` with the reason rather than waving the interpreter through.
5. Keeps the existing remediation guidance reachable: the install-instruction table gains a `PYTHON_VERSION_FAIL` row pointing at `brew install python@3.14`, and the do-not-proceed rule is extended to cover the version minimum.

### User Stories
- As a developer setting up the registry on macOS, I want Phase 1 to fail fast when my `python3` is below the project's minimum so that I fix the actual prerequisite instead of debugging `uv sync` four phases later.
- As a skill maintainer, I want the required version read from `pyproject.toml` so that bumping the project's minimum automatically updates the setup check without a second place to edit.
- As a contributor running the skill from its GitHub URL on a fresh machine, I want a sensible documented fallback so the check still works before the repository is cloned.

### Acceptance Criteria
- [ ] With a compliant interpreter (>= the `requires-python` version), Phase 1 prints `PYTHON_OK` and setup proceeds exactly as before.
- [ ] With an interpreter below the requirement, Phase 1 prints `PYTHON_VERSION_FAIL` and the message names the running version, the required specifier, and that it came from `pyproject.toml`.
- [ ] The requirement is read from `pyproject.toml` (`requires-python`), not hard-coded in the check logic; the hard-coded value exists only as a documented fallback used when metadata is unreachable, and the message says which source was used.
- [ ] When metadata is unreachable (remote, pre-clone invocation), the check still enforces the documented minimum and says so in its message.
- [ ] `PYTHON_FAIL` (interpreter missing) behavior and remediation are unchanged.
- [ ] The remediation table covers both `PYTHON_FAIL` and `PYTHON_VERSION_FAIL` with the existing `brew install python@3.14` guidance.
- [ ] The do-not-proceed rule for Phase 1 explicitly includes the version minimum, so setup does not continue past Phase 1 with an unsupported interpreter.
- [ ] Comparison is numeric: 3.9 vs 3.14 style boundaries evaluate correctly (3.14 > 3.9, 3.15 >= 3.14, 3.13 < 3.14).

### Out of Scope
- Any change to Phase 5 (`uv sync`) behavior or retry logic; the fix is early detection at Phase 1.
- Linux or Windows setup skills and the docs guide's prose (it already states "Version 3.14+").
- CI, Dockerfiles, and runtime version enforcement (uv already enforces `requires-python` at sync time).
- Supporting exotic PEP 508 markers beyond simple comma-separated comparator clauses (`>=`, `<=`, `==`, `!=`, `>`, `<`).

### Dependencies
- None. The change is confined to the skill's Phase 1 instructions and uses tools the phase already relies on (`python3`, shell built-ins).

### Related Issues
- #1568
