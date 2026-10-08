# Low-Level Design: Fix reserved-variable GROUPS assignment in Keycloak setup scripts

*Created: 2026-09-29*
*Author: glm-5.3-flash*
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

## Overview

### Problem Statement
`keycloak/setup/setup-agent-service-account.sh` runs under `set -e` (line 5). Its `verify_setup()` function (lines 399-428) captures the service account's Keycloak group list into a variable named `GROUPS` (line 404). `GROUPS` is a special bash array variable holding the caller's numeric supplementary group IDs; assigning a scalar string to it fails, and because of `set -e` the script aborts right there - exit status 1, no message - after every real setup step (M2M client, service account user, group membership, groups protocol mapper) has already succeeded. Every caller treats the run as failed, and the macos-setup skill halts a setup that in fact worked.

Empirically reproduced on macOS bash 3.2.57 (the compatibility floor for this repo's scripts):

```console
$ /bin/bash -ec 'GROUPS=hello; echo SURVIVED'
$ echo $?    # -> 1; "SURVIVED" never prints
```

shellcheck reports SC2178 on the assignment ("Variable was used as an array but is now assigned a scalar") plus two SC2128 warnings ("Expanding an array without an index only gives its first element"). The SC2128 warnings mean the subsequent membership check is also latently wrong: even where an abort does not happen, `"$GROUPS"` expands to only the first element of the caller's numeric group-ID array, so `echo "$GROUPS" | grep -q "$TARGET_GROUP"` can never legitimately match a Keycloak group name.

### Goals
- Make `setup-agent-service-account.sh` exit 0 on a fully successful run and print the verification output (`Service account groups: ...`, the membership result, the mapper result) that currently never appears.
- Make `verify_setup()` genuinely verify: check membership against the real newline-separated group names with an exact-line match, so the latent SC2128 wrongness is removed, not just the abort.
- Apply the identical fix to `keycloak/setup/setup-m2m-service-account.sh`, whose `verify_setup()` contains the same assignment at line 235.
- Keep both scripts compatible with macOS bash 3.2 and bash 5.x.
- Close the task's sweep requirement with evidence: no other assignment to a bash reserved variable remains in the setup scripts.

### Non-Goals
- Fixing `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126` - the sweep found the same `GROUPS=` latent bug there, but those are day-2 user-management utilities (the `cli/` one is marked DEPRECATED in its header), not setup scripts. Documented as a mechanical follow-up in `implementation.md` and the issue.
- Adding shellcheck to CI / pre-commit.
- Changing any curl retry, timeout, HTTP error-handling, or Keycloak API payload behavior.
- Tightening the membership pre-check in `assign_to_group()` (`CURRENT_GROUPS`): that variable is a safe non-reserved name and its logic works today; changing its matching semantics exceeds the minimal-diff mandate.
- Addressing the pre-existing use of `${RED}`/`${NC}` on line 17 of the agent script before the color constants are defined (lines 24-29); cosmetic, out of scope.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `keycloak/setup/setup-agent-service-account.sh` | Creates a per-agent M2M client + service account, assigns the target group, adds the groups mapper, verifies, writes `.oauth-tokens/agent-<id>.json` | **Primary fix target**; `verify_setup()` lines 399-428, bug at 404-410 |
| `keycloak/setup/setup-m2m-service-account.sh` | Creates the shared `mcp-gateway-m2m` service account with the same verify pattern | **Secondary fix target**; `verify_setup()` lines 230-259, bug at 235-241 |
| `keycloak/setup/setup-federation-service-account.sh` | Sibling setup script | Sweep reference - uses `TOKEN_GROUPS` (line 282), already safe, untouched |
| `keycloak/setup/get-all-client-credentials.sh` | Credential listing utility | Sweep reference - `IFS= read -r` at line 139 is command-scoped idiom, safe |
| `cli/user_mgmt.sh` | Operator CLI for Keycloak user/group management (deprecated) | Sweep finding: `list_groups()` line 109 assigns `GROUPS` under `set -e`; follow-up |
| `terraform/aws-ecs/scripts/user_mgmt.sh` | ECS-deployed twin of the CLI | Sweep finding: `list_groups()` line 126 same assignment; follow-up |

### Script anatomy (both fix targets share it)
- Line 5: `set -e` - every unguarded non-zero status aborts the script.
- `main()` (agent script lines 460-515) runs in order: `get_admin_token` -> `validate_group_exists` -> `create_agent_m2m_client` -> `get_agent_client_secret` -> `check_service_account`/`create_service_account` -> `ensure_target_group` -> `assign_to_group` -> `ensure_groups_mapper` -> **`verify_setup`** -> `generate_agent_token` -> success banner. The abort happens at step 7, so step 8 (token file) and the SUCCESS banner never run even though all Keycloak state is correct. The m2m script has the same shape with fewer steps.
- Functions communicate through globals (`TOKEN`, `CLIENT_ID`, `USER_ID`, `GROUP_ID`, `TARGET_GROUP`, ...); no `local` usage anywhere in these two scripts today.
- Colors: `GREEN`/`RED`/`YELLOW`/`BLUE`/`NC` constants (agent script lines 24-29) used with `echo -e`.
- Membership-check pattern appears in three places: `assign_to_group()` in both scripts (`echo "$CURRENT_GROUPS" | grep -q "$TARGET_GROUP"`) and `verify_setup()` in both scripts (on the broken `GROUPS`).

### The bug, precisely

```bash
# setup-agent-service-account.sh lines 403-410 (m2m script lines 234-241)
# Check service account exists and is in the right group
GROUPS=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$ADMIN_URL/admin/realms/$REALM/users/$USER_ID/groups" | \
    jq -r '.[].name')

echo "Service account groups: $GROUPS"          # never reached: the assignment aborts first

if echo "$GROUPS" | grep -q "$TARGET_GROUP"; then
```

1. Bash initializes `GROUPS` as a dynamic array of the caller's supplementary GIDs. Assigning a scalar string to it is an error (reproduced: exit 1 under `set -e` on bash 3.2.57).
2. Under `set -e` the failed assignment terminates the script immediately with status 1 and no message.
3. Independently, SC2128 flags that `"$GROUPS"` would expand to element 0 only - so even the intended comparison target is wrong, not just the assignment mechanics.

### Sweep for reserved-variable assignments (executed at tag 1.27.1)

Method: `grep -rnE '^[[:space:]]*(GROUPS|PPID|UID|EUID|FUNCNAME|DIRSTACK|HOSTNAME|HOSTTYPE|LINENO|OLDPWD|OPTIND|OSTYPE|PIPESTATUS|RANDOM|REPLY|SECONDS|SHELLOPTS|SHLVL|MAPFILE|OPTARG)=' --include='*.sh' .` over the whole repo, plus a broader name list over `keycloak/`, plus manual review of `IFS` hits.

| Location | Finding | Disposition |
|----------|---------|-------------|
| `keycloak/setup/setup-agent-service-account.sh:404` | `GROUPS=` | **Fixed by this change** |
| `keycloak/setup/setup-m2m-service-account.sh:235` | `GROUPS=` | **Fixed by this change** |
| `cli/user_mgmt.sh:109` | `GROUPS=` | Follow-up (day-2 utility, not a setup script) |
| `terraform/aws-ecs/scripts/user_mgmt.sh:126` | `GROUPS=` | Follow-up (day-2 utility, not a setup script) |
| `keycloak/setup/get-all-client-credentials.sh:139` and similar | `IFS=',' read -ra ...` prefixes | Command-scoped idiom, not a global assignment to `IFS` - safe |
| `terraform/aws-ecs/scripts/user_mgmt.sh:171,333`, `cli/user_mgmt.sh:154,316` | `IFS=',' read -ra GROUPS_ARRAY` | Same - safe; and `GROUPS_ARRAY` is a distinct non-reserved name |
| `ENV_FILE=` occurrences (`keycloak/setup/init-keycloak.sh:803` etc.) | ordinary name, only matched the sweep pattern via substring | Safe |
| `export`/`declare` forms of any reserved name | none found | - |

Conclusion: inside `keycloak/setup/` the only reserved-variable assignments are the two `GROUPS=` lines this change fixes. After the fix the setup scripts are sweep-clean.

### Existing Patterns Identified
1. **Uppercase globals for cross-function state**: `SERVICE_ACCOUNT`, `TARGET_GROUP`, `CURRENT_GROUPS`, `AGENT_CLIENT_SECRET`.
   - Files: both target scripts.
   - How a future implementer should follow this: keep uppercase-style descriptive names for cross-function state; for a variable used only inside one function, declare it `local` (bash 3.2 supports `local`; it is simply unused in these files so far).
2. **Verification output style**: `echo "Service account groups: $VAR"` followed by green `✓` / red `✗` lines.
   - Files: `verify_setup()` in both scripts.
   - Follow: keep the output strings as-is; only the variable behind them changes.
3. **Membership check shape**: `if echo "$VAR" | grep -q "<group>"; then ... fi` - the grep runs in condition context, so a non-match does not trip `set -e`.
   - Files: `assign_to_group()`, `verify_setup()` x2.
   - Follow: keep the condition-context shape; in `verify_setup()` upgrade the match to exact-line (`grep -Fxq`) since the task explicitly requires the membership check to compare against the real group names.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| macos-setup skill / `docs/macos-setup-guide.md` flow | Depends on this script's exit code | The documented flow shells out to `setup-agent-service-account.sh`; the spurious exit 1 is what halts it. After the fix, exit 0 restores the contract. |
| `.oauth-tokens/agent-<id>.json` | Produced by `generate_agent_token()` (step 8) | Only runs after `verify_setup()` returns 0; currently unreachable on a first run. Becomes reachable again - intended. |
| `keycloak/setup/generate-agent-token.sh`, `test-keycloak-mcp.sh` | Printed as next steps | Unchanged; they work once setup exits 0. |

### Constraints and Limitations Discovered
- **macOS bash 3.2**: no `declare -A`, no `mapfile`/`readarray`, no `|&`, no `${var,,}`. The fix uses only 3.2-safe constructs: `local`, command substitution, `echo`, `grep -q`/`grep -Fxq`.
- **`set -e` masking pitfall**: `local var=$(cmd)` masks the command's exit status (the compound's status is `local`'s, always 0). The declaration and the assignment must be separate statements to preserve fail-fast behavior.
- **Pipeline failure behavior after the fix**: if curl fails or jq receives an empty body, `service_account_groups` is empty; the membership check then fails into the explicit red `✗` + `exit 1` branch (condition context, no `set -e` surprise). That is the desired legible failure.
- **grep portability (BSD vs GNU)**: bash 3.2 on macOS implies BSD userland. The combined short flags in `grep -Fxq` are supported by both GNU grep and macOS BSD grep; implementers must keep the combined short-flag form and must not switch to long options (`--fixed-strings --line-regexp --quiet`), which BSD grep does not accept in combination.
- **Exact-line match caveat**: `grep -Fxq "$TARGET_GROUP"` requires the group name to be a full line of the jq output. `jq -r '.[].name'` emits bare names with no path prefix and no trailing whitespace, so values like `mcp-servers-restricted` and `mcp-servers-finance/read` both match exactly. Substring false positives (for example account in `mcp-servers-finance/read` while verifying `mcp-servers-finance`) are eliminated.

## Architecture

### System Context Diagram

```text
+---------------------------+      runs       +--------------------------------------+
| operator / macos-setup    | --------------> | keycloak/setup/                      |
| skill (docs flow)         |                 |   setup-agent-service-account.sh     |
+---------------------------+                 |   setup-m2m-service-account.sh       |
          |  checks $?                        +------------------+-------------------+
          v                                                      |
   expects 0 on success                                          v
   (today: gets 1)                                    +---------------------+
                                                       | Keycloak Admin API  |
                                                       |  clients / users /  |
                                                       |  groups / mappers   |
                                                       +---------------------+
```

### Sequence Diagram (verify_setup after the fix)

```text
main() -> verify_setup()
  verify_setup() {
    local service_account_groups            # declaration only (status 0)
    service_account_groups=$(curl ... | jq -r '.[].name')
        |                                   # plain scalar assignment to a fresh local:
        |                                   # exit status propagates -> set -e can still abort
        v
    echo "Service account groups: $service_account_groups"
    if echo "$service_account_groups" | grep -Fxq "$TARGET_GROUP"
        -> echo "✓ Service account is in '<group>' group"
      else
        -> echo "✗ Service account is NOT in '<group>' group"; exit 1
    ... mapper check unchanged ...
  }
main() -> generate_agent_token()            # now reachable
main() prints SUCCESS ... ; script exits 0
```

### Component Diagram

```text
setup-agent-service-account.sh            setup-m2m-service-account.sh
  verify_setup()  [lines 399-428]           verify_setup()  [lines 230-259]
    GROUPS        -> service_account_groups   GROUPS        -> service_account_groups
    (local, split declaration)                (local, split declaration)
    grep -q  -> grep -Fxq                     grep -q  -> grep -Fxq
    echo/if lines updated to new var          echo/if lines updated to new var
```

## Data Models

Not applicable - pure shell fix. No Pydantic models, schemas, or persisted data change. The only "data" is the newline-separated group-name string produced by `jq -r '.[].name'`, now held in a correctly named scalar local.

## API / CLI Design

**No CLI surface changes.** Both scripts keep their existing invocation, options (`-a/--agent-id`, `-g/--group`, `-c/--client`, `-h/--help`), and output text. The only externally observable changes: exit code on success becomes 0, and the verification lines actually print.

**Error Cases (semantics preserved, now reachable):**
- Membership genuinely missing: red `✗ Service account is NOT in '<group>' group`, exit 1.
- curl/jq failure during verification: empty group list -> same `✗` branch, exit 1 (no silent pass; `grep -Fxq` on empty input fails).

## Configuration Parameters

**None.** No new environment variables, settings, or deployment-surface changes. Existing knobs (`KEYCLOAK_ADMIN_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`) are untouched.

## New Dependencies

None. This change uses only existing dependencies (bash 3.2+, curl, jq, grep).

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Fix `verify_setup()` in `setup-agent-service-account.sh`
**File:** `keycloak/setup/setup-agent-service-account.sh`
**Lines:** 403-410 (inside `verify_setup()`, lines 399-428)

Replace:

```bash
    # Check service account exists and is in the right group
    GROUPS=$(curl -s -H "Authorization: Bearer $TOKEN" \
        "$ADMIN_URL/admin/realms/$REALM/users/$USER_ID/groups" | \
        jq -r '.[].name')

    echo "Service account groups: $GROUPS"

    if echo "$GROUPS" | grep -q "$TARGET_GROUP"; then
```

with:

```bash
    # Check service account exists and is in the right group
    # NOTE: GROUPS is a reserved bash array variable (the caller's supplementary
    # group IDs); assigning a scalar to it fails under `set -e`. Keep the
    # declaration and assignment split - `local var=$(cmd)` would mask the
    # command's exit status and defeat fail-fast.
    local service_account_groups
    service_account_groups=$(curl -s -H "Authorization: Bearer $TOKEN" \
        "$ADMIN_URL/admin/realms/$REALM/users/$USER_ID/groups" | \
        jq -r '.[].name')

    echo "Service account groups: $service_account_groups"

    if echo "$service_account_groups" | grep -Fxq "$TARGET_GROUP"; then
```

Everything else in `verify_setup()` (mapper check, `✓`/`✗` messages, `exit 1` branches) is unchanged.

#### Step 2: Apply the identical fix in `setup-m2m-service-account.sh`
**File:** `keycloak/setup/setup-m2m-service-account.sh`
**Lines:** 234-241 (inside `verify_setup()`, lines 230-259)

Same replacement as Step 1: identical comment, identical `local` + split assignment, `echo` line updated, membership `if` upgraded to `grep -Fxq`.

#### Step 3: Re-run the sweep
Confirm no remaining `GROUPS=` (or other reserved-name) assignment under `keycloak/setup/`. Expected result: clean. Full-repo result remains: only the two documented `user_mgmt.sh` follow-ups.

### Error Handling
- The declaration/assignment split preserves `set -e` fail-fast on transport failures (curl error, jq crash): the script dies at the assignment, before printing a misleading verification line.
- Empty group list (empty curl body) yields `""`; `grep -Fxq` on empty input fails -> explicit red `✗` message + `exit 1`. Visible, correctly attributed as "not in group", exit code 1.
- Exact-line matching removes the substring false-positive class (for example verifying `mcp-servers-finance` while the account is in `mcp-servers-finance/read` now correctly reports NOT in group).

### Logging
No new log points. Existing output is preserved; the lines that could never execute before (`Service account groups: ...`, the membership result, the mapper result) now always run on success.

## Observability

The scripts' stdout is their observability. The fix restores three previously-dead signals on success:
1. `Service account groups: <newline-separated names>` - proves the membership read worked.
2. `✓ Service account is in '<group>' group` (green) - the actual membership assertion.
3. `✓ Groups mapper is configured` (green) - was unreachable on first runs.

No metrics/tracing exist in these scripts; adding any is out of scope.

## Scaling Considerations

Not applicable - single-shot operator scripts; no load, concurrency, or caching dimensions. Unchanged: `verify_setup()` makes two admin-API calls, as before.

## File Changes

### New Files
None.

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `keycloak/setup/setup-agent-service-account.sh` | ~403-410 | `GROUPS` -> `local service_account_groups` (split declaration), `echo` updated, membership check `grep -q` -> `grep -Fxq`, NOTE comment added |
| `keycloak/setup/setup-m2m-service-account.sh` | ~234-241 | Identical change |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (comment + declaration, x2 files) | ~10 |
| New tests | 0 (verification plan lives in `testing.md`; repo has no shell test harness) |
| Modified code (renamed/updated lines, x2 files) | ~10 |
| **Total** | **~20** |

## Testing Strategy

See `./testing.md` for the full executable plan: static sweep checks, `bash -n` syntax checks, shellcheck SC2178/SC2128 clearance, bash-3.2/bash-5 semantics reproduction of the old failure, a stubbed-function harness that exercises `verify_setup()` in both directions (membership present -> exit 0 and output printed; membership absent -> exit 1), and a live E2E checklist against local Keycloak 26.x for both scripts. Per skill constraints, tests were designed but NOT executed.

## Alternatives Considered

### Alternative 1: Rename to a plain global, e.g. `SERVICE_ACCOUNT_GROUPS`
**Description:** Keep the file's global-variable style; just pick a safe uppercase name.
**Pros / Cons:** Matches existing style; but the variable is only used inside `verify_setup()`, and globals invite future collisions.
**Why Rejected:** The task explicitly asks to scope the variable local; `local` prevents recurrence of exactly this bug class inside the function.

### Alternative 2: Built-in array (`mapfile`/`readarray`)
**Description:** Read group names into a real bash array with `mapfile -t groups <<< ...`.
**Why Rejected:** `mapfile` requires bash 4+; macOS ships 3.2. Violates the compatibility constraint.

### Alternative 3: Keep substring `grep -q` after the rename
**Description:** Rename only; leave the membership check shape untouched.
**Pros / Cons:** Smallest possible diff; but the task explicitly says the membership check that relied on `GROUPS` is latently wrong (SC2128) and must compare against the real group names. With substring matching, `mcp-servers-finance` falsely verifies when the account is in `mcp-servers-finance/read`.
**Why Rejected:** Does not satisfy the "checks group membership against the real group names" requirement; exact-line `grep -Fxq` is the minimal change that does.

### Alternative 4: Also fix `cli/user_mgmt.sh` and `terraform/aws-ecs/scripts/user_mgmt.sh`
**Description:** Apply the same rename in the two day-2 utilities.
**Why Rejected for this change:** The task scopes the sweep-and-fix to the setup scripts; those two are documented in the issue and in `implementation.md` as a mechanical follow-up so the finding is not lost.

### Comparison Matrix

| Criteria | Chosen (local + safe name + `grep -Fxq`) | Alt 1 (global rename) | Alt 2 (mapfile) | Alt 3 (rename only) |
|----------|------------------------------------------|------------------------|------------------|----------------------|
| Fixes exit-1-on-success | Yes | Yes | Yes | Yes |
| Membership check actually correct | Yes (exact line) | No (substring) | Yes (if handled) | No (substring) |
| bash 3.2 safe | Yes | Yes | **No** | Yes |
| Fails fast on transport error | Yes | Yes | Yes | Yes |
| Minimal diff | Yes | Yes (slightly smaller) | No | Yes (slightly smaller) |

## Rollout Plan
- Phase 1: Implementation - this patch (`./patch.diff`), applies onto tag `1.27.1`.
- Phase 2: Verification - `testing.md` Sections 1-4 (static, semantics, harness) run in any sandbox; Section 5 live E2E against Keycloak 26.x by an operator.
- Phase 3: Follow-ups - reserved-variable cleanup in the two `user_mgmt.sh` scripts; optional CI shellcheck gate; optional exact-match tightening in `assign_to_group()`.

## Open Questions
- None blocking.

## References
- shellcheck SC2178 / SC2128: https://www.shellcheck.net/wiki/SC2178 , https://www.shellcheck.net/wiki/SC2128
- Bash manual, Shell Variables (`GROUPS`): https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html
- Upstream issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1570
