# GitHub Issue: setup-agent-service-account.sh exits 1 on success - assignment to reserved bash variable GROUPS

## Title
`keycloak/setup/setup-agent-service-account.sh` fails in `verify_setup()`: assigns to the reserved bash variable `GROUPS` (SC2178/SC2128), so a fully successful setup exits 1 with no message

## Labels
- bug
- shell
- keycloak
- developer-experience

## Description

### Problem Statement
`keycloak/setup/setup-agent-service-account.sh` exits 1 after a run that actually succeeded, and prints no error. By the time it fails, the M2M client, the service account user, the group membership, and the groups protocol mapper have all been created correctly - but the non-zero exit makes every caller treat the setup as failed, and the macos-setup skill halts a setup that in fact worked.

The failure is in `verify_setup()` (line 404). It captures the service account's group list into a variable named `GROUPS`:

```bash
GROUPS=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN_URL/admin/realms/$REALM/users/$USER_ID/groups" | \
    jq -r '.[].name')
```

`GROUPS` is a special bash variable: an array of the caller's numeric supplementary group IDs. Assigning a scalar string to it fails, and the script runs under `set -e` (line 5), so it aborts before the next line ever runs - no verification output, no error message, exit status 1.

shellcheck flags the assignment as **SC2178** ("Variable was used as an array but is now assigned a scalar") plus two **SC2128** warnings ("Expanding an array without an index only gives its first element"). The SC2128 warnings mean the subsequent membership check `echo "$GROUPS" | grep -q "$TARGET_GROUP"` is also latently wrong: even where the script does not abort, it compares against only the first element of the caller's numeric group-ID array, never the Keycloak group names.

The identical defective assignment exists in `verify_setup()` of `keycloak/setup/setup-m2m-service-account.sh` (line 235).

### Sweep results (assignments to bash reserved variables)

A repo-wide sweep of `*.sh` for assignments to bash reserved variables found:

| File | Line | Variable | Disposition |
|------|------|----------|-------------|
| `keycloak/setup/setup-agent-service-account.sh` | 404 | `GROUPS` | **This issue - primary fix** |
| `keycloak/setup/setup-m2m-service-account.sh` | 235 | `GROUPS` | **Same bug inside the setup scripts - fixed by this issue** |
| `cli/user_mgmt.sh` | 109 | `GROUPS` | Same latent bug; day-2 user-management utility (deprecated), not a setup script - mechanical follow-up |
| `terraform/aws-ecs/scripts/user_mgmt.sh` | 126 | `GROUPS` | Same latent bug; day-2 user-management utility, not a setup script - mechanical follow-up |
| various | - | `IFS=',' read -r ...` prefixes | Idiomatic command-scoped usage, not a global reserved-variable assignment - not a bug |

### Proposed Solution
In both `keycloak/setup/` scripts:

1. Rename the `verify_setup()` variable from `GROUPS` to a safe, descriptive name (`service_account_groups`), declared with `local` so the function cannot collide with shell special variables.
2. Split declaration from assignment (`local service_account_groups` then `service_account_groups=$(...)`) so a curl/jq failure still aborts under `set -e` (a combined `local var=$(cmd)` would mask the exit status).
3. Fix the membership check that relied on the broken variable: match `TARGET_GROUP` as an exact line (`grep -Fxq`) against the real newline-separated group names, so prefix collisions (for example `mcp-servers-finance` matching `mcp-servers-finance/read`) cannot produce a false verification pass.
4. Keep the verification output (`Service account groups: ...`, the green/red result lines) so operators finally see it on success.
5. Confirm via the sweep that no other reserved-variable assignment remains in the setup scripts.

### User Stories
- As an operator running the Keycloak setup scripts, I want a 0 exit code to mean "setup succeeded" so that my tooling does not report a failure that did not happen.
- As the macos-setup skill, I want to shell out to the setup scripts and trust their exit codes so that a working setup does not halt the guided flow.
- As a script maintainer, I want the group-membership verification to check real group names so that `verify_setup()` actually verifies.

### Acceptance Criteria
- [ ] `keycloak/setup/setup-agent-service-account.sh` exits 0 on a successful run and prints the full verification output, including `Service account groups: ...` and the green `✓ Service account is in '<group>' group` / `✓ Groups mapper is configured` lines, followed by `SUCCESS! Agent service account setup complete.`
- [ ] No line in either setup script assigns to `GROUPS` or any other bash reserved variable; the sweep over `keycloak/` comes back clean after the fix.
- [ ] The membership check in `verify_setup()` passes only when `TARGET_GROUP` is an exact member of the service account's real group names, and exits 1 with the red `✗ Service account is NOT in '<group>' group` message when it is not (including when the group list comes back empty due to a transport failure).
- [ ] `keycloak/setup/setup-m2m-service-account.sh` receives the identical fix at line 235.
- [ ] Both scripts remain compatible with macOS bash 3.2 as well as bash 5.x (`local`, command substitution, `grep -Fxq` are all 3.2-safe; no bash 4+ features introduced).
- [ ] shellcheck SC2178/SC2128 no longer fire on the touched scripts.

### Out of Scope
- Fixing `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126` (same latent pattern in day-2 user-management utilities, one of them deprecated; tracked as a mechanical follow-up so the finding is not lost).
- Tightening the pre-check in `assign_to_group()` (`CURRENT_GROUPS`, a safe variable name with working logic) beyond what this bug requires.
- Adding shellcheck to CI or pre-commit.
- Changing Keycloak API payloads, curl retry/timeout behavior, or any other script output.

### Dependencies
- None. bash 3.2+ and the existing curl/jq toolchain only.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1570
