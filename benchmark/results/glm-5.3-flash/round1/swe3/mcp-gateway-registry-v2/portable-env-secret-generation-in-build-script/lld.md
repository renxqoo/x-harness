# Low-Level Design: Portable .env secret generation in build_and_run.sh

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash run)*
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

## Overview

### Problem Statement
`build_and_run.sh` (757 lines, bash, `set -e`) auto-generates required secrets into `.env`: SECRET_KEY, AUTH_SERVER_NGINX_MARKER_SECRET, DOCUMENTDB_PASSWORD, METRICS_KEY_PEPPER, OPENBAO_TOKEN, and per-service `METRICS_API_KEY_*` tokens. Before appending the generated value, each block deletes the shipped empty placeholder line with:

```bash
sed -i '/^SECRET_KEY=$/d' .env 2>/dev/null || true
sed -i '/^SECRET_KEY=""$/d' .env 2>/dev/null || true
```

On BSD userlands (macOS), `sed -i` requires a backup-suffix argument; the bare form errors immediately. The `2>/dev/null || true` swallows the failure, the placeholder survives, and the generated value is appended below it. `.env` then holds two assignments for the same key; Docker Compose (env_file / `${VAR}` interpolation, first-assignment-wins) consumes the empty one, the script still logs "SECRET_KEY added to .env", and the auth server crash-loops on a missing secret.

### Goals
- One portable, loud helper replaces every bare `sed -i` deletion in `build_and_run.sh` (5 secret blocks x 2 deletes + the metrics token loop = 11 sed invocations).
- Works unchanged on GNU/Linux and BSD/macOS userlands, including bash 3.2.
- A failed `.env` rewrite aborts the script with an actionable error (no `2>/dev/null || true`).
- No change to generation triggers, entropy, or which values are generated.

### Non-Goals
- Fixing `sed -i` uses in other scripts: `docker/registry-entrypoint.sh` (runs inside Linux containers with GNU sed), `terraform/telemetry-collector/deploy.sh` (already uses `sed -i.bak`), `keycloak/setup/clean-keycloak.sh` (different script and substitution pattern, not part of secret generation).
- Changing detection logic (`grep -q` triggers at lines 342/361/383/406/428), weak-value validation (~lines 507-563), or `.env.example` content.
- CI coverage for BSD userlands.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `build_and_run.sh` | Main build/launch script; generates secrets into `.env` | The only file modified. Six sites use bare `sed -i ... .env 2>/dev/null \|\| true`: lines 347-348, 366-367, 388-389, 411-412, 433-434 (secret blocks) and 654 (metrics token loop) |
| `build_and_run.sh` lines 1-15 | `log()` and `handle_error()` helpers | The new helper is placed next to them and reuses `handle_error` for loud failure |
| `build_and_run.sh` lines 214-227 | `.env` existence check + early `source .env` | Guarantees `.env` exists before any helper call; script runs from repo root (all `.env` references are relative) |
| `.env.example` (lines 885, 894, 1275, 1771) | Ships empty placeholders (`SECRET_KEY=`, `AUTH_SERVER_NGINX_MARKER_SECRET=`, `DOCUMENTDB_PASSWORD=`, `OPENBAO_TOKEN=`) | These copied-to-`.env` placeholders are exactly what the deletions must remove; not modified |
| `docker/registry-entrypoint.sh` (lines 202-454) | nginx config rewriting inside containers | Out of scope: Linux container, GNU sed guaranteed |
| `keycloak/setup/clean-keycloak.sh` (lines 158-159), `terraform/telemetry-collector/deploy.sh` (lines 82-86) | Other `sed -i` users | Out of scope: different scripts/patterns; deploy.sh already passes a backup suffix |
| `cli/service_mgmt.sh:127`, `tests/integration/test_virtual_server_scopes_e2e.sh:154`, `scripts/test-mcpgw-tools.sh:46` | Existing `mktemp` usage in repo shell scripts | Convention precedent: temp-file rewrite via `mktemp` is already the repo's house style |

