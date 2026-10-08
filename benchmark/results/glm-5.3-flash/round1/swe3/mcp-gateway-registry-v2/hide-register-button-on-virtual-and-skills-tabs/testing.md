# Testing Plan: Show the header Register button only on the MCP Servers and Agents tabs

*Created: 2026-09-30*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
Verify that the dashboard header Register button renders on exactly the MCP Servers and Agents tabs, is absent on the Virtual MCP Servers, Agent Skills, and External Registries tabs, and that the registration flow and every other header control behave exactly as before on all tabs.

### Prerequisites
- [ ] Gateway registry stack running locally (frontend + registry API), e.g. via `docker-compose.yml` or the dev servers
- [ ] A logged-in user that can view the dashboard; for full flow tests, a user with `can_modify_servers` (admin is fine)
- [ ] Registry config with default features enabled (mcp_servers, agents, skills, federation all on) so every tab renders

### Shared Variables

```bash
# Adjust if your stack runs elsewhere
export DASHBOARD_URL="http://localhost:7860"
# Browser: any current Chrome/Firefox. No API tokens are needed; tests run in an
# authenticated browser session against the dashboard UI.
```

Manual checks are executed as a per-tab matrix (Sections 1-3): for each tab, click its tab button at the top of the dashboard and inspect the search bar row. Automated checks (Section 5) run the optional jest unit test.

## 1. Functional Tests

### 1.1 Header Register button visibility matrix (UI)

For each row: click the tab, then inspect the search bar row between the search input and "Refresh Health".

| # | Tab (click) | Expected: Register button | Expected: tab-specific action |
|---|-------------|---------------------------|-------------------------------|
| 1.1.1 | MCP Servers | Present (`+ Register`, `btn-primary`) | none in header; empty-state "Register Server" CTA only when list is empty |
| 1.1.2 | Agents | Present (`+ Register`) | none in header |
| 1.1.3 | Virtual MCP Servers | **Absent** | "Add Virtual Server" (teal) present for permitted users |
| 1.1.4 | Agent Skills | **Absent** | "Add Skill" (amber) present for permitted users |
| 1.1.5 | External Registries | **Absent** | none |
| 1.1.6 | Discover | Not applicable (whole search row hidden, as before) | Discover layout |

```text
Steps (per row):
1. Open $DASHBOARD_URL and log in.
2. Click the tab named in the row.
3. In the search row, look for a button labeled "Register" with a plus icon.
4. Assert presence/absence per the table.
5. On rows 1.1.3/1.1.4, also assert the tab-specific button renders exactly once.
```

Assertions:
- Row 1.1.3: `page` contains exactly one element matching `button:has-text("Add Virtual Server")` and zero matching `button:has-text("Register")` in the search row.
- Row 1.1.4: same shape with `button:has-text("Add Skill")`.

### 1.2 Register button still opens the registration modal (UI)

```text
Steps:
1. Go to the MCP Servers tab.
2. Click the header "Register" button.
3. Assert the "Register New Server" modal opens with Name / Path / Proxy Pass URL fields.
4. Close it (Cancel or Escape). Repeat on the Agents tab; assert the same modal opens.
```

Expected: modal opens on both tabs exactly as before the change. No other tab offers the header button anymore.

Negative case: on Virtual MCP Servers and Agent Skills tabs there is no header button to click; the only add actions are the tab-specific ones, which must NOT open the server registration modal ("Add Skill" opens the Register/Edit Skill modal; "Add Virtual Server" navigates to `/settings/virtual-mcp/servers`).

## 2. Backwards Compatibility Tests

- [ ] **2.1** MCP Servers tab: header Register click path to the modal is identical to pre-change behavior (opens, submits, closes; success toast unchanged).
- [ ] **2.2** Agents tab: same as 2.1.
- [ ] **2.3** Search input and "Refresh Health" render and function on ALL non-discover tabs, including virtual/skills (unchanged).
- [ ] **2.4** Discover tab: search row (including Register and Refresh Health) still hidden, as before.
- [ ] **2.5** Direct navigation to `/register` still works (RegisterPage route untouched).
- [ ] **2.6** The servers empty-state "Register Server" CTA and the skills empty-state "Register Skill" CTA still render and work (they were intentionally not modified).
- [ ] **2.7** Register modal Escape-key close still works (Dashboard.tsx:785 handler untouched).

## 3. UX Tests

- [ ] **3.1** On the Virtual MCP Servers tab, the only "add" affordance in the content header area is "Add Virtual Server"; no competing Register button. Layout of the search row (input left, Refresh Health right) has no unexpected gap shift.
- [ ] **3.2** On the Agent Skills tab, same check with "Add Skill".
- [ ] **3.3** Tab-switch sweep: servers -> agents -> virtual -> skills -> external -> servers; the header button appears exactly on servers/agents each time, with no stale rendering or console errors.
- [ ] **3.4** Modal continuity: open the Register modal on the servers tab, switch to another tab while it is open (possible pre-change), confirm behavior is unchanged (no crash; modal state unaffected by this patch).
- [ ] **3.5** Restricted user (no `can_modify_servers`): on virtual/skills tabs they see no add buttons (pre-existing); on servers/agents the header Register still appears for them exactly as pre-change (this patch adds no permission gating).

## 4. Deployment Surface Tests

### 4.1 Docker wiring
**Not Applicable** - no configuration parameter, image, compose file, or environment variable changed; the frontend image build picks up the source change automatically.

### 4.2 Terraform / ECS wiring
**Not Applicable** - no Terraform variables or task definitions touched.

### 4.3 Helm / EKS wiring
**Not Applicable** - no chart values touched.

### 4.4 Deploy and verify
- [ ] Rebuild the frontend (standard CRA build) and confirm the tab matrix in Section 1.1 on the deployed build. No other deployment step exists for this change.

### 4.5 Rollback verification
- [ ] Re-applying the inverse of `patch.diff` (or reverting the commit) restores the button on all tabs; verify row 1.1.3 again after rollback.

## 5. End-to-End API Tests

**Unit/e2e automation (optional, in the repo's existing jest + React Testing Library setup):**

Add `frontend/src/components/__tests__/Dashboard.test.tsx` (see LLD Step 2): mock `useAuth`, `useServerStats`, `useSkills`, `useRegistryConfig`, `useSemanticSearch`, `useVirtualServers`, `useVirtualServer`, and `axios`; set `registryConfig.features` all-enabled; render with `viewFilter` forced to each value and assert:

```ts
// shape of the assertion per tab
expect(screen.queryByRole('button', { name: /register/i })).toBeInTheDocument(); // servers, agents
expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument(); // virtual, skills, external
```

If the hook-mock surface proves brittle, skip this automated test; the manual matrix in Section 1.1 is the authoritative check for this change.

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes
- [ ] Section 2 (Backwards Compat) verified or marked Not Applicable
- [ ] Section 3 (UX) verified or marked Not Applicable
- [ ] Section 4 (Deployment) verified or marked Not Applicable
- [ ] Section 5 (E2E/automated) verified or explicitly skipped with the manual matrix as authority
- [ ] No regressions in existing frontend tests: `cd frontend && npm test` (execution is out of scope for the swe3 run itself; a human implementer runs this)
