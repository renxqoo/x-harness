# Low-Level Design: Show the header Register button only on the MCP Servers and Agents tabs

*Created: 2026-09-30*
*Author: Claude (swe3 single-agent run)*
*Status: Draft (revised after expert review)*

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

## Overview

### Problem Statement
In the dashboard (`frontend/src/pages/Dashboard.tsx`), the search bar row renders a global "Register" button on every tab except Discover (`viewFilter !== 'discover'` guards the whole row; the Register button itself has no additional condition). On the Virtual MCP Servers tab this sits next to the tab's own "Add Virtual Server" button, and on the Agent Skills tab next to "Add Skill". The header button opens the server/agent registration modal, which is not the action a user on those tabs is looking for. Two competing "add" buttons create ambiguity, and the more prominent header one leads to the wrong form.

### Goals
- Render the header Register button only where registration is the relevant action: the MCP Servers tab (`viewFilter === 'servers'`) and the Agents tab (`viewFilter === 'agents'`).
- Keep the button, its handler, and the entire registration flow exactly as they are on those tabs.
- Keep the tab-specific actions ("Add Virtual Server", "Add Skill") untouched.
- Minimal, surgical change: one narrowed JSX render condition.

### Non-Goals
- Removing the Register button or the registration modal anywhere.
- Changing permissions on any add/register action.
- Changing the External Registries tab content (it simply loses the header Register button, which never applied there).
- Any backend, API, routing, or configuration change.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `frontend/src/pages/Dashboard.tsx` | The dashboard page: tabs, search row, per-tab sections, modals | Contains the header Register button (lines 2410-2416) and the row guard `viewFilter !== 'discover'` (line 2378) |
| `frontend/src/pages/Dashboard.tsx:202` | `viewFilter` state declaration | Type is `'discover' | 'servers' | 'agents' | 'skills' | 'virtual' | 'external'`, default `'discover'` |
| `frontend/src/pages/Dashboard.tsx:2092-2107` | Virtual MCP Servers section | Own action button "Add Virtual Server" (teal), gated on `user?.can_modify_servers || user?.is_admin` |
| `frontend/src/pages/Dashboard.tsx:2019-2033` | Agent Skills section | Own action button "Add Skill" (amber), gated on `user?.can_modify_servers` |
| `frontend/src/pages/Dashboard.tsx:1386` | `handleRegisterServer` | Opens the in-page Register New Server modal (`setShowRegisterModal(true)`); unchanged |
| `frontend/src/pages/Dashboard.tsx:2534` | Register Server Modal render | Gated on `showRegisterModal`; unchanged |
| `frontend/src/components/__tests__/` | Existing frontend tests (jest + React Testing Library) | Convention reference for the optional unit test |

### Existing Patterns Identified
1. **Tab-conditional JSX blocks**: per-tab sections are guarded inline with `(viewFilter === 'servers') && (...)` etc. (lines 1497, 1777, 2019, 2092, 2154).
   - Files: `frontend/src/pages/Dashboard.tsx`
   - How a future implementer should follow this: express the narrowed button condition in the same inline `&&` style rather than introducing helper components or flags.
2. **Feature gating with `registryConfig?.features.*`**: tab visibility itself is gated on registry config (e.g. MCP Servers tab hidden when `features.mcp_servers === false`, line 2318).
   - How a future implementer should follow this: the Register button condition does NOT need config gating beyond the tab condition, because the modal it opens is the same modal reachable from the servers/agents empty states today.
3. **Permission gating on add actions**: tab-specific add buttons check `user?.can_modify_servers` / `user?.is_admin`.
   - Note: the header Register button has never had a permission gate; this change does not add or remove permission logic (deliberate scope limit, see Alternatives).

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `handleRegisterServer` | Uses (unchanged) | The button's `onClick`; opens `showRegisterModal` |
| Register Server Modal | Depends on (unchanged) | Opened only via `showRegisterModal` state; still reachable from servers/agents tabs |
| Tab bar `handleChangeViewFilter` | Uses (unchanged) | `viewFilter` is the sole input to the new condition |

