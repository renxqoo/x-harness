# Low-Level Design: macos-setup Phase 1 Python Version Precheck

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft*

## Table of Contents
1. [Overview](#overview)
2. [Codebase Analysis](#codebase-analysis)
3. [Architecture](#architecture)
4. [Data Models](#data-models)
5. [API / CLI Design](#api--cli-design)
6. [Configuration Parameters](#configuration-parameters)
7. [New Dependencies](#new-dependencies)
8. [Implementation Details](#implementation-details)
9. [Observability](#observability)
10. [Scaling Considerations](#scaling-considerations)
11. [File Changes](#file-changes)
12. [Testing Strategy](#testing-strategy)
13. [Alternatives Considered](#alternatives-considered)
14. [Rollout Plan](#rollout-plan)
15. [Open Questions](#open-questions)
16. [References](#references)

## Overview

### Problem Statement
The macos-setup skill (`.claude/skills/macos-setup/SKILL.md`) validates Python in Phase 1 with a presence-only probe:

```bash
python3 --version 2>/dev/null && echo "PYTHON_OK" || echo "PYTHON_FAIL"
```

Any `python3` on PATH passes, including the macOS system interpreter (3.9). The project requires `requires-python = ">=3.14"` (`pyproject.toml:10`). With an old interpreter, Phase 1 reports success, phases 2-4 run, and Phase 5 (`uv sync`) fails with an error that blames uv. The user gets no pointer to the real prerequisite.

### Goals
- Fail at Phase 1 when the interpreter is below the project's minimum, with a message naming the running version and the exact requirement.
- Read the requirement from project metadata (`requires-python` in `pyproject.toml`), not from a hard-coded guess in the check logic.
- Keep a documented-minimum fallback so the check still works in the skill's remote, pre-clone invocation mode.
- Keep the existing remediation guidance (`brew install python@3.14`) reachable for both missing-interpreter and too-old-interpreter outcomes.
- Preserve the skill's token-based output convention (`PYTHON_OK` / `PYTHON_FAIL` family) that the surrounding phases and remediation table rely on.

### Non-Goals
- Changing Phase 5 (`uv sync`) behavior, retries, or error text.
- Full PEP 508 specifier support (arbitrary markers, wildcards, epoch, local versions). Only simple comparator clauses are evaluated.
- Enforcing the requirement for other tools (Node, uv, jq) - their presence-only checks are unchanged.
- Changes to `docs/macos-setup-guide.md` (it already states "Version 3.14+"), Dockerfiles, or CI.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `.claude/skills/macos-setup/SKILL.md` | The macos-setup skill: a 16-phase guided setup workflow expressed as markdown instructions plus copy-pasteable bash blocks | The only file edited. Phase 1 (prerequisites check) is at lines 124-161 |
| `.claude/skills/macos-setup/SKILL.md:129-130` | Python presence probe | The exact lines replaced by this design |
| `.claude/skills/macos-setup/SKILL.md:149-157` | Remediation table mapping failure tokens to install commands | Gains a `PYTHON_VERSION_FAIL` row |
| `.claude/skills/macos-setup/SKILL.md:160` | Do-not-proceed rule | Extended to cover the version minimum |
| `pyproject.toml:10` | `requires-python = ">=3.14"` | The authoritative requirement source the check must read |
| `docs/macos-setup-guide.md:52` | "Python: Version 3.14+ - Install via Homebrew (`brew install python@3.14`)" | The documented minimum used as fallback; confirms the brew remediation is the established guidance |
| `.claude/skills/macos-setup/SKILL.md:269, 527` | Existing `python3 << 'PYEOF'` heredoc usage in Phases 4 and 11 | The convention the new check block follows |
| `.claude/skills/macos-setup/SKILL.md:322-339` | Phase 5 `uv sync` | Where the misleading failure lands today; unchanged |
| `.claude/skills/macos-setup/SKILL.md:60-90` | Step 0: `INSTALL_DIR` is set (default `~/AI-registry`) and expanded before Phase 1 | Makes `INSTALL_DIR` a reliable secondary metadata lookup location |

### Existing Patterns Identified
1. **Token-based check output**: every Phase 1 probe echoes an ALL-CAPS token (`DOCKER_OK`/`DOCKER_FAIL`, `UV_OK`/`UV_FAIL`, ...). The remediation table and the step log key off these tokens.
   - Files: `.claude/skills/macos-setup/SKILL.md:126-144`, `:149-157`
   - How a future implementer should follow this: keep `PYTHON_OK`/`PYTHON_FAIL` semantics intact; introduce exactly one new token (`PYTHON_VERSION_FAIL`) and add its table row.
2. **Python heredocs inside the skill**: Phases 4 and 11 run inline Python via `python3 << 'PYEOF'` with a quoted delimiter (no shell expansion).
   - Files: `.claude/skills/macos-setup/SKILL.md:269`, `:527`
   - How a future implementer should follow this: implement the version comparison in a quoted-delimiter heredoc, not with `sed`/`awk` text munging.
3. **Variables carried across phases**: `INSTALL_DIR` is established in Step 0 and "re-export[ed] ... at the start of any phase that uses it" (line 941).
   - How a future implementer should follow this: pass `INSTALL_DIR` into the check explicitly (`INSTALL_DIR="${INSTALL_DIR}" python3 << 'PYEOF'`) so it is visible in `os.environ` regardless of export state.
4. **Fail-then-instruct flow**: Phase 1 collects all failures, displays the remediation table, then applies the do-not-proceed rule.
   - How a future implementer should follow this: the new failure must slot into this same flow, not short-circuit with its own exit path.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `pyproject.toml` (`requires-python`) | Read at check time | Looked up in the current working directory, then in `${INSTALL_DIR}/pyproject.toml`; must tolerate absence (remote invocation) |
| Phase 1 check block | Extends | Replaces lines 129-130 with a presence check plus version check |
| Phase 1 remediation table | Extends | New `PYTHON_VERSION_FAIL` row with the existing brew guidance |
| Phase 1 do-not-proceed rule | Extends | Version minimum added to the gate |
| Phase 5 (`uv sync`) | Beneficiary | No code change; becomes unreachable with an unsupported interpreter |
| Step log | Extends | Phase 1 notes already free-form; no format change needed |

### Constraints and Limitations Discovered
- **Phase 1 runs before Phase 2 (clone)**: when the skill is invoked from its GitHub URL, `pyproject.toml` does not exist locally at Phase 1 time. Hence the metadata lookup must tolerate absence and fall back to the documented minimum (`>=3.14`).
- **No third-party packages on the system interpreter**: macOS system `python3` (3.9) has no `packaging` module. Comparison must be implemented with the standard library only (`re`, `os`, `sys`).
- **The check runs under the interpreter it is validating**: the heredoc executes with the same `python3` that setup will rely on, which is exactly what we want to test; but it must parse cleanly on 3.9+ syntax.
- **Skill markdown is the deliverable**: the "code" is a bash block inside SKILL.md that a human or agent copies and runs. It must be self-contained, copy-pasteable, and idempotent.

## Architecture

### System Context Diagram

```
                        macos-setup skill (SKILL.md)
  ┌────────────────────────────────────────────────────────────────┐
  │  Step 0 (mode, INSTALL_DIR)                                    │
  │        │                                                       │
  │        v                                                       │
  │  Phase 1: Prerequisites Check                                  │
  │    docker / uv / node / git / jq / gettext probes (unchanged)  │
  │    ┌──────────────────────────────────────────────────┐        │
  │    │ Python check (this change)                       │        │
  │    │  1. python3 present?  ──no──> PYTHON_FAIL        │        │
  │    │  2. read requires-python:                        │        │
  │    │       ./pyproject.toml  ->  ${INSTALL_DIR}/...   │        │
  │    │       else FALLBACK_SPEC (>=3.14, documented)    │        │
  │    │  3. compare numerically vs running interpreter   │        │
  │    │       pass   -> PYTHON_OK                        │        │
  │    │       too old -> PYTHON_VERSION_FAIL             │        │
  │    │       unreadable/unparseable -> PYTHON_FAIL      │        │
  │    └──────────────────────────────────────────────────┘        │
  │        │                                                       │
  │        v                                                       │
  │  Remediation table (PYTHON_FAIL / PYTHON_VERSION_FAIL rows)    │
  │  Do-not-proceed gate: presence AND version minimum             │
  └────────────────────────────────────────────────────────────────┘
          │ proceeds only if gate passes
          v
  Phases 2-4 (clone, credentials, .env)  ...  Phase 5 (uv sync)
```

### Sequence Diagram

```
User    Skill/Phase1          python3 heredoc            pyproject.toml
  │           │                        │                        │
  │           │── run check block ────>│                        │
  │           │                        │── read requires-python │
  │           │                        │<───── ">=3.14" ────────│
  │           │                        │  (fallback if absent)  │
  │           │                        │─ compare with tuple ─  │
  │           │<─ rc=0 / rc=1 / rc=2 ──│                        │
  │           │─ echo PYTHON_OK /                                   │
  │           │  PYTHON_VERSION_FAIL / PYTHON_FAIL                  │
  │<─ table + gate decision ────────│                                │
```

### Component Diagram

```
┌────────────────────────┐     ┌───────────────────────────────┐
│ Shell wrapper          │     │ Python heredoc (stdlib only)  │
│ - command -v python3   │────>│ - locate metadata (2 paths)   │
│ - maps rc to token     │<────│ - parse specifier clauses     │
│   rc=0 PYTHON_OK       │ rc  │ - tuple compare (zero-padded) │
│   rc=1 PYTHON_VERSION  │     │ - prints detail line          │
│   rc=2 PYTHON_FAIL     │     └───────────────────────────────┘
└────────────────────────┘
```

## Data Models

### New Models
No persisted models. In-memory only, inside the heredoc:

```python
# (major, minor, micro) tuples, zero-padded to equal length before comparison
RUNNING: tuple[int, ...]   # from sys.version_info[:3]
REQUIRED: tuple[int, ...]  # parsed from the numeric core of each clause

# One comparator clause of a Requires-Python specifier
# spec like ">=3.14" or ">=3.11,<3.15" splits into:
clause: tuple[op: str, version_text: str]  # op in {">=", "<=", "==", "!=", ">", "<"}
```

### Model Changes
None. No repo data models are touched.

## API / CLI Design

### New Endpoints / Commands
None. This is a modification of an existing check block inside a skill markdown file.

**Output contract of the Phase 1 Python check** (consumed by the person/agent running the skill and by the remediation table):

| Exit condition | rc from heredoc | Token echoed | Detail line (printed by heredoc) |
|----------------|-----------------|--------------|----------------------------------|
| `python3` absent | n/a | `PYTHON_FAIL` | none (unchanged behavior) |
| All clauses satisfied | 0 | `PYTHON_OK` | `Python 3.14.0 meets requirement '>=3.14' (source: pyproject.toml)` |
| Any clause fails | 1 | `PYTHON_VERSION_FAIL` | `Python 3.9.6 does not meet requirement '>=3.14' (source: pyproject.toml)` |
| Requirement present but unevaluable (unknown operator, no numeric version, unreadable file) | 2 | `PYTHON_FAIL` | `Could not evaluate Python requirement '<text>' (source: <path>)` |
| Metadata unreachable | 0/1 as compared | same as above | detail line names the fallback: `... requirement '>=3.14' (source: documented minimum; pyproject.toml not found)` |

**Error Cases:**
- Fail-closed: unevaluable requirement yields `PYTHON_FAIL` (rc 2), never a silent pass.
- The heredoc never raises into the shell: all exceptions are caught and mapped to rc 2 with a printed reason.

## Configuration Parameters

### New Environment Variables
None added. The check reads:

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `INSTALL_DIR` | path | `~/AI-registry` (set in Step 0) | No | Secondary location for `pyproject.toml` lookup; passed explicitly into the heredoc |

### Settings / Config Class Updates
One in-script constant (inside the heredoc, not project config):

```python
FALLBACK_SPEC = ">=3.14"  # documented minimum, mirrors docs/macos-setup-guide.md
```

### Deployment Surface Checklist
- [ ] `.claude/skills/macos-setup/SKILL.md` Phase 1 check block (the change itself)
- [ ] `.claude/skills/macos-setup/SKILL.md` Phase 1 remediation table (new row)
- [ ] `.claude/skills/macos-setup/SKILL.md` Phase 1 do-not-proceed rule (extended)
- No `.env.example` / docker-compose / Terraform / Helm surface: no new deployment parameter exists.

## New Dependencies

This change uses only existing dependencies. The heredoc imports `os`, `re`, `sys` from the standard library; `packaging` is deliberately not used (absent on the macOS system interpreter).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Replace the Python probe in the Phase 1 check block
**File:** `.claude/skills/macos-setup/SKILL.md`
**Lines:** 128-130 (the `echo "=== Python ==="` block inside the Phase 1 bash fence)

Replace:

```bash
echo "=== Python ==="
python3 --version 2>/dev/null && echo "PYTHON_OK" || echo "PYTHON_FAIL"
```

with:

```bash
echo "=== Python ==="
if ! command -v python3 >/dev/null 2>&1; then
    echo "PYTHON_FAIL"
else
    INSTALL_DIR="${INSTALL_DIR}" python3 << 'PYEOF'
import os
import re
import sys

FALLBACK_SPEC = ">=3.14"  # documented minimum (docs/macos-setup-guide.md)

def fail2(msg):
    print(msg)
    sys.exit(2)

try:
    # --- 1. Locate the requirement in project metadata -------------------
    spec = None
    source = "documented minimum; pyproject.toml not found"
    candidates = [
        os.path.join(os.getcwd(), "pyproject.toml"),
        os.path.join(os.environ.get("INSTALL_DIR", ""), "pyproject.toml"),
    ]
    for path in candidates:
        try:
            if path and os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as fh:
                    m = re.search(r'^requires-python\s*=\s*["\']([^"\']+)["\']',
                                  fh.read(), re.MULTILINE)
                if m:
                    spec = m.group(1).strip()
                    source = path
                    break
        except OSError:
            pass
    if not spec:
        spec = FALLBACK_SPEC

    # --- 2. Parse into comparator clauses --------------------------------
    clauses = []
    for raw in [c.strip() for c in spec.split(",") if c.strip()]:
        m = re.match(r'^(>=|<=|==|!=|>|<)\s*(.+)$', raw)
        if not m or not re.search(r'\d', m.group(2)):
            fail2("Could not evaluate Python requirement '%s' (source: %s)"
                  % (spec, source))
        clauses.append((m.group(1), m.group(2)))

    # --- 3. Compare numerically (zero-padded tuples) ---------------------
    def ver(text):
        parts = re.findall(r"\d+", text)
        return tuple(int(p) for p in parts[:3]) if parts else None

    running = tuple(sys.version_info[:3])
    ok = True
    for op, req_text in clauses:
        req = ver(req_text)
        if req is None:
            fail2("Could not evaluate Python requirement '%s' (source: %s)"
                  % (spec, source))
        n = max(len(req), len(running))
        a = req + (0,) * (n - len(req))
        b = running + (0,) * (n - len(running))
        passed = {">=": a <= b, "<=": a >= b, "==": a == b,
                  "!=": a != b, ">": a < b, "<": a > b}[op]
        if not passed:
            ok = False
            break

    # --- 4. Report ---------------------------------------------------------
    running_str = ".".join(str(p) for p in running)
    if ok:
        print("Python %s meets requirement '%s' (source: %s)"
              % (running_str, spec, source))
        sys.exit(0)
    print("Python %s does not meet requirement '%s' (source: %s)"
          % (running_str, spec, source))
    sys.exit(1)
except SystemExit:
    raise
except Exception as exc:  # fail closed on anything unexpected
    print("Could not evaluate Python requirement (%s)" % exc)
    sys.exit(2)
PYEOF
    PY_CHECK_RC=$?
    if [ "$PY_CHECK_RC" -eq 0 ]; then
        echo "PYTHON_OK"
    elif [ "$PY_CHECK_RC" -eq 1 ]; then
        echo "PYTHON_VERSION_FAIL"
    else
        echo "PYTHON_FAIL"
    fi
fi
```

Design notes for the implementer:
- `python3 << 'PYEOF'` with a **quoted** delimiter matches the skill's existing heredoc convention (no shell expansion inside).
- `INSTALL_DIR="${INSTALL_DIR}" python3 ...` guarantees `os.environ` sees it even though Step 0 set it as a plain shell variable.
- Comparison tuples are **zero-padded to equal length** so `3.14` (parsed `(3, 14)`) correctly compares against an interpreter reporting `3.14.0`, and `3.9` < `3.14` numerically (never string-compared).
- `~=` and other exotic operators fail closed via rc 2 (`PYTHON_FAIL` + reason).
- Fallback (`FALLBACK_SPEC`) is used only when no `pyproject.toml` was found in either lookup path, and the detail line says so - the hard-coded value never overrules reachable metadata.
- The outer `try/except` maps any unexpected failure to rc 2, so the shell always sees a clean 0/1/2 contract (SystemExit is re-raised so `fail2` and the final `sys.exit` calls keep their codes).

#### Step 2: Extend the remediation table
**File:** `.claude/skills/macos-setup/SKILL.md`
**Lines:** ~149-157. Add one row directly after the `PYTHON_FAIL` row:

```markdown
| PYTHON_VERSION_FAIL | `brew install python@3.14` (project requires the version printed above) |
```

The existing `PYTHON_FAIL` row is unchanged, so the established remediation guidance stays reachable for both failure modes.

#### Step 3: Extend the do-not-proceed rule
**File:** `.claude/skills/macos-setup/SKILL.md`
**Line:** ~160. Change:

```markdown
**Do not proceed if Docker or git fail.** Python, uv, Node.js, jq, and gettext must also be present before continuing. Ask the user to install missing tools and retry.
```

to:

```markdown
**Do not proceed if Docker or git fail.** Python, uv, Node.js, jq, and gettext must also be present, and Python must satisfy the project's minimum version (no `PYTHON_VERSION_FAIL`), before continuing. Ask the user to install missing tools and retry.
```

### Error Handling
- Missing interpreter: `PYTHON_FAIL` (unchanged).
- Unevaluable or malformed requirement (unknown operator, no digits, unreadable metadata file): the heredoc prints a reason and exits 2; the wrapper echoes `PYTHON_FAIL`. The check never silently passes on uncertainty.
- Read errors on individual metadata candidates are swallowed (the loop simply tries the next candidate), since absence is a normal pre-clone condition.

### Logging
- The heredoc's single detail line (running version, requirement, source) is the log record; it appears directly under `=== Python ===` in setup output, alongside the other probes.
- Phase 1's existing step-log entry (`{ 1, "Prerequisites Check", DONE/FAILED, ... }`) already captures free-form notes; no format change.

## Observability
### Tracing / Metrics / Logging Points
- No tracing/metrics (setup script, not a service).
- Key log event: the detail line, which always names requirement text and source (`pyproject.toml` path vs "documented minimum"). This is what makes a `PYTHON_VERSION_FAIL` self-explanatory in pasted setup logs.

## Scaling Considerations
Not applicable: the check runs once per setup invocation on one machine; cost is one interpreter startup (~30 ms) plus at most two small file reads.

## File Changes

### New Files
None.

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `.claude/skills/macos-setup/SKILL.md` | 128-130 | Replace presence-only Python probe with presence + version check (metadata-driven, fail-closed) |
| `.claude/skills/macos-setup/SKILL.md` | ~153 | Add `PYTHON_VERSION_FAIL` remediation row |
| `.claude/skills/macos-setup/SKILL.md` | ~160 | Extend the do-not-proceed gate with the version minimum |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (check block) | ~90 |
| New tests | 0 (testing.md describes verification procedures; the repo has no test harness for skill markdown) |
| Modified code (table row + gate sentence) | ~4 |
| Removed | ~3 |
| **Total** | **~95** |

## Testing Strategy
See `./testing.md` for the full plan: functional tests of the check block itself (copy-pasteable invocations against doctored `pyproject.toml` fixtures and old/new interpreters), backwards-compatibility tests (missing interpreter, compliant interpreter, untouched sibling probes), UX checks (message names version, requirement, source), and a deployment-surface check limited to the skill file itself.

## Alternatives Considered

### Alternative 1: Pure-shell check with hard-coded `3.14`
**Description:** `python3 -c 'import sys; exit(0 if sys.version_info >= (3, 14) else 1)' || echo PYTHON_VERSION_FAIL` with 3.14 hard-coded in the shell line.
**Pros / Cons:** Shortest diff / duplicates the version in a second place; silently drifts when `pyproject.toml` bumps; no explanation of which source/requirement applied.
**Why Rejected:** The task explicitly requires taking the version from project metadata rather than hard-coding a guess.

### Alternative 2: Grep/sed the requirement in shell, compare with `sort -V`
**Description:** Shell-only pipeline: `grep '^requires-python' pyproject.toml | sed ...` then `printf '%s\n' ... | sort -V | head -1`.
**Pros / Cons:** No heredoc / `sort -V` availability varies; specifier parsing in sed is brittle; harder to produce a clear fail-closed path and per-clause comparison.
**Why Rejected:** Less portable and less readable than the stdlib Python comparison, and the skill already standardizes on Python heredocs for logic.

### Alternative 3: Defer to Phase 5 with a friendlier `uv sync` wrapper
**Description:** Pre-flight `uv python pin` or a pre-`uv sync` version guard.
**Pros / Cons:** Close to the failure site metadata-wise (uv resolves interpreters) / does not satisfy the task: the fix must surface at Phase 1, before four phases of setup work.
**Why Rejected:** Fails the acceptance criterion that an unsupported interpreter is reported at Phase 1.

### Comparison Matrix

| Criteria | Chosen (heredoc, metadata-driven) | Alt 1 (hard-coded shell) | Alt 3 (Phase 5 guard) |
|----------|-----------------------------------|--------------------------|------------------------|
| Fails at Phase 1 | Yes | Yes | No |
| Version from metadata | Yes (fallback documented) | No | Indirect |
| Fail-closed on ambiguity | Yes | No | No |
| Diff size | Medium | Small | Medium |
| Stdlib-only portability | Yes | Yes | Yes |

## Rollout Plan
- Phase 1: Implementation (this patch; skill markdown only)
- Phase 2: Verification per `./testing.md` on a machine with the system Python 3.9 and one with Homebrew Python 3.14
- Phase 3: No deployment step; the skill ships in-repo and takes effect on next invocation

## Open Questions
- None blocking. If the project later adopts `~=` in `requires-python`, the fail-closed path will surface it and the operator set can be extended then.

## References
- `pyproject.toml:10` (`requires-python = ">=3.14"`)
- `docs/macos-setup-guide.md:52` (documented minimum and remediation)
- `.claude/skills/macos-setup/SKILL.md` Phase 1 (lines 124-161), Phase 5 (lines 322-339)
- GitHub issue #1568
