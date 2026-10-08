# GitHub Issue: build_and_run.sh: make .env secret generation portable to BSD/macOS sed

*Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/1577*

## Title
build_and_run.sh: `sed -i` used to strip empty .env placeholders silently fails on BSD/macOS, leaving empty generated secrets

## Labels
- bug
- portability
- developer-experience
- security-adjacent

## Description

### Problem Statement
`build_and_run.sh` generates several required secrets into `.env` (SECRET_KEY, AUTH_SERVER_NGINX_MARKER_SECRET, DOCUMENTDB_PASSWORD, METRICS_KEY_PEPPER, OPENBAO_TOKEN, plus the per-service METRICS_API_KEY_* tokens). To replace the shipped empty placeholder line, each block runs:

```bash
sed -i '/^SECRET_KEY=$/d' .env 2>/dev/null || true
sed -i '/^SECRET_KEY=""$/d' .env 2>/dev/null || true
```

GNU sed accepts this form. BSD sed (macOS and other BSD userlands) treats the argument after `-i` as a mandatory backup suffix, so the command errors out, the error is swallowed by `2>/dev/null || true`, and the empty placeholder survives. The script then appends the real value below it, so `.env` contains two assignments for the same key:

```
SECRET_KEY=
SECRET_KEY=<64 hex chars>
```

Consumers that take the first assignment (notably Docker Compose env_file / `${VAR}` interpolation, which reads the file as key=value lines rather than sourcing it) see the empty placeholder. The script logs "SECRET_KEY added to .env" even though the effective value is empty, and the auth server then crash-loops on a missing secret. The failure is specific to macOS-style userlands, which makes it hard to notice from a Linux CI.

### Proposed Solution
Replace every bare `sed -i '<expr>' .env` deletion in `build_and_run.sh` with a portable helper that rewrites the file without relying on in-place `sed -i` semantics (filter through `grep -v` into a `mktemp` sibling temp file, then `mv` over the original, both POSIX-portable on GNU and BSD userlands). Collapse each secret's two placeholder deletions into one helper call. Remove the `2>/dev/null || true` silencing so a failed edit aborts the script with a clear error instead of leaving an empty placeholder behind.

### User Stories
- As a developer running the project's build script on macOS, I want generated secrets to actually land in `.env` so that the stack starts instead of the auth server crash-looping on empty secrets.
- As a developer on Linux, I want the behavior to remain compatible so nothing changes on GNU userlands.
- As an operator, I want a failed `.env` rewrite to stop the build with an explicit error rather than silently producing an unusable configuration.

### Acceptance Criteria
- [ ] `build_and_run.sh` contains no bare `sed -i '<expr>' .env` deletion; the pattern is fixed at every site (all five generated secrets AND the per-service metrics token loop), not only the most visible one.
- [ ] Secret generation works identically on GNU and BSD userlands; empty placeholder lines are removed before the real value is appended, leaving a single assignment per key.
- [ ] A failed `.env` rewrite is loud: the script exits nonzero with an actionable error message, and no partial temp file is left behind.
- [ ] Operator-provided non-empty secrets are still left untouched (generation only fires when the value is missing or empty).
- [ ] No new dependencies beyond what the script already requires (bash, grep, mktemp); stays compatible with the bash 3.2 shipped on macOS.
- [ ] Linux behavior is unchanged: on a GNU userland the resulting `.env` after generation is equivalent to the previous implementation's output.

### Out of Scope
- Other `sed -i` uses in the repository that already pass an explicit backup suffix (`terraform/telemetry-collector/deploy.sh` uses `sed -i.bak`), or that run inside Linux containers where GNU semantics are guaranteed (`docker/registry-entrypoint.sh`, `keycloak/setup/clean-keycloak.sh`). A repo-wide `sed -i` portability audit is a separate issue.
- Changing which secrets are generated, their entropy, or the weak-value validation that follows.
- Changing how `.env.example` placeholders are shipped or documented.
- Adding CI coverage for BSD userlands (suggested follow-up).

### Dependencies
- None. The fix uses only tools the script already depends on.

### Related Issues
- #1577