### Existing Patterns Identified
1. **Secret generation blocks**: `grep -q` detection -> `log "Generating X..."` -> `python3 -c 'import secrets; ...'` -> delete placeholder via `sed -i` -> `echo "X=$V" >> .env` -> `log "X added to .env"`.
   - Files: `build_and_run.sh:341-441`, `build_and_run.sh:635-662`
   - How a future implementer should follow this: keep every part of the block except the `sed -i` pair, which becomes one `remove_env_lines` call.
2. **Error handling**: `handle_error()` logs `ERROR: ...` and `exit 1`; used at every hard-failure point.
   - Files: `build_and_run.sh:12-15`
   - How a future implementer should follow this: the helper must call `handle_error` instead of returning a status callers would have to check.
3. **Temp files**: `mktemp` in the current directory tree, no `trap`-based cleanup elsewhere in the repo.
   - Files: `scripts/test-mcpgw-tools.sh:46`, `cli/service_mgmt.sh:127`
   - How a future implementer should follow this: use `mktemp` with an explicit template; `rm -f` on the failure paths.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| Docker Compose | Consumer of `.env` | Reads first assignment per key; the empty placeholder must be gone before `up` |
| `source .env` (lines 227, 445, 632) | Consumer of `.env` | Shell sourcing is last-wins, which masked the bug for in-script reads; behavior unchanged |
| auth_server | Consumer of generated secrets | Crash-loops when SECRET_KEY / AUTH_SERVER_NGINX_MARKER_SECRET are empty; motivates loud failure |

