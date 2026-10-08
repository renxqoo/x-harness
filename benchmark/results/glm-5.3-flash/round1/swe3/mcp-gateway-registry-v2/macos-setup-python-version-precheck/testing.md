# Testing Plan: macos-setup Phase 1 Python Version Precheck

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
The change modifies the Phase 1 Python probe inside `.claude/skills/macos-setup/SKILL.md`. Because the deliverable is skill markdown (a copy-pasteable bash block), testing extracts that block, runs it in controlled directories (with fixture `pyproject.toml` files and `INSTALL_DIR` values), and asserts on the echoed tokens (`PYTHON_OK`, `PYTHON_VERSION_FAIL`, `PYTHON_FAIL`) and detail lines. The other six Phase 1 probes are verified untouched.

### Prerequisites
- [ ] The repository checked out at the patch's baseline tag (`1.27.1`) with the patch applied.
- [ ] A macOS (or any POSIX) shell with `bash`, `git`, `sed`, and at least one `python3` on PATH.
- [ ] No services required. Nothing from the stack (Docker, Keycloak, uv) needs to run.
- [ ] Optional: a second interpreter (e.g. Homebrew `python3.14` via `brew install python@3.14`) to exercise the pass path with a genuinely new interpreter. Where unavailable, the pass path is exercised via fixture specs instead.

### Shared Variables

```bash
REPO="$(git rev-parse --show-toplevel)"
SKILL="$REPO/.claude/skills/macos-setup/SKILL.md"
WORK="$(mktemp -d /tmp/swe3-pycheck-XXXXXX)"

# Extract the Phase 1 Python check block (from 'echo "=== Python ==="'
# through the 'fi' that closes the presence guard) into a runnable script:
sed -n '/echo "=== Python ==="/,/^fi$/p' "$SKILL" > "$WORK/check.sh"
# (If the sed range grabs too much, extract manually; the block is one
# contiguous if/else inside the Phase 1 fence.)
```

---

## 1. Functional Tests

### 1.1 Check-block tests (fixture-driven)

Each case: `cd` into the fixture dir (or set `INSTALL_DIR`), run `bash "$WORK/check.sh"`, compare the last echoed token and the detail line.

**Setup - fixture makers (run once):**

```bash
mkdir -p "$WORK/cwd-new" "$WORK/cwd-old" "$WORK/cwd-none" "$WORK/cwd-bad" \
         "$WORK/cwd-comma" "$WORK/cwd-comment" "$WORK/installdir-new"

cat > "$WORK/cwd-new/pyproject.toml" <<'EOF'
[project]
name = "x"
requires-python = ">=3.14"
EOF

cat > "$WORK/cwd-old/pyproject.toml" <<'EOF'
[project]
requires-python = ">=3.11"
EOF

# no pyproject.toml in cwd-none

cat > "$WORK/cwd-bad/pyproject.toml" <<'EOF'
[project]
requires-python = "~3.14"
EOF

cat > "$WORK/cwd-comma/pyproject.toml" <<'EOF'
[project]
requires-python = ">=3.11,<3.15"
EOF

cat > "$WORK/cwd-comment/pyproject.toml" <<'EOF'
[project]
requires-python = '>=3.10'  # single-quoted form
EOF

cp "$WORK/cwd-new/pyproject.toml" "$WORK/installdir-new/pyproject.toml"
```

**1.1.1 Compliant interpreter, metadata reachable (expect OK, source named):**

```bash
cd "$WORK/cwd-comma"    # spec '>=3.11,<3.15' passes on any modern python3
bash "$WORK/check.sh"
```
- Expected: detail line `Python <running> meets requirement '>=3.11,<3.15' (source: <cwd>/pyproject.toml)`, then `PYTHON_OK`.

**1.1.2 Inter below a reachable requirement (expect VERSION_FAIL):**

```bash
cd "$WORK/cwd-new"      # '>=3.14' against the machine's default python3
bash "$WORK/check.sh"
```
- Expected on a pre-3.14 interpreter: `Python <running> does not meet requirement '>=3.14' (source: <cwd>/pyproject.toml)`, then `PYTHON_VERSION_FAIL`.
- Expected on a >=3.14 interpreter: `PYTHON_OK` (skip to 1.1.4 to force the fail path).

**1.1.3 Metadata unreachable (expect fallback spec, source says so):**

```bash
cd "$WORK/cwd-none"
bash "$WORK/check.sh"
```
- Expected: detail line names `documented minimum; pyproject.toml not found` and `'>=3.14'`; token per the running interpreter (`PYTHON_OK` on 3.14+, else `PYTHON_VERSION_FAIL`).

**1.1.4 Forced fail path regardless of interpreter (downgrade the spec):**

```bash
cd "$WORK/cwd-old"      # '>=3.11' still passes on modern python3; use INSTALL_DIR trick instead:
mkdir -p "$WORK/force-fail"
cat > "$WORK/force-fail/pyproject.toml" <<'EOF'
[project]
requires-python = ">=99.0"
EOF
cd "$WORK/force-fail"
bash "$WORK/check.sh"
```
- Expected: `Python <running> does not meet requirement '>=99.0' ...`, then `PYTHON_VERSION_FAIL`. This is the deterministic too-old path on any machine.

**1.1.5 Unevaluable requirement fails closed (expect FAIL with reason):**

