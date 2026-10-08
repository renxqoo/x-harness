# Testing Plan: Fix reserved-variable GROUPS assignment in Keycloak setup scripts

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
The change is two near-identical shell edits in `keycloak/setup/setup-agent-service-account.sh` and `keycloak/setup/setup-m2m-service-account.sh`. Testing must prove: (a) the scripts are syntactically valid on bash 3.2 and bash 5.x, (b) no assignment to a bash reserved variable remains in the setup scripts, (c) `verify_setup()` exits 0 and prints its output when membership is present, exits 1 when it is absent, and (d) the full end-to-end run against a real Keycloak exits 0 with the success banner. Tests below are copy-pasteable; paths are relative to the repository root.

### Prerequisites
- [ ] Repository checked out at tag `1.27.1` with `patch.diff` applied (`git apply patch.diff`).
- [ ] `bash`, `curl`, `jq`, `grep` on PATH (macOS default userland suffices).
- [ ] shellcheck installed (Section 1.4 only; skip cleanly if absent).
- [ ] For Section 5 only: local Keycloak 26.x reachable at `http://localhost:8080` with admin credentials.

### Shared Variables
```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
AGENT_SCRIPT="$REPO_ROOT/keycloak/setup/setup-agent-service-account.sh"
M2M_SCRIPT="$REPO_ROOT/keycloak/setup/setup-m2m-service-account.sh"
```

## 1. Functional Tests (CLI / static)

### 1.1 bash syntax check on macOS bash 3.2 and any bash 5.x
```bash
/bin/bash -n "$AGENT_SCRIPT" && echo "agent: 3.2 syntax OK" || echo "agent: 3.2 syntax FAIL"
/bin/bash -n "$M2M_SCRIPT"  && echo "m2m:   3.2 syntax OK" || echo "m2m:   3.2 syntax FAIL"
# On a system with a newer bash:
bash -n "$AGENT_SCRIPT" && echo "agent: bash5 syntax OK"
bash -n "$M2M_SCRIPT"  && echo "m2m:   bash5 syntax OK"
```
**Expected:** every line prints `OK`; exit codes 0.

