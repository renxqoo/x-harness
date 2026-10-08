# GitHub Issue: UI telemetry-detection endpoint ignores MCP_CLOUD_PROVIDER operator override

## Title

`/api/system/telemetry-detection` reports the raw auto-detection result instead of the resolved cloud value that honours `MCP_CLOUD_PROVIDER`

## Labels

- bug
- ui
- telemetry
- operator-experience

## Description

### Problem Statement

The admin UI's Uptime tooltip shows the `Deployment -> Cloud` row sourced from `GET /api/system/telemetry-detection`. That endpoint calls the raw cloud-detection cascade (`_detect_cloud_provider_with_method()`), whose first tier returns `aws` whenever `AWS_REGION` or `AWS_DEFAULT_REGION` is set. Because `.env.example` ships `AWS_REGION=us-east-1`, virtually every local (on-premises) install is misclassified as `aws (via env)` in the UI.

Meanwhile the operator override `MCP_CLOUD_PROVIDER` (allowed values: `aws|azure|gcp|on_premises|other`) already exists and telemetry EVENTS already honour it: on an override-set install, telemetry reports `on_premises (method=explicit)`. The UI does not, because the endpoint it reads never applies the override.

Result: the UI and the telemetry events disagree about the same deployment, and operators running outside AWS see a wrong cloud label in the UI that the documented override does not correct.

### Proposed Solution

Make the UI display path resolve the cloud value the same way telemetry events do. Replace the endpoint's call to the raw cascade (`_detect_cloud_provider_with_method()`) with a call to the existing resolver (`_resolve_cloud()`), which applies, in priority order:

1. `MCP_CLOUD_PROVIDER` env override -> method `explicit`
2. Registry card operator hint (`on_premises`/`other` -> `operator_declared`; `declined` -> `unknown`/`operator_declined`)
3. The existing auto-detection cascade (unchanged fall-through)

When the override is unset and no hint is set, the endpoint returns exactly what it returned before, so the change is fully backwards compatible.

### User Stories

- As an operator running the registry on-premises, I want the UI's Cloud display to show `on_premises (via explicit)` after I set `MCP_CLOUD_PROVIDER=on_premises` so that the UI agrees with reality and with the telemetry events.
- As an operator reading deployment telemetry, I want the UI and the telemetry events to report the same cloud value so that dashboards and screenshots are consistent.
- As a developer with `AWS_REGION` set in my local `.env`, I want the documented override to actually change what the UI shows so that I am not misclassified as AWS.

### Acceptance Criteria

- [ ] `GET /api/system/telemetry-detection` returns `{"cloud": "<override>", "cloud_detection_method": "explicit"}` when `MCP_CLOUD_PROVIDER` is set to a valid value, regardless of what the auto-detection cascade would return.
- [ ] When `MCP_CLOUD_PROVIDER` is unset (or set to an invalid value, which the settings validator already coerces to unset), the endpoint falls through to the existing auto-detection cascade and returns the same `cloud` / `cloud_detection_method` pair as before this change.
- [ ] The UI (Uptime tooltip `Deployment -> Cloud`) therefore shows the same cloud string the telemetry events report.
- [ ] A regression test covers the override-set case (override wins over cascade) and the override-unset case (cascade fall-through preserved).
- [ ] No changes to the response schema: the endpoint still returns exactly the two keys `cloud` and `cloud_detection_method`.
- [ ] Authentication behaviour is unchanged: unauthenticated callers still receive 401.

### Out of Scope

- Changing the detection cascade itself (`_detect_cloud_from_env` and friends).
- Changing the telemetry event payloads or the collector schema.
- Changing the frontend component (`UptimeDisplay.tsx`): it already renders whatever `cloud` / `cloud_detection_method` the endpoint returns.
- Changing the banner-state endpoint (`GET /api/registry/banner-state`), which already uses the resolved value.
- Any new configuration parameter or deployment-surface change.

### Dependencies

- None. The resolver `_resolve_cloud()` already exists in `registry/core/telemetry.py`.

### Related Issues

- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/1306
- Related prior work: `MCP_CLOUD_PROVIDER` override introduction (issue #1120), cloud-provider banner and operator hint.
