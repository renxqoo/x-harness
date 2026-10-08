# GitHub Issue: Hide the header Register button on the Virtual MCP Servers and Agent Skills tabs

## Title
Dashboard: show the header Register button only on tabs where registration is the right action

## Labels
- bug
- frontend
- ux

## Description

### Problem Statement
The dashboard header renders a global "Register" button in the search bar row on every tab except Discover. On the Virtual MCP Servers tab and the Agent Skills tab this button competes with each tab's own action button ("Add Virtual Server" and "Add Skill" respectively), and it opens the server registration form, which is not the action the user is looking for on those tabs. Users on those tabs see two competing "add" buttons, and the more prominent header one leads to the wrong form.

### Proposed Solution
Narrow the render condition of the header Register button in `frontend/src/pages/Dashboard.tsx` so it is rendered only on the tabs where registration is the relevant action: the MCP Servers tab and the Agents tab. The button must not be removed globally and the registration flow it opens (the in-page Register New Server modal) must remain untouched. On the Virtual MCP Servers tab, the Agent Skills tab, and the External Registries tab, the button is no longer rendered; each of those tabs keeps (or simply does not need) its own tab-specific actions.

### User Stories
- As a dashboard user on the Virtual MCP Servers tab, I want to see only the "Add Virtual Server" action so that I am not tempted by a Register button that opens an unrelated server registration form.
- As a dashboard user on the Agent Skills tab, I want to see only the "Add Skill" action so that the tab's own affordance is unambiguous.
- As a dashboard user on the MCP Servers or Agents tab, I want the header Register button to stay where it is so that I can register a new server or agent as before.

### Acceptance Criteria
- [ ] On the MCP Servers tab the header Register button is still rendered and still opens the Register New Server modal.
- [ ] On the Agents tab the header Register button is still rendered and still opens the Register New Server modal.
- [ ] On the Virtual MCP Servers tab the header Register button is not rendered; the "Add Virtual Server" button is unchanged.
- [ ] On the Agent Skills tab the header Register button is not rendered; the "Add Skill" button is unchanged.
- [ ] The Discover tab continues to render neither the search row nor the Register button.
- [ ] The registration flow itself is unchanged: the modal opens, submits, and closes exactly as before.
- [ ] No other header controls (search input, Refresh Health) change visibility.

### Out of Scope
- Removing or redesigning the Register button or the Register New Server modal.
- Changing the "Add Virtual Server" or "Add Skill" buttons, their permissions, or their navigation targets.
- Changing the RegisterPage routes or any backend registration API.
- Changes to the External Registries tab's content or federation features.
- Introducing a new feature flag or configuration parameter for the button visibility.

### Dependencies
- None. This is a frontend-only render-condition change with no new dependencies.

### Related Issues
- Reference: https://github.com/agentic-community/mcp-gateway-registry/issues/793
