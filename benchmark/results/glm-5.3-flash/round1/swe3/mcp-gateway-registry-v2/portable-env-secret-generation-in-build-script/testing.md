# Testing Plan: Portable .env secret generation in build_and_run.sh

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies that the six `remove_env_lines` call sites in `build_and_run.sh` produce identical `.env` results on GNU and BSD userlands, that consumers reading the first assignment per key see real (non-empty) secret values, and that a failing rewrite aborts the script loudly instead of leaving an empty placeholder.

### Prerequisites
- [ ] A checkout of this repo at the patched revision
- [ ] macOS (BSD userland) machine or container for the BSD leg; any GNU/Linux box for the GNU leg
- [ ] `docker compose` available for the E2E leg; `python3` and `openssl` on PATH (already required by the script)
- [ ] A copy of `.env.example` as starting `.env`

### Shared Variables
```bash
REPO="<path-to-repo-checkout>"
cd "$REPO" || exit 1
cp .env.example .env   # fresh start; ships empty placeholders
```

## 1. Functional Tests

### 1.1 Script-level tests (no HTTP/CLI surface added; these exercise the changed code paths)

#### 1.1.1 Placeholder removal leaves a single assignment per key (BSD + GNU)
```bash
cd "$REPO" && cp .env.example .env
bash build_and_run.sh --help >/dev/null 2>&1 || true   # smoke: script parses
# Do NOT run the full build; instead source-test the helper in isolation:
bash -c '
  cd "'"$REPO"'" || exit 1
  # extract the helper (from its comment header to its closing brace) and source it
  eval "$(awk "/^# Remove lines matching/,/^}/" build_and_run.sh)"
  printf "SECRET_KEY=\nFOO=bar\nSECRET_KEY=\"\"\n" > .env
  remove_env_lines "^SECRET_KEY=\$\|^SECRET_KEY=\"\"\$"
  cat .env
'
```
Expected output (identical on macOS and Linux):
```
FOO=bar
```
Assertions:
- [ ] `grep -c "^SECRET_KEY=" .env` prints `0`
- [ ] `FOO=bar` survives
- [ ] exit code of the `bash -c` block is 0

#### 1.1.2 Every generated key ends up exactly once, non-empty (full generation blocks)
```bash
cd "$REPO" && cp .env.example .env
# run only the generation section by executing the script up to validation is not
# isolated; instead simulate each block's delete+append pair:
bash -c '
  cd "'"$REPO"'" || exit 1
  eval "$(awk "/^# Remove lines matching/,/^}/" build_and_run.sh)"
  for k in SECRET_KEY AUTH_SERVER_NGINX_MARKER_SECRET DOCUMENTDB_PASSWORD METRICS_KEY_PEPPER OPENBAO_TOKEN; do
    printf "%s=\n" "$k" >> .env
    remove_env_lines "^${k}=\$\|^${k}=\"\"\$"
    echo "$k=generated-value" >> .env
  done
'
for k in SECRET_KEY AUTH_SERVER_NGINX_MARKER_SECRET DOCUMENTDB_PASSWORD METRICS_KEY_PEPPER OPENBAO_TOKEN; do
  count=$(grep -c "^${k}=" .env)
  value=$(grep "^${k}=" .env | head -1 | cut -d= -f2-)
  echo "$k count=$count value_len=${#value}"
  test "$count" -eq 1 && test -n "$value" && test "$value" = "generated-value" \
    && echo "PASS $k" || echo "FAIL $k"
done
```
Assertions:
- [ ] all five keys print `PASS` (count 1, non-empty, correct value)
- [ ] works identically on macOS (BSD grep/mktemp/mv) and Linux (GNU)

#### 1.1.3 Metrics token loop pattern (dynamic key)
```bash
cd "$REPO" && cp .env.example .env
bash -c '
  cd "'"$REPO"'" || exit 1
  eval "$(awk "/^# Remove lines matching/,/^}/" build_and_run.sh)"
  ENV_VAR_NAME=METRICS_API_KEY_AUTH_SERVER
  printf "METRICS_API_KEY_AUTH_SERVER=\n" >> .env
  remove_env_lines "^${ENV_VAR_NAME}="
  echo "$ENV_VAR_NAME=mcp_metrics_generated" >> .env
'
grep -c "^METRICS_API_KEY_AUTH_SERVER=" .env   # expected: 1
grep "^METRICS_API_KEY_AUTH_SERVER=" .env      # expected: =mcp_metrics_generated
```
Assertions:
- [ ] count is 1 and the value is the generated token, not empty

#### 1.1.4 Failure is loud (grep error path)
```bash
cd "$REPO" && cp .env.example .env
bash -c '
  cd "'"$REPO"'" || exit 1
  eval "$(awk "/^# Remove lines matching/,/^}/" build_and_run.sh)"
  remove_env_lines "^[[bad-regex"
' 2>&1 | tail -2
echo "exit=$?"
```
Expected: an `ERROR: Failed to filter .env (portable sed -i replacement) for pattern: ^[[bad-regex` line and nonzero exit.
Assertions:
- [ ] exit code is 1
- [ ] no `build_and_run.sh`-directory temp files remain: `ls .env.* 2>/dev/null | wc -l` prints `0`