```bash
cd "$WORK/cwd-bad"      # '~3.14' - unsupported operator
bash "$WORK/check.sh"
```
- Expected: `Could not evaluate Python requirement '~3.14' (source: <cwd>/pyproject.toml)`, then `PYTHON_FAIL` (NOT a pass).

**1.1.6 INSTALL_DIR lookup used when cwd has no metadata:**

```bash
cd "$WORK/cwd-none"
INSTALL_DIR="$WORK/installdir-new" bash "$WORK/check.sh"
```
- Expected: detail line source is `$WORK/installdir-new/pyproject.toml` (metadata found via INSTALL_DIR), token per comparison.

**1.1.7 Single-quoted TOML value parses:**

```bash
cd "$WORK/cwd-comment"
bash "$WORK/check.sh"
```
- Expected: detail line shows `'>=3.10'` and the cwd source; no fallback.

**1.1.8 Numeric boundary sanity (3.9 vs 3.14 ordering):**
Covered implicitly by 1.1.4 (`>=99.0` fails) and 1.1.3 (`>=3.14` evaluated numerically). On a 3.9-3.13 machine, 1.1.3 must yield `PYTHON_VERSION_FAIL`, proving `3.14 > 3.9..3.13` numerically.

### 1.2 CLI tests

Not Applicable - the change adds no CLI command; the check block is exercised in 1.1 exactly as the skill invokes it.

---

## 2. Backwards Compatibility Tests

**2.1 Missing interpreter (pre-change behavior preserved):**

```bash
PATH="/usr/bin:/bin" sh -c 'command -v python3'   # confirm a PATH without python3
# Simulate by running the presence guard alone:
bash -c 'if ! command -v python3 >/dev/null 2>&1; then echo PYTHON_FAIL; else echo PRESENT; fi' PATH="$WORK/nopath:$PATH"
```
- Expected: `PYTHON_FAIL` when python3 is absent; the remediation table's `PYTHON_FAIL` row still applies.

**2.2 Compliant interpreter, metadata present (pre-change pass preserved):**
Case 1.1.1 doubles as this test: `PYTHON_OK` and setup proceeds exactly as before.

**2.3 Sibling probes untouched:**

```bash
grep -c 'DOCKER_OK\|UV_OK\|NODE_OK\|GIT_OK\|JQ_OK\|GETTEXT_OK' "$SKILL"
git -C "$REPO" diff -- .claude/skills/macos-setup/SKILL.md | grep '^[-+]' | grep -v 'PYTHON\|===\|Python\|python3\|pyproject\|install\|Do not proceed\|present, and\|documentation\|^\(+\|-\)\{3\}' || true
```
- Expected: the docker/uv/node/git/jq/gettext probe lines are absent from the diff (unchanged).

**2.4 `PYTHON_FAIL` remediation row unchanged:**

```bash
grep -n 'PYTHON_FAIL | `brew install python@3.14`' "$SKILL"
```
- Expected: still present (the original row text intact).

---

## 3. UX Tests

**3.1 Failure message is self-explanatory:**
Run 1.1.4 and read the output cold. Verify the detail line answers: what ran (`Python x.y.z`), what is required (`'>=99.0'`), and who requires it (`source: .../pyproject.toml`).

**3.2 Fallback honesty:**
Run 1.1.3 and verify the output explicitly says the requirement came from the documented minimum because `pyproject.toml` was not found (no silent hard-coding).

**3.3 Remediation reachable:**

```bash
grep -n 'PYTHON_VERSION_FAIL | `brew install python@3.14`' "$SKILL"
```
- Expected: the new table row exists, immediately adjacent to the `PYTHON_FAIL` row.

**3.4 Gate sentence names the version requirement:**

```bash
grep -n 'PYTHON_VERSION_FAIL' "$SKILL" | wc -l
```
- Expected: 3 occurrences (check block, remediation row, do-not-proceed rule).

---

## 4. Deployment Surface Tests

### 4.1 Docker wiring
Not Applicable - no container or image change.

### 4.2 Terraform / ECS wiring
Not Applicable - no infrastructure parameter added.

### 4.3 Helm / EKS wiring
Not Applicable - no chart value added.

### 4.4 Deploy and verify
Not Applicable - the skill ships in-repo; "deploy" is the next invocation of `/macos-setup`.

### 4.5 Rollback verification

```bash
git -C "$REPO" checkout -- .claude/skills/macos-setup/SKILL.md
grep -n 'python3 --version 2>/dev/null && echo "PYTHON_OK"' "$SKILL"
```
- Expected: the original one-liner is restored; skill behaves as before the patch.

---

## 5. End-to-End API Tests

Not Applicable - no HTTP endpoint or multi-service workflow is touched. The end-to-end path that matters (Phase 1 gate -> Phase 5 `uv sync`) is a human/agent procedure; sections 1-3 verify the gate that protects it.

---

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes: 1.1.1-1.1.8 tokens and detail lines as specified
- [ ] Section 2 (Backwards Compat) verified: missing-interpreter and compliant paths unchanged, sibling probes untouched
- [ ] Section 3 (UX) verified: message names version, requirement, source; remediation row present; gate sentence updated
- [ ] Section 4 (Deployment) marked Not Applicable with rollback check done
- [ ] Section 5 (E2E) marked Not Applicable
- [ ] No pytest suite exists for skill markdown; verification is the manual procedure above
- [ ] `git apply --check patch.diff` succeeds on a fresh clone at tag `1.27.1`
