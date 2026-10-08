# Implementation Summary: Honour MCP_CLOUD_PROVIDER override in the UI telemetry-detection endpoint

*Created: 2026-09-29*
*Baseline ref: `1.24.7` (commit `dbaa153487a878317ceadae7a63cc18ad3ff1593`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed

`GET /api/system/telemetry-detection` - the display path behind the admin UI's Uptime tooltip `Deployment -> Cloud` row - now resolves the cloud value through `_resolve_cloud()` (the same resolver telemetry events use) instead of calling the raw auto-detection cascade directly. The `MCP_CLOUD_PROVIDER` operator override (method `explicit`) and the registry-card operator hint (`operator_declared` / `operator_declined`) now take precedence; when neither applies, the endpoint falls through to the unchanged detection cascade, so pre-override behaviour is preserved. Two regression unit tests cover the override-set and override-unset cases.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `registry/api/system_routes.py` | modified | +10 / -4 | `get_telemetry_detection_info` now awaits `_resolve_cloud()`; docstring widened to the resolved cloud/method sets |
| `tests/unit/test_stats_endpoint.py` | modified | +92 / -0 | New `TestTelemetryDetectionEndpoint`: override-set returns `(override, explicit)` despite a cascade stubbed to `aws/env`; override-unset falls through to a sentinel cascade result `(gcp, dmi)`; both stub settings + hint tier + cascade together |

## How to Apply

```bash
git clone --branch 1.24.7 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

Verified: `git apply --check` passes against a pristine worktree at `dbaa153487a878317ceadae7a63cc18ad3ff1593` (tag `1.24.7`).

## Deviations from the LLD

None - implemented exactly as designed (LLD revised post-review; the review's should-fix item, stubbing all three resolver inputs in the tests, is reflected in the patch).

## Not Implemented / Follow-ups

None from the LLD. One out-of-scope cosmetic suggestion noted in review.md (Pixel): the tooltip title "Detected via explicit" could someday read "Set via MCP_CLOUD_PROVIDER"; that is a frontend change deliberately excluded here.

## Verification (not executed)

Testing plan lives in `./testing.md`; the two regression unit tests ship inside `patch.diff` but were not run, per skill constraints (no execution of the target repo). A reviewer applies the patch and runs:

```bash
uv run pytest tests/unit/test_stats_endpoint.py -k telemetry -q
```