### Constraints and Limitations Discovered
- The search row (search input + Register + Refresh Health) is shared across five tabs; only the Register button must vary per tab. Wrapping the button, not the row, keeps the change minimal.
- `viewFilter === 'discover'` hides the entire row already; the new condition only needs to distinguish servers/agents from virtual/skills/external.
- The empty-state "Register Server" buttons inside the servers section (line 1582) and "Register Skill" in the skills section (line 2054) are separate, tab-scoped CTA buttons and are out of scope.

## Architecture

### System Context Diagram

```
                ┌──────────────────────────────────────────────┐
                │                  Dashboard                   │
                │  viewFilter ∈ {discover, servers, agents,    │
                │                skills, virtual, external}    │
                └───────────────┬──────────────────────────────┘
                                │ renders
        ┌───────────────────────┼─────────────────────────────┐
        ▼                       ▼                             ▼
┌─────────────────┐   ┌──────────────────────┐   ┌────────────────────────┐
│ Tab bar         │   │ Search row (non-     │   │ Per-tab content        │
│ (5 tabs)        │   │ discover tabs):      │   │ servers/agents: cards  │
│                 │   │  [search] [Register] │   │ virtual: +Add Virtual  │
│                 │   │  [Refresh Health]    │   │ skills:  +Add Skill    │
└─────────────────┘   └──────────┬───────────┘   └────────────────────────┘
                                 │ onClick
                                 ▼
                   ┌───────────────────────────┐
                   │ handleRegisterServer →    │
                   │ Register New Server modal │
                   └───────────────────────────┘
```

### Sequence Diagram

```
User            Dashboard          State
 │  click tab      │                 │
 │────────────────►│ handleChangeViewFilter('virtual')
 │                 │────────────────►│ viewFilter = 'virtual'
 │                 │  re-render      │
 │                 │◄────────────────│
 │  sees row:      │                 │
 │  [search][Refresh Health]         │   (no Register button)
 │                 │                 │
 │  click "Add Virtual Server"       │
 │────────────────►│ navigate('/settings/virtual-mcp/servers')
```

On `servers`/`agents` the flow is unchanged: Register visible → `handleRegisterServer` → `showRegisterModal = true` → modal renders → submit/cancel as before.

### Component Diagram

```
Dashboard.tsx
├── Tab bar (unchanged)
├── Search row (viewFilter !== 'discover')
│   ├── Search input (unchanged)
│   ├── Register button        ← NEW CONDITION: viewFilter === 'servers' || viewFilter === 'agents'
│   └── Refresh Health button (unchanged)
├── Section: servers (unchanged, incl. its own empty-state Register Server CTA)
├── Section: agents (unchanged)
├── Section: skills (unchanged, "Add Skill" button)
├── Section: virtual (unchanged, "Add Virtual Server" button)
├── Section: external (unchanged)
└── Register Server Modal (unchanged)
```

## Data Models

No data model changes. `viewFilter`'s existing union type is reused as-is.

## API / CLI Design

**Not Applicable** - this is a UI render-condition change. No endpoints, commands, or request/response shapes are added or modified.

## Configuration Parameters

### New Environment Variables

None. This change introduces no configuration. Button visibility is a pure function of the existing `viewFilter` state.

### Deployment Surface Checklist

- [ ] `.env.example`: no change required
- [ ] `docker-compose.yml`: no change required
- [ ] Terraform/Helm: no change required

## New Dependencies

This change uses only existing dependencies.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: Narrow the Register button render condition
**File:** `frontend/src/pages/Dashboard.tsx`
**Lines:** 2410-2416 (the header Register `<button>` in the search row)

Wrap the existing button in an inline conditional so it renders only on the registration-relevant tabs:

```tsx
{(viewFilter === 'servers' || viewFilter === 'agents') && (
  <button
    onClick={handleRegisterServer}
    className="btn-primary flex items-center space-x-2 flex-shrink-0"
  >
    <PlusIcon className="h-4 w-4" />
    <span>Register</span>
  </button>
)}
```

