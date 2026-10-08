# Implementation Summary: Pass SSRF allowlist env vars to the registry container in every compose file

*Created: 2026-09-30*
*Baseline ref: `1.27.1` (commit `5f725c1d1d1a3515840b17e29a2b7f22a0c1fd09`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
Added the `SSRF_ALLOWED_HOSTS` and `SSRF_ALLOWED_CIDRS` environment passthrough (with the same explanatory comment used in the default `docker-compose.yml`) to the registry service in `docker-compose.podman.yml` and `docker-compose.prebuilt.yml`. Setting either variable in `.env` now reaches the registry container on every compose deployment that starts the registry, so internal docker-network upstreams can be allowlisted without hand-editing compose files.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `docker-compose.podman.yml` | modified | +7 / -0 | Comment block + two env entries inserted after `- REGISTRY_CONTACT_URL=`, before `- SECRET_KEY=` in the registry service |
| `docker-compose.prebuilt.yml` | modified | +7 / -0 | Same insertion; the `# BUILD_VERSION is NOT set here...` comment remains intact between the new entries and `- SECRET_KEY=` |

## How to Apply

```bash
git clone --branch 1.27.1 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

## Deviations from the LLD
None - implemented exactly as designed (`lld.md` Implementation Details Steps 1-2; the LLD already incorporated the review's anchor-pinning should-fix items).

## Not Implemented / Follow-ups
- None from the LLD. (Out-of-scope by design: SSRF guard logic, Helm chart, Terraform/ECS, docs, and `docker-compose.dhi.yml` - the last because it defines no `registry` service and inherits env from the base file.)
- SMTS follow-up suggestion (not part of this patch): an upstream test asserting the three compose files' registry env key sets match.

## Verification (not executed)
Tests were designed but not run, per skill constraints. The verification steps are in `testing.md`: `docker compose config` rendering for all three files plus the DHI combination, in-container `env` checks, and the end-to-end internal-upstream registration scenario from the issue. Static checks done instead: the inserted block is byte-identical to the template at `docker-compose.yml:202-207`, and `patch.diff` passes `git apply --check` against a fresh checkout of `5f725c1d`.
