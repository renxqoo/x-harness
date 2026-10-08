# Implementation Summary: Show the header Register button only on the MCP Servers and Agents tabs

*Created: 2026-09-30*
*Baseline ref: `v1.0.18` (commit `2ba1a7d7e0e55641078239833ae562d70efb8251`)*
*Patch: `./patch.diff`*
*Related LLD: `./lld.md`*

## What Changed
The dashboard header "Register" button in `frontend/src/pages/Dashboard.tsx` is now wrapped in a render condition of `(viewFilter === 'servers' || viewFilter === 'agents')`, so it appears only on the MCP Servers and Agents tabs - the tabs where opening the server/agent registration form is the tab's action. It no longer renders on the Virtual MCP Servers, Agent Skills, or External Registries tabs, each of which either has its own action button ("Add Virtual Server", "Add Skill") or has no registration affordance at all (federation). The button JSX itself is byte-identical to before; only its visibility condition changed, exactly as the revised LLD requires. A new jest unit test pins the per-tab visibility matrix through the real tab bar.

## Files Touched

| File | Change | Lines +/- | Notes |
|------|--------|-----------|-------|
| `frontend/src/pages/Dashboard.tsx` | modified | +10 / -7 | Wrapped the header Register button (previously at lines 2410-2416) in `(viewFilter === 'servers' || viewFilter === 'agents') && (...)` with a one-line intent comment; button element unchanged |
| `frontend/src/components/__tests__/Dashboard.test.tsx` | added | +184 / -0 | Unit test: renders Dashboard with all hooks/components mocked, clicks each real tab button, asserts the exact-name "Register" button presence on servers/agents and absence on virtual/skills/external; also pins the Discover row hiding and the surviving controls on virtual |

Patch total: 2 files, +194 / -7.

## How to Apply

```bash
git clone --branch v1.0.18 --depth 1 https://github.com/agentic-community/mcp-gateway-registry repo && cd repo
git apply /path/to/patch.diff
```

`git apply --check` was verified against a fresh checkout at `v1.0.18` (commit `2ba1a7d7e0e55641078239833ae562d70efb8251`): applies cleanly.

## Deviations from the LLD
- The LLD's optional unit test (Step 2) was implemented, with one refinement discovered while writing it: the first draft drove `viewFilter` via a test-only global, but Dashboard's state initializer hardcodes `'discover'` (Dashboard.tsx:202) and reads no such global. The final test drives the real tab bar buttons via `fireEvent.click` instead, which exercises the component the way a user does. This is a test-mechanics refinement only; the implemented condition is exactly the LLD's.
- None otherwise - the production change matches LLD Step 1 exactly.

## Not Implemented / Follow-ups
- Playwright e2e coverage (repo has `frontend/e2e`): intentionally not added; the jest matrix plus the manual per-tab checks in `testing.md` cover this 2-token behavior change (SRE review deferred it as proportionate).
- Client-side permission gating on the header Register button: deliberately not added (Security review must-fix scope guard; server-side authz already enforces registration permissions).

## Verification (not executed)
Per skill constraints, no tests, linters, or builds were run against the target repo; `npm test` in `frontend/` is how a human implementer would execute the new jest test (see `testing.md` Section 5). The patch's mechanical integrity is verified: it applies cleanly onto a fresh `v1.0.18` checkout. The prior run's artifacts that previously occupied this folder were overwritten end-to-end by this run; only their first lines were read (required by the overwrite guard) and no prior content was reused.