### Constraints and Limitations Discovered
- macOS ships bash 3.2 and BSD sed/grep/mktemp: no GNU-only flags (`sed -i` without suffix, `stat --reference`, `grep -P`), no bash 4 features.
- `set -e` is active: an unguarded `grep` returning 1 (no lines selected) would kill the script; the helper must guard exit statuses explicitly.
- `grep -v` exit codes: 0 = lines selected, 1 = no lines selected (all filtered; a valid outcome), >= 2 = real error.
- `mv` from `mktemp` (usually TMPDIR) may cross filesystems; creating the temp file as a sibling of `.env` keeps the rename same-filesystem and near-atomic.
- `mv` replaces the file, so the inode and mode change: `.env` ends up `0600` (mktemp's mode) instead of `0644`. Acceptable and strictly safer for a secrets file; documented as a deliberate behavior note.
- If `.env` were a symlink, `mv` would replace the symlink rather than the target. Symlinked `.env` is not a supported setup (the script requires a real file at lines 214-224); documented, not engineered around.
- Exposure window: the temp file holds the full secret-bearing `.env` content while the rewrite runs (milliseconds per secret). It is created `0600` by `mktemp` in the same directory as `.env`, so the exposure is equivalent to `.env` itself; `rm -f` on every failure path prevents residue.

## Architecture

### System Context Diagram
```
+---------------------+      writes       +--------+      read by      +------------------+
| build_and_run.sh    | ----------------->|  .env  | ------------------>| docker compose   |
| (secret generation) |  (append/rewrite) +--------+  (first key wins) | up / interpolation|
+---------------------+                                            +------------------+
        |                                                                  |
        | remove_env_lines (portable rewrite, loud failure)                v
        +------------------------------------------------>  auth_server MUST see real values
```

### Sequence Diagram
```
Script                       remove_env_lines                filesystem
  |  call '^(VAR)=$\|^VAR=""$'   |                              |
  |----------------------------->|  mktemp .env.XXXXXX          |
  |                              |----------------------------->|
  |                              |  grep -E -v -- PATTERN .env > tmp
  |                              |----------------------------->|
  |                              |  rc>=2 ? rm tmp + handle_error
  |                              |  mv tmp .env                 |
  |                              |----------------------------->|
  |  echo "VAR=value" >> .env    |                              |
  |------------------------------------------------------------->|
```

### Component Diagram
```
log()  handle_error()  remove_env_lines()      <- new, defined once after handle_error()
   \          /            /
    [ secret generation blocks x5 ]            <- each: 2 sed calls -> 1 helper call
    [ metrics token loop ]                     <- sed call -> helper call
```

## Data Models

Not applicable - no data models; the artifact is a key=value `.env` file. The invariant added: **at most one assignment per generated key**, maintained by deleting placeholder lines before appending.

## API / CLI Design

Not applicable - no endpoints or CLI commands change. The script's invocation surface (`--prebuilt`, `--podman`, `--dhi`, `--help`) is untouched.

## Configuration Parameters

No new configuration parameters or environment variables. The change is internal to the script.

### Deployment Surface Checklist
Not applicable - no config parameter is added on any surface (no `.env.example`, compose, Terraform, or Helm changes).

## New Dependencies

This change uses only existing dependencies (bash, grep, mktemp - all already required by the script and present on macOS/GNU userlands).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Add the `remove_env_lines` helper
**File:** `build_and_run.sh`
**Lines:** after `handle_error()` (insert at ~line 16, before argument parsing)

```bash
# Remove lines matching the POSIX extended regex $1 from .env, portably.
# NOTE: this helper operates on ./.env only - build_and_run.sh enforces a
# real .env in the repo root before any call (see the existence check at
# the top of the script). Do not "generalize" it to a filename argument
# without re-checking the same-filesystem-temp requirement below.
# The previous implementation used `sed -i '<expr>' .env`, which GNU sed
# accepts but BSD sed (macOS) rejects: there the first argument after -i
# is a mandatory backup suffix. The failure was hidden by `2>/dev/null
# || true`, leaving the empty placeholder in place and the generated
# value appended below it (first-assignment-wins consumers then saw an
# empty secret). Rewriting through a temp file behaves identically on
# GNU and BSD userlands, and failures are loud.
remove_env_lines() {
    local pattern="$1"
    local tmp_file grep_rc=0
    tmp_file=$(mktemp .env.XXXXXX) || handle_error "Failed to create temp file while updating .env"
    # grep exits 1 when it selects no lines (every line matched, i.e. the
    # whole file is placeholder lines), which is a valid outcome.
    # Exit >= 2 is a real error and must not be silenced.
    grep -E -v -- "$pattern" .env > "$tmp_file" || grep_rc=$?
    if [ "$grep_rc" -ge 2 ]; then
        rm -f "$tmp_file"
        handle_error "Failed to filter .env (portable sed -i replacement) for pattern: $pattern"
    fi
    if ! mv "$tmp_file" .env; then
        rm -f "$tmp_file"
        handle_error "Failed to rewrite .env (portable sed -i replacement) for pattern: $pattern"
    fi
}
```

Design notes:
- `mktemp .env.XXXXXX` creates the temp file in the current directory, i.e. a sibling of `.env` (all `.env` references in the script are relative and the script enforces `.env` exists at lines 214-224), so the final `mv` is a same-filesystem rename.
- `-E` (ERE) supports the `|` alternation that collapses each secret's two `sed` calls into one helper call.
- `--` guards against patterns that could be mistaken for options (defensive; current patterns start with `^`).
- bash 3.2 compatible: `local`, `$( )`, `|| var=$?` are all POSIX/bash-3.2 safe.

#### Step 2: Replace the SECRET_KEY deletions
**File:** `build_and_run.sh`
**Lines:** 346-348

```bash
    # Remove any existing empty SECRET_KEY line
    remove_env_lines '^SECRET_KEY=$|^SECRET_KEY=""$'
```

#### Step 3: Replace the AUTH_SERVER_NGINX_MARKER_SECRET deletions
**File:** `build_and_run.sh`
**Lines:** 365-367

```bash
    # Remove any existing empty marker line
    remove_env_lines '^AUTH_SERVER_NGINX_MARKER_SECRET=$|^AUTH_SERVER_NGINX_MARKER_SECRET=""$'
```

#### Step 4: Replace the DOCUMENTDB_PASSWORD deletions
**File:** `build_and_run.sh`
**Lines:** 387-389

```bash
    # Remove any existing empty DOCUMENTDB_PASSWORD line
    remove_env_lines '^DOCUMENTDB_PASSWORD=$|^DOCUMENTDB_PASSWORD=""$'
```

#### Step 5: Replace the METRICS_KEY_PEPPER deletions
**File:** `build_and_run.sh`
**Lines:** 410-412

```bash
    # Remove any existing empty METRICS_KEY_PEPPER line
    remove_env_lines '^METRICS_KEY_PEPPER=$|^METRICS_KEY_PEPPER=""$'
```

#### Step 6: Replace the OPENBAO_TOKEN deletions
**File:** `build_and_run.sh`
**Lines:** 432-434

```bash
    # Remove any existing empty OPENBAO_TOKEN line
    remove_env_lines '^OPENBAO_TOKEN=$|^OPENBAO_TOKEN=""$'
```

#### Step 7: Replace the metrics token loop deletion
**File:** `build_and_run.sh`
**Lines:** 653-654

```bash
            # Remove any existing line for this variable
            remove_env_lines "^${ENV_VAR_NAME}="
```

(`ENV_VAR_NAME` values are `METRICS_API_KEY_*` - uppercase letters, digits and underscores - so the variable interpolation is regex-safe. Note the pattern is anchored at the start only, so a value like `METRICS_API_KEY_AUTH_SERVER=` also matches longer names that merely extend it; this prefix-collision property is faithfully inherited from the original `sed "/^$ENV_VAR_NAME=/d"` and is not changed here.)

### Error Handling
- `mktemp` failure: temp-file creation error is surfaced via `handle_error` (script exits 1).
- `grep` exit >= 2 (unreadable file, bad regex): temp file removed, `handle_error` fired with the offending pattern.
- `mv` failure: temp file removed, `handle_error` fired.
- `grep` exit 1 (every line filtered): treated as success - the rewrite yields an empty file, which is the correct deletion result; the generated value is appended right after.
- The previous `2>/dev/null || true` silencing is removed everywhere; a failed edit can no longer produce a silently-stale `.env`.

### Logging
No new log lines. Existing `log "Generating X..."` / `log "X added to .env"` messages become truthful: "added" now implies the placeholder was actually removed, because a failure aborts the script instead of continuing. `handle_error` provides the error log line on failure.

## Observability
- On failure: one `ERROR: ...` line via `handle_error` including the regex that failed, then exit 1. This is the observable that was missing (previously: silent no-op).
- On success: unchanged output (generation + "added to .env" logs), so CI logs do not change on GNU userlands.
- No metrics/tracing surface applies to a developer build script.

## Scaling Considerations
Not applicable - a one-shot developer script over a small file. The rewrite is O(file size) per call, unchanged asymptotically from the sed approach. `.env` is a few hundred lines, so the extra temp-file rewrite per secret is negligible.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| None | The helper lives inside `build_and_run.sh` |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `build_and_run.sh` | ~16 (insert) | Add `remove_env_lines()` helper (~20 lines with comments) |
| `build_and_run.sh` | 346-348 | Replace 2 `sed -i` calls with 1 `remove_env_lines` call (SECRET_KEY) |
| `build_and_run.sh` | 365-367 | Same for AUTH_SERVER_NGINX_MARKER_SECRET |
| `build_and_run.sh` | 387-389 | Same for DOCUMENTDB_PASSWORD |
| `build_and_run.sh` | 410-412 | Same for METRICS_KEY_PEPPER |
| `build_and_run.sh` | 432-434 | Same for OPENBAO_TOKEN |
| `build_and_run.sh` | 653-654 | Replace loop-body `sed -i` call with `remove_env_lines` (metrics tokens) |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~20 |
| New tests | 0 (testing.md provides manual verification steps; no test harness exists for this script) |
| Modified code | ~-11 / +6 (11 sed invocations become 6 helper calls) |
| **Total** | **~26** |

## Testing Strategy
See `./testing.md` - GNU/BSD equivalence checks, first-assignment consumer verification, loud-failure verification, and metrics-loop coverage. Per skill constraints the target repo's tests are not executed by this run.

## Alternatives Considered

### Alternative 1: `sed -i '' '/regex/d' .env` guarded by OS detection
**Description:** Detect the sed flavor (`sed --version` presence or `uname`) and pass an empty backup suffix on BSD.
**Pros / Cons:** Minimal code change; but OS-detection-by-proxy is fragile (GNU sed on macOS via brew, BusyBox), and the empty-suffix quoting (`-i ''`) differs per flavor.
**Why Rejected:** Flavor detection is exactly the kind of cleverness that re-introduces breakage on unmapped userlands; the temp-file rewrite has no branches at all.

### Alternative 2: `sed -i.bak` + `rm .env.bak`
**Description:** Pass an explicit backup suffix everywhere and delete the backup.
**Pros / Cons:** Smallest diff; portable; leaves `.env.bak` transiently (secrets on disk in a second file).
**Why Rejected:** Duplicates secret material to a stray file on every generation and litters the tree on failure; the `rm` needs its own error handling, so the "smaller" diff is not actually simpler.

### Alternative 3: Perl `perl -i -pe`
**Description:** Use perl's portable in-place editing.
**Pros / Cons:** Truly portable in-place edit; but adds a perl dependency to a script that currently needs only POSIX tools.
**Why Rejected:** New dependency for a dev bootstrap script is a worse trade than a 20-line helper.

### Alternative 4: `cat tmp > .env` instead of `mv`
**Description:** Rewrite contents in place to preserve inode/permissions.
**Pros / Cons:** Preserves mode bits; but a mid-write failure truncates `.env` (non-atomic, potential secret-file loss).
**Why Rejected:** Atomicity beats the cosmetic mode preservation; the resulting `0600` on `.env` is safer for a secrets file and is documented.

### Comparison Matrix

| Criteria | Chosen (mktemp+grep+mv) | Alt 1 (OS-detect sed) | Alt 2 (sed -i.bak) | Alt 3 (perl) | Alt 4 (cat >) |
|----------|-------------------------|----------------------|--------------------|--------------|---------------|
| Portability | High | Medium | High | High | High |
| Failure visibility | Loud | Medium | Medium | Loud | Loud |
| New dependencies | None | None | None | perl | None |
| Atomic rewrite | Yes | Yes | Yes | Yes | No |
| Extra secret copies | None | None | .env.bak | None | None |
| Complexity | Low | High | Low | Low | Low |

## Rollout Plan
- Phase 1: Implementation (this change, delivered as `patch.diff`).
- Phase 2: Verification on macOS (BSD userland) and Linux (GNU userland) per `testing.md`.
- Phase 3: Follow-up issue for a repo-wide `sed -i` portability audit (`keycloak/setup/clean-keycloak.sh`, other scripts) and optional CI job on macOS runners.

## Open Questions
- None blocking. Whether to extend the fix to `keycloak/setup/clean-keycloak.sh` in this patch was resolved as "no" (scope: the secret-generation script named in the issue; see Non-Goals).

## References
- Issue #1577 (BSD `sed -i` placeholder failure).
- BSD sed manual: `-i extension` - "the argument is used as the suffix of the backup file" (no empty-suffix form without an explicit empty argument).
- POSIX grep exit statuses (0 selected / 1 none / 2 error).