That is the entire code change. The button element itself (className, icon, label, `onClick`) is byte-for-byte identical to the current one; only its render condition is added.

#### Step 2 (optional, recommended by review): unit test the condition
**File:** `frontend/src/components/__tests__/Dashboard.test.tsx` (new)

A lightweight jest + React Testing Library test that renders `Dashboard` with `viewFilter` on each tab and asserts button presence/absence. This requires mocking the hooks Dashboard imports (`useAuth`, `useServerStats`, `useSkills`, `useRegistryConfig`, `useSemanticSearch`, `useVirtualServers`, `useVirtualServer`) and `axios`, following the mock style of the existing `DiscoverTab.test.tsx`. If the mock surface proves too brittle, the test may be skipped without weakening the implementation (the behavior is a two-token JSX condition).

### Error Handling
No new error paths. The button's behavior on servers/agents tabs is unchanged; on other tabs the button simply does not exist, so there is nothing to handle.

### Logging
No logging changes. The component has no per-render logging today and none is warranted for a render-condition change.

## Observability

**Not Applicable** - no runtime behavior beyond DOM visibility changes; no metrics, traces, or logs are added.

## Scaling Considerations

**Not Applicable** - pure client-side render condition; no load, caching, or scaling implications.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `frontend/src/components/__tests__/Dashboard.test.tsx` | (Optional) unit test asserting Register button visibility per tab |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `frontend/src/pages/Dashboard.tsx` | ~2410 | Wrap header Register button in `(viewFilter === 'servers' || viewFilter === 'agents') && (...)` |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~3 (condition + wrapper) |
| New tests | ~0-80 (optional unit test) |
| Modified code | ~4 (re-indent button JSX) |
| **Total** | **~7 (+ optional test)** |

## Testing Strategy

See `./testing.md` for the full plan: manual per-tab UI checks, backwards-compat checks on the servers/agents registration flow, and an optional jest unit test.

## Alternatives Considered

### Alternative 1: Hide the whole search row on virtual/skills tabs
**Description:** Change the row guard from `viewFilter !== 'discover'` to also exclude `virtual` and `skills`.
**Pros / Cons:** Fewer competing controls, but removes the search bar and Refresh Health, which are useful on those tabs.
**Why Rejected:** Far larger behavior change than the task asks for; the task is only about the Register button.

### Alternative 2: Add permission gating to the header Register button
**Description:** Also require `user?.can_modify_servers` like the tab-specific buttons do.
**Pros / Cons:** More consistent with tab-specific buttons, but changes behavior on servers/agents tabs for users without permission, which the task did not ask for and risks breaking existing flows.
**Why Rejected:** Out of scope; the task explicitly says "do not remove the button or the registration flow".

### Alternative 3: Replace the header button per tab (e.g. morph it into "Add Skill")
**Description:** Keep one header button but relabel/rewire it per active tab.
**Pros / Cons:** One button always, but duplicates the tab-specific buttons and adds stateful complexity.
**Why Rejected:** Overengineering; each tab already has its own correctly-placed action.

### Comparison Matrix

| Criteria | Chosen (narrow condition) | Alt 1 (hide row) | Alt 2 (permission gate) | Alt 3 (morph button) |
|----------|---------------------------|------------------|-------------------------|----------------------|
| Complexity | Low | Low | Medium | High |
| Scope match to task | Exact | Too broad | Beyond scope | Beyond scope |
| Behavior risk | Minimal | Medium (loses search/refresh) | Medium | Medium |
| Diff size | ~7 lines | ~5 lines | ~15 lines | ~60 lines |

## Rollout Plan
- Phase 1: Implementation (delivered as `patch.diff` in this run)
- Phase 2: Testing per `testing.md` (manual per-tab verification; optional jest test)
- Phase 3: Deployment - ships with the frontend build; no migration or config rollout needed

## Open Questions
- None. If product later wants the Register button on the External Registries tab (e.g. a future "import from peer" flow), that is a separate decision.

## References
- `frontend/src/pages/Dashboard.tsx` (tab sections and search row)
- Reference issue: https://github.com/agentic-community/mcp-gateway-registry/issues/793
