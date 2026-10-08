# Implementation Summary: Portable .env secret generation in build_and_run.sh

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
`build_and_run.sh` no longer uses GNU-only `sed -i` (whose BSD failure was silenced by `2>/dev/null || true`, leaving empty `.env` placeholders in place on macOS while the generated value was appended below them). A new `remove_env_lines()` helper rewrites `.env` portably (`grep -E -v` into a sibling `mktemp` file, then `mv`), treats grep's "no lines selected" (exit 1) as success, and aborts loudly via `handle_error` on any real failure. All six call sites (five generated-secret blocks plus the per-service metrics-token loop) now use the helper.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `build_and_run.sh` | modified | +36 / -11 | Added `remove_env_lines()` helper (~17 lines with comments) after `handle_error()`; replaced 11 bare `sed -i ... .env 2>/dev/null \|\| true` invocations at 6 sites with 6 `remove_env_lines` calls |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

Verified: `git apply --check` passes against a fresh checkout at `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`.

## Deviations from the LLD
None of substance - implemented exactly as designed in the revised LLD. (The helper comment text matches the LLD's post-review revision verbatim; line counts differ slightly from the LLD's ~26-line estimate because the helper carries explanatory comments: actual +36/-11.)

## Not Implemented / Follow-ups
- No fixes to other `sed -i` users (`docker/registry-entrypoint.sh` runs inside Linux containers; `terraform/telemetry-collector/deploy.sh` already passes a backup suffix; `keycloak/setup/clean-keycloak.sh` is a different script/pattern) - per the issue scope and the LLD Non-Goals.
- No BSD-leg CI job - suggested follow-up issue (repo-wide `sed -i` portability audit).

## Verification (not executed)
Per skill constraints, the target repo's tests/builds were not run. `testing.md` contains the executable verification plan: helper isolation tests on GNU and BSD userlands (1.1.1-1.1.5), backwards-compat checks including the documented `.env` mode change 0644 -> 0600 (Section 2), UX/error-message checks (Section 3), deployment surfaces marked Not Applicable (Section 4), and macOS/Linux end-to-end stack runs (Section 5). Static verification performed on the clone: no bare `sed -i` deletions remain in `build_and_run.sh`; all six helper call sites present; `git diff --stat` shows a single-file change (+36/-11); the patch applies cleanly onto the pinned baseline.
