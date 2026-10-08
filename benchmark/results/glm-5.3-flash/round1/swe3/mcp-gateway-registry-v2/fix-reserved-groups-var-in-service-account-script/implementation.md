# Implementation Summary: Fix reserved-variable GROUPS assignment in Keycloak setup scripts

*Created: 2026-09-29*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
`verify_setup()` in both `keycloak/setup/setup-agent-service-account.sh` and `keycloak/setup/setup-m2m-service-account.sh` no longer assigns the service account's group list to `GROUPS`, a reserved bash array variable whose scalar assignment aborted the scripts under `set -e` after a fully successful setup. The variable is renamed to a function-local `service_account_groups` (declaration and assignment kept as separate statements so curl/jq failures still fail fast), and the membership check now matches the target group as an exact line (`grep -Fxq`) against the real newline-separated group names, eliminating the latent first-element expansion (SC2128) and substring false positives. On success the scripts now print the previously-dead verification output and exit 0.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `keycloak/setup/setup-agent-service-account.sh` | modified | +8 / -3 | `verify_setup()` (lines ~403-415): NOTE comment, `local service_account_groups` with split declaration, `echo` and membership `if` updated, `grep -q` -> `grep -Fxq` |
| `keycloak/setup/setup-m2m-service-account.sh` | modified | +8 / -3 | Identical change in its `verify_setup()` (lines ~234-246) |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` was run against a clean checkout at the baseline commit and passed; the patch was then re-applied to the working clone.

## Deviations from the LLD
None - implemented exactly as designed. The LLD's Steps 1-3 map one-to-one onto the two hunks and the post-fix sweep.

## Not Implemented / Follow-ups
- `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126`: the sweep found the same `GROUPS=` latent bug in `list_groups()` of these two day-2 user-management utilities (the `cli/` one is marked DEPRECATED in its header). They are not setup scripts, so they are outside this task's sweep-and-fix scope; the fix is the identical mechanical rename. Left untouched, tracked here and in `github-issue.md`.
- CI/pre-commit shellcheck gate (would keep SC2178/SC2128 out permanently): out of scope, LLD Rollout Phase 3.
- Tightening `assign_to_group()`'s pre-check from substring to exact match: that check uses the safe variable `CURRENT_GROUPS` and works; changing its semantics exceeds the minimal-diff mandate. Noted in LLD Non-Goals.

## Sweep Result (post-fix)
`grep -rnE '^[[:space:]]*(GROUPS|PPID|UID|EUID|FUNCNAME|DIRSTACK|HOSTNAME|HOSTTYPE|LINENO|OLDPWD|OPTIND|OSTYPE|PIPESTATUS|RANDOM|REPLY|SECONDS|SHELLOPTS|SHLVL|MAPFILE|OPTARG)=' --include='*.sh' keycloak/` returns no matches. Full-repo matches are limited to the two `user_mgmt.sh` follow-ups above. `IFS='...' read` prefixes elsewhere are command-scoped idiom, not reserved-variable assignments.

## Verification (not executed)
Per the skill's constraints, the target repo's tests were not run and no build/lint was executed against it. The executable verification plan - `bash -n` on bash 3.2/5.x, the reserved-variable sweep, shellcheck SC2178/SC2128 clearance, a stubbed `verify_setup()` harness exercising pass/fail/prefix-collision branches, and live E2E against Keycloak 26.x - is in `./testing.md`. Static checks performed during authoring only: `git diff` review, the sweep above, and `git apply --check` of the patch.
