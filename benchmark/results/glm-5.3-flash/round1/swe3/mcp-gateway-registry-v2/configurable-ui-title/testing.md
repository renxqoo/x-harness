# Testing Plan: Configurable UI Title (UI_TITLE)

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verifies the full UI_TITLE pipeline: settings field + mode-aware derivation, `/api/config` payload, System Config panel entry, frontend rendering on four surfaces, and plumbing through Docker Compose, Terraform/ECS, and Helm. Emphasis on backwards compatibility: unset `UI_TITLE` must reproduce today's behavior everywhere.

### Prerequisites
- [ ] Registry running locally (compose: `docker compose up registry` from a copy of `.env.example` as `.env`)
- [ ] `jq` and `curl` available
- [ ] Admin credentials (Keycloak) for `/api/config/full`
- [ ] Frontend dev server (`cd frontend && npm start`) for UI checks, or a built image

### Shared Variables
```bash
export REGISTRY_URL="http://localhost"
export ADMIN_USER="admin"
export ADMIN_PASS="keycloak-admin-password"   # adjust for the deployment
```

## 1. Functional Tests

### 1.1 curl / HTTP Tests

**1.1.1 `GET /api/config` returns derived title in with-gateway mode (default)**

```bash
curl -s "$REGISTRY_URL/api/config" | jq '{deployment_mode, ui_title}'
# Expected:
# {
#   "deployment_mode": "with-gateway",
#   "ui_title": "AI Gateway & Registry"
# }
```
Assertions: status 200; `ui_title` key present; value exactly `AI Gateway & Registry`.

**1.1.2 `GET /api/config` returns derived title in registry-only mode**

```bash
DEPLOYMENT_MODE=registry-only docker compose up -d registry
sleep 5
curl -s "$REGISTRY_URL/api/config" | jq '{deployment_mode, ui_title}'
# Expected:
# {
#   "deployment_mode": "registry-only",
#   "ui_title": "AI Registry"
# }
```
Assertions: value exactly `AI Registry`. No-collateral check: every other key in the response is unchanged vs 1.1.1 (`diff <(curl -s ... | jq -S 'del(.ui_title)')` between the two runs).

**1.1.3 `GET /api/config` returns explicit UI_TITLE when set**

```bash
echo 'UI_TITLE=Acme AI Platform' >> .env
DEPLOYMENT_MODE=registry-only docker compose up -d registry
sleep 5
curl -s "$REGISTRY_URL/api/config" | jq .ui_title
# Expected: "Acme AI Platform"   (explicit value wins over the registry-only derived default)
```

**1.1.4 Blank UI_TITLE is treated as unset**

```bash
# Replace the value with an empty assignment, keep DEPLOYMENT_MODE=registry-only
sed -i.bak 's/^UI_TITLE=.*/UI_TITLE=/' .env && docker compose up -d registry
sleep 5
curl -s "$REGISTRY_URL/api/config" | jq .ui_title
# Expected: "AI Registry"
```

**1.1.5 `GET /api/config/full` shows the panel entries (admin)**

```bash
# Obtain a session via the Keycloak login flow (cookies.txt), then:
curl -s -b cookies.txt "$REGISTRY_URL/api/config/full" \
  | jq '.groups[] | select(.id=="deployment") | .fields[] | select(.key=="ui_title" or .key=="effective_ui_title")'
# Expected when UI_TITLE unset (with-gateway):
#   ui_title           -> value "(not set)", is_masked false
#   effective_ui_title -> value "AI Gateway & Registry", is_masked false
# Expected when UI_TITLE=Acme AI Platform:
#   ui_title           -> value "Acme AI Platform"
#   effective_ui_title -> value "Acme AI Platform"
```
Assertions: both entries present in the deployment group; `is_masked` is `false` for both (title is not a sensitive-pattern name).

Negative case: unauthenticated call to `/api/config/full` returns 401/403 (existing behavior; confirms no new public surface beyond `/api/config`).

### 1.2 CLI Tests
**Not Applicable** - the change adds no CLI command; configuration is via env vars and the existing HTTP endpoints.

## 2. Backwards Compatibility Tests

**2.1 Unset UI_TITLE, with-gateway: response diff vs pre-change build**

```bash
# Against the pre-change image and the post-change image, both with no UI_TITLE:
curl -s "$REGISTRY_URL/api/config" | jq -S 'del(.ui_title)' > new.json
# new.json must equal the pre-change capture byte-for-byte (sorted keys)
diff old.json new.json && echo "OK: no unintended key changes"
```

**2.2 Compose files without UI_TITLE in .env pass an empty var (containers start identically)**

```bash
grep -n "UI_TITLE" docker-compose.yml   # present: - UI_TITLE=${UI_TITLE:-}
docker compose config | grep -A1 "UI_TITLE"
# Expected: value is "" when unset; registry logs contain no title-related errors
```

**2.3 Frontend without the key (stale API) falls back**

```bash
# In frontend dev, mock a legacy /api/config response missing ui_title:
# Layout/Login/Logout/UptimeDisplay must render "AI Gateway & Registry" (current behavior).
```
Also covered by unit test: hook default `ui_title: 'AI Gateway & Registry'` in `frontend/src/hooks/__tests__/` (if the harness runs jest).

**2.4 Helm: default values render no UI_TITLE env**