#### 1.1.5 All-lines-filtered edge case is a success
```bash
cd "$REPO" && printf 'SECRET_KEY=\n' > /tmp/env-only-placeholder && cp /tmp/env-only-placeholder .env
bash -c '
  cd "'"$REPO"'" || exit 1
  eval "$(awk "/^# Remove lines matching/,/^}/" build_and_run.sh)"
  remove_env_lines "^SECRET_KEY=\$\|^SECRET_KEY=\"\"\$"
  echo "SECRET_KEY=regenerated" >> .env
'
cat .env   # expected: exactly one line: SECRET_KEY=regenerated
```
Assertions:
- [ ] exit 0 (grep's "no lines selected" must not trip `set -e`-style aborts)
- [ ] `.env` contains exactly the one generated line

## 2. Backwards Compatibility Tests

- [ ] **GNU/Linux output equivalence:** on a Linux box, run the 1.1.2 block against the pre-patch script (using its `sed -i` lines) and the patched script; the resulting `.env` files must be byte-identical apart from file permissions (see 2.1).
- [ ] **2.1 Documented exception - file mode:** after the patch, `.env` is `0600` (`mv` from mktemp) instead of the prior `0644`. Verify: `stat -f "%Lp" .env` (macOS) / `stat -c "%a" .env` (Linux) prints `600`. This is a deliberate, documented improvement for a secrets file.
- [ ] **Generation triggers unchanged:** with a `.env` that already has non-empty `SECRET_KEY=<hex>`, the block must not rewrite it: run 1.1.1 setup then `grep -q "^SECRET_KEY=[0-9a-f]" .env && echo untouched` - the real script's `grep -q` guard (line 342) must still select the "already exists" branch (`log "SECRET_KEY already exists in .env"`).
- [ ] **Script flags unchanged:** `bash build_and_run.sh --help` output identical to pre-patch (no flag or usage changes).
- [ ] **`source .env` still works:** `bash -c 'source .env && echo $SECRET_KEY'` after generation prints the generated value (shell sourcing is last-wins; unchanged).

## 3. UX Tests

- [ ] **Error message clarity:** trigger 1.1.4; the message must name the file (`.env`), the operation (portable `sed -i` replacement), and the pattern - sufficient for a developer to act without reading the source.
- [ ] **Happy-path logs unchanged:** on GNU, generation logs still read `Generating SECRET_KEY...` then `SECRET_KEY added to .env`; no new noise.
- [ ] **macOS happy path now truthful:** on macOS, after the fix the same happy-path logs appear AND the values are actually present (previously the logs lied). Verify each key per 1.1.2.

## 4. Deployment Surface Tests

### 4.1 Docker wiring
**Not Applicable** - no compose file, Dockerfile, or image content changes; `.env` is consumed as before.

### 4.2 Terraform / ECS wiring
**Not Applicable** - no Terraform variables or task definitions touched.

### 4.3 Helm / EKS wiring
**Not Applicable** - no chart values touched.

### 4.4 Deploy and verify
**Not Applicable** - developer-script change only.

### 4.5 Rollback verification
- [ ] `git checkout -- build_and_run.sh` restores pre-patch behavior exactly (single-file change; no data migration to undo; a `.env` generated by the patched script is consumed identically by the old script and vice versa).

## 5. End-to-End API Tests

- [ ] **E2E-1 macOS full stack (the issue's scenario):** on macOS, `cp .env.example .env && bash build_and_run.sh`. After the stack comes up:
  ```bash
  curl -sf http://localhost:8888/health
  docker compose ps auth-server
  ```
  Expected: auth-server `/health` returns 200 and the container does not restart-loop (`Restarting` count 0 over 60s). Pre-patch on macOS this crash-loops on the empty SECRET_KEY.
- [ ] **E2E-2 first-assignment consumer check:** after E2E-1, confirm compose saw real values:
  ```bash
  docker compose exec auth-server printenv SECRET_KEY | wc -c   # expected: 65 (64 hex + newline), not 1
  docker compose exec registry printenv AUTH_SERVER_NGINX_MARKER_SECRET | wc -c  # expected: 65
  ```
- [ ] **E2E-3 Linux parity:** repeat E2E-1 on GNU/Linux; stack healthy, values non-empty, logs match the macOS run.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes on BOTH macOS and Linux
- [ ] Section 2 (Backwards Compat) verified, including the documented 0600 mode exception
- [ ] Section 3 (UX) verified
- [ ] Section 4 (Deployment) marked Not Applicable with justification above
- [ ] Section 5 (E2E) verified on macOS (the failure environment) and Linux
- [ ] No stray temp files after runs (`ls .env.*` empty)
- [ ] Per skill constraints, this run designed but did NOT execute these tests against the target repo