### 1.2 Reserved-variable sweep is clean for the setup scripts
```bash
grep -nE '^[[:space:]]*(GROUPS|PPID|UID|EUID|FUNCNAME|DIRSTACK|HOSTNAME|HOSTTYPE|LINENO|OLDPWD|OPTIND|OSTYPE|PIPESTATUS|RANDOM|REPLY|SECONDS|SHELLOPTS|SHLVL|MAPFILE|OPTARG)=' \
  "$REPO_ROOT/keycloak/setup/"*.sh
echo "sweep-exit=$?"
```
**Expected:** no matches, `sweep-exit=1` (grep's "not found"). Then confirm the new variable is in place in both functions:
```bash
grep -n 'local service_account_groups' "$AGENT_SCRIPT" "$M2M_SCRIPT"
```
**Expected:** exactly one hit per file, inside `verify_setup()`.

### 1.3 The known out-of-scope findings are unchanged (documentation check)
```bash
grep -n 'GROUPS=' "$REPO_ROOT/cli/user_mgmt.sh" "$REPO_ROOT/terraform/aws-ecs/scripts/user_mgmt.sh"
```
**Expected:** `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126` still show `GROUPS=` (untouched, documented follow-up).

### 1.4 shellcheck clearance
```bash
command -v shellcheck >/dev/null && shellcheck "$AGENT_SCRIPT" "$M2M_SCRIPT" || echo "shellcheck not installed; skip"
```
**Expected:** no SC2178 / SC2128 findings for either script. (Other pre-existing informational findings are out of scope.)

## 2. Backwards Compatibility Tests

### 2.1 CLI surface unchanged
```bash
"$AGENT_SCRIPT" --help | head -5
"$AGENT_SCRIPT" 2>&1 | head -3   # no --agent-id
echo "exit=$?"
```
**Expected:** usage text identical to pre-change; missing-required-arg path still prints the red `Error: Agent ID is required` and exits 1. No new flags, no changed flags.

### 2.2 The old failure mode no longer reproduces in the scripts (regression semantics)
```bash
/bin/bash -ec 'GROUPS=hello; echo SURVIVED'; echo "reserved-assignment-exit=$?"
```
**Expected:** `reserved-assignment-exit=1` (bash itself unchanged) - and, unlike before, the scripts no longer perform that assignment, which Sections 3.x prove behaviorally.

### 2.3 Failure path preserved (missing membership still exits 1)
```bash
# Without a live Keycloak: extract the post-fix verify_setup() and run it against an
# unreachable admin URL. The empty group list must fall into the explicit fail branch.
REPO_ROOT="$(pwd)"
awk '/^verify_setup\(\)/,/^}/' "$REPO_ROOT/keycloak/setup/setup-agent-service-account.sh" > /tmp/verify_body.sh
cat > /tmp/verify_fail_test.sh <<EOF
set -e
GREEN=''; RED=''; NC=''
ADMIN_URL="http://localhost:1"
REALM="mcp-gateway"
TOKEN="stub"
USER_ID="stub"
CLIENT_ID="stub"
TARGET_GROUP="mcp-servers-restricted"
$(cat /tmp/verify_body.sh)
verify_setup || echo "VERIFY_EXITED_NONZERO_OK"
EOF
/bin/bash /tmp/verify_fail_test.sh
```
**Expected:** output contains the red `✗ Service account is NOT in 'mcp-servers-restricted' group` line and `VERIFY_EXITED_NONZERO_OK`. (curl fails, group list is empty, the membership check must not pass.) The same test works against the m2m script.

## 3. UX Tests (script output)

### 3.1 Success-path output appears (stubbed harness, both scripts)
Run per script, with `curl`/`jq` stubbed and the real group list injected:

```bash
cat > /tmp/verify_harness.sh <<'EOF'
set -e
SCRIPT_UNDER_TEST="$1"
GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ADMIN_URL="stub"; REALM="mcp-gateway"; TOKEN="stub"
USER_ID="stub-user"; CLIENT_ID="stub-client"
TARGET_GROUP="mcp-servers-restricted"
curl() {
  if [[ "$2" == *"/users/"*"/groups"* ]]; then
    echo '[{"name":"mcp-servers-restricted","id":"g1"},{"name":"other","id":"g2"}]'
  else
    echo '[{"name":"groups","id":"m1"}]'
  fi
}
jq() {
  if [[ "$3" == '.[].name' ]]; then
    printf 'mcp-servers-restricted\nother\n'
  elif [[ "$*" == *'select(.name=="groups")'* ]]; then
    printf 'groups\n'
  else
    printf '[]\n'
  fi
}
eval "$(awk '/^verify_setup\(\)/,/^}/' "$SCRIPT_UNDER_TEST")"
verify_setup && echo "HARNESS: verify_setup exited 0"
EOF
/bin/bash /tmp/verify_harness.sh "$AGENT_SCRIPT"
/bin/bash /tmp/verify_harness.sh "$M2M_SCRIPT"
```
**Expected, per script:**
- `Service account groups:` line listing `mcp-servers-restricted` and `other` (previously this line never printed).
- Green `✓ Service account is in 'mcp-servers-restricted' group`.
- Green `✓ Groups mapper is configured`.
- `HARNESS: verify_setup exited 0`.

### 3.2 Membership check matches real group names, not substrings
```bash
sed 's/TARGET_GROUP="mcp-servers-restricted"/TARGET_GROUP="mcp-servers-finance"/' \
  /tmp/verify_harness.sh > /tmp/verify_harness_prefix.sh
sed -i '' 's/printf '\''mcp-servers-restricted\\nother\\n'\''/printf '\''mcp-servers-finance\/read\\nother\\n'\''/' \
  /tmp/verify_harness_prefix.sh 2>/dev/null || \
sed -i 's/printf '\''mcp-servers-restricted\\nother\\n'\''/printf '\''mcp-servers-finance\/read\\nother\\n'\''/' \
  /tmp/verify_harness_prefix.sh
/bin/bash /tmp/verify_harness_prefix.sh "$AGENT_SCRIPT"; echo "exit=$?"
```
**Expected:** red `✗ Service account is NOT in 'mcp-servers-finance' group`, exit non-zero, no `HARNESS:` line. With the old substring `grep -q` this case would have printed a false green `✓` (prefix match against `mcp-servers-finance/read`).

## 4. Deployment Surface Tests

**Not Applicable** - the change adds no configuration parameter on any surface (no env var, no Docker/Terraform/Helm wiring). Existing env knobs are untouched.

## 5. End-to-End Tests

### 5.1 Environment
```bash
export KEYCLOAK_ADMIN_URL="http://localhost:8080"
export KEYCLOAK_REALM="mcp-gateway"
export KEYCLOAK_ADMIN="admin"
export KEYCLOAK_ADMIN_PASSWORD="<admin-password>"
# Realm and the mcp-servers-restricted group must exist (keycloak/setup/init-keycloak.sh creates them).
```

### 5.2 Fresh agent service account run
```bash
"$AGENT_SCRIPT" --agent-id e2e-test-agent; echo "exit=$?"
```
**Expected:** client created, service account created, group assigned, mapper added; then `Verifying setup...`, `Service account groups:` (listing `mcp-servers-restricted`), green membership and mapper lines, `.oauth-tokens/agent-e2e-test-agent.json` written, `SUCCESS! Agent service account setup complete.`, **exit 0**. (Pre-change, this exact run exited 1 after the mapper step with no verification output.)

### 5.3 Idempotent re-run
```bash
"$AGENT_SCRIPT" --agent-id e2e-test-agent; echo "exit=$?"
```
**Expected:** all creation steps report "already exists"; same verification output; **exit 0**.

### 5.4 Shared m2m service account run
```bash
"$M2M_SCRIPT"; echo "exit=$?"
```
**Expected:** same shape as 5.2 for the `mcp-gateway-m2m` account; **exit 0**.

### 5.5 Genuine negative case via stub (live-negative without touching Keycloak)
With the harness from 3.1 pointed at the patched scripts but the stubbed group list changed to omit the target group:
```bash
/bin/bash /tmp/verify_harness_prefix.sh "$M2M_SCRIPT"; echo "exit=$?"
```
**Expected:** red `✗ ... NOT in group`, non-zero exit - proving the live fail branch is still wired after the fix.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional / static) passes: `bash -n` clean on 3.2 and 5.x; sweep clean under `keycloak/setup/`; shellcheck free of SC2178/SC2128
- [ ] Section 2 (Backwards Compat) verified: CLI surface unchanged; failure paths still exit 1
- [ ] Section 3 (UX) verified: harness shows verification output on both pass and fail branches, including the prefix-collision negative
- [ ] Section 4 (Deployment) marked Not Applicable (no config surface)
- [ ] Section 5 (E2E) executed against local Keycloak 26.x: both scripts exit 0 with banner; idempotent re-run exits 0
- [ ] No unit/integration test files added (repo has no shell test harness; static + harness + E2E cover the change)
- [ ] `patch.diff` passes `git apply --check` against a fresh `1.27.1` checkout

> Per benchmark constraints, these tests were designed but NOT executed by the authoring run; a human or CI implements them as written.