```bash
helm template test charts/registry -s templates/deployment.yaml \
  | grep -c "UI_TITLE"
# Expected: 0 (entry is conditional on app.uiTitle); the reserved-name list in
# _helpers.tpl is a template comment/define and does not emit env entries.
```

**2.5 Terraform: default var produces no task-definition diff**

```bash
cd terraform/aws-ecs && terraform plan 2>/dev/null | grep "UI_TITLE"
# Expected: no output (ui_title defaults to "", env entry not emitted)
```

## 3. UX Tests

**3.1 Header title (Layout)**

- Open `$REGISTRY_URL` logged in.
- Default with-gateway: header shows `AI Gateway & Registry` (unchanged).
- `UI_TITLE=Acme AI Platform`: header shows `Acme AI Platform` after load.
- Registry-only, unset: header shows `AI Registry`.

**3.2 Login page**

- Sign out; visit `/login`.
- Heading reads `Sign in to <effective title>` for each of the three cases above.

**3.3 Logout page**

- Trigger logout; the confirmation card footer reads `<effective title> - Secure Access Management`.

**3.4 Uptime tooltip**

- Hover the Uptime badge in the header; tooltip heading shows `<effective title>`.

**3.5 System Config panel**

- Open Settings -> System Config; Deployment group lists `UI Title` and `UI Title (Effective)` with the values from 1.1.5; neither is masked.

**3.6 Special characters survive rendering (no XSS / no truncation)**

```bash
echo 'UI_TITLE=R&D "Alpha" <Lab>' >> .env && docker compose up -d registry
```
- Header renders the literal string `R&D "Alpha" <Lab>` (React-escaped), no HTML injection, no layout crash.
- Pre-first-render browser tab title remains the static default (out of scope by design; observation only).

## 4. Deployment Surface Tests

### 4.1 Docker wiring

```bash
grep -n "UI_TITLE" .env.example docker-compose.yml docker-compose.prebuilt.yml docker-compose.podman.yml
# Expected: doc block in .env.example; one pass-through line per compose file
UI_TITLE=Acme docker compose -f docker-compose.prebuilt.yml up -d registry
docker compose -f docker-compose.prebuilt.yml exec registry printenv UI_TITLE
# Expected: Acme
```

### 4.2 Terraform / ECS wiring

```bash
grep -n "ui_title" terraform/aws-ecs/variables.tf \
  terraform/aws-ecs/main.tf \
  terraform/aws-ecs/modules/mcp-gateway/variables.tf \
  terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf \
  terraform/aws-ecs/terraform.tfvars.example
# Expected: root var, module pass-through, module var, conditional env entry, doc example
cd terraform/aws-ecs && terraform validate
# Uncomment ui_title in a tfvars copy and plan: task definition gains UI_TITLE env
```

### 4.3 Helm / EKS wiring

```bash
helm template test charts/registry --set app.uiTitle="Acme" -s templates/deployment.yaml \
  | grep -A1 "name: UI_TITLE"
# Expected:
#   name: UI_TITLE
#   value: "Acme"

cd charts/registry && helm unittest .   # runs extra_env_test.yaml incl. new UI_TITLE cases
```

### 4.4 Deploy and verify
- Compose: covered by 1.1.x.
- ECS: `terraform apply` with `ui_title` set; task definition shows `UI_TITLE`; `/api/config` returns it.
- Helm: `helm upgrade --install` with `--set app.uiTitle`; pod env contains `UI_TITLE`; `/api/config` returns it.

### 4.5 Rollback verification
- Remove `UI_TITLE` from `.env` / tfvars / values, redeploy: title reverts to the mode-derived default; no other behavior change; pods restart cleanly (env-var-only change).

## 5. End-to-End API Tests

**5.1 Operator rebrand journey (compose)**

```bash
# 1. Fresh clone + cp .env.example .env; docker compose up -d registry
# 2. UI header shows "AI Gateway & Registry" (derived, with-gateway default)
# 3. echo 'DEPLOYMENT_MODE=registry-only' >> .env; docker compose up -d registry
# 4. curl /api/config | jq .ui_title   -> "AI Registry"; header shows "AI Registry"
# 5. echo 'UI_TITLE=Acme AI Platform' >> .env; docker compose up -d registry
# 6. curl /api/config | jq .ui_title   -> "Acme AI Platform"; header + login page show it
# 7. System Config panel shows UI Title = Acme AI Platform, UI Title (Effective) = Acme AI Platform
# 8. Remove UI_TITLE; restart; back to "AI Registry" (mode-derived)
```

**5.2 No-rebuild requirement proof**

- With the same frontend image/bundle: switch `UI_TITLE` between two brands and restart only the registry backend. The UI picks up both values without `npm run build` or a new frontend image. (This is the core acceptance difference vs a build-time approach.)

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E) verified or marked Not Applicable
- [ ] Unit tests added under `tests/unit/core/test_config.py` (effective_ui_title: explicit, derived both modes, blank-string)
- [ ] Unit tests added under `tests/unit/api/test_config_routes_title.py` (/api/config key; /api/config/full deployment-group entries)
- [ ] `charts/registry` helm unittest suite updated and passing (UI_TITLE absent/present/reserved cases)
- [ ] `uv run pytest tests/unit/core/test_config.py tests/unit/api/` passes with no regressions
