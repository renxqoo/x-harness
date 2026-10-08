# Low-Level Design: Per-caller-per-target rate limits and quarantine kill switch

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (post-review: incorporates expert-review resolutions, see review.md)*

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
The application-level rate limiter (`registry/rate_limiting/`) enforces two axes at the auth-server `/validate` hop:

- **caller**: a per-group quota (separate `user_max_requests` / `agent_max_requests`), counted per caller identity across all targets. A caller's traffic to server X and server Y draws from one bucket.
- **target**: a single shared counter per target across all callers. One noisy caller consumes another caller's headroom against the same backend.

Two capabilities cannot be expressed: an independent quota per (caller, target) pair, and an absolute, immediate, indefinite deny ("quarantine") for a compromised caller or a target that must leave rotation. The only lever today for the latter is a very low group limit, which still admits traffic, is bounded below by the config-time floors on short windows, and resets every window.

### Goals
- A third **`caller_target`** axis: independent counters keyed by the composite of caller identity and classified target, subject resolved via the existing rate-limit group membership storage.
- **Quarantine**: two reserved groups (`__quarantined_callers__`, `__quarantined_targets__`), auto-seeded empty at startup, undeletable, evaluated as an early deny before any counter work.
- Decided and justified semantics for: quarantine-deny response vs throttle response, admin bypass per axis, and store-unavailable failure mode.
- Both features land at the existing single enforcement hook (`RateLimiter.check()`); manageable via the existing admin API, CLI, and UI. No new env vars, no nginx changes, no new infrastructure.

### Non-Goals
- Fine-grained `mcp_tool` / `a2a_skill` enforcement (remains a later phase; the new axis simply inherits the existing `UNENFORCED_ENTITY_TYPES` guard).
- New counter backends, new collections, quarantine audit/approval workflows, TTL auto-release, or quarantine reason metadata.
- Any change to nginx templates or to the auth-request wiring (a quarantine deny is a plain 403 to the client).
- Quarantining a caller by raw username without a group/membership edit (subjects are managed exclusively through the existing membership model).

### Accepted Risks (explicit)
- **Admin tokens bypass CALLER quarantine** (consistent with the pre-existing caller-gate bypass that prevents operator lockout). A compromised admin credential is therefore not contained by caller quarantine. Mitigations: (1) target quarantine denies EVERY caller including admins, so per-target containment works; (2) admin status is IdP-controlled and revocable there, restoring normal authz denial. This risk is restated in the ops doc.
- **Caller quarantine guards the data plane only** (the limiter is not invoked for control-plane `/api/*` requests). Accepted: the data plane is the exposure, and the control plane must stay reachable to release the quarantine.

## Codebase Analysis

### Key Files Reviewed

| File/Directory | Purpose | Relevance to This Change |
|----------------|---------|--------------------------|
| `registry/rate_limiting/models.py` | `RateLimitDefinition`, `RateLimitMembership`, `RateLimitDecision` + axis/entity-type allowlists | Extend axis allowlist, membership subject allowlist, decision markers |
| `registry/rate_limiting/limiter.py` | `RateLimiter.check()` / `_Gate` / `_enforce` orchestration | The single enforcement hook; add composite-subject gates + early deny |
| `registry/rate_limiting/definitions_repository.py` | CRUD + 30s read cache over `mcp_rate_limits`; `list_caller_limits` / `list_target_limits` | Add a `list_caller_target_limits` query keyed by (entity_type, name, group) |
| `registry/rate_limiting/memberships_repository.py` | CRUD + cache over `rate_limit_memberships`; `get_groups_for(username, client_id)` | Extend to resolve `target:<name>` membership docs for target quarantine; add `ensure_quarantine_seeds` |
| `registry/rate_limiting/backend.py`, `documentdb_backend.py` | Atomic conditional-increment fixed-window counters | Unchanged; composite subject is just another counter key |
| `auth_server/rate_limiting_config.py` | Env constants + lazy `RateLimiter` singleton | Add startup seeding hook alongside singleton construction |
| `auth_server/server.py` | `/validate`: `_enforce_rate_limit` -> `check(...)`; `startup_event`; 403+headers throttle shape | Wire startup seeding; pass `decision.kind` through the 403 detail |
| `registry/api/rate_limit_routes.py` | Admin CRUD: definitions + memberships; floor + enforceability guards | Accept new axis; reject definitions naming reserved groups; guard reserved-group deletes |
| `api/registry_management.py` + `api/registry_client.py` | CLI subcommands + REST client | New axis choices; quarantine list/add/release commands |
| `frontend/src/hooks/useRateLimits.ts`, `components/IAMRateLimits.tsx`, `components/iam/RateLimitGroupsEditor.tsx`, `IAMUsers.tsx`, `IAMM2M.tsx` | Settings UI | New axis in form; quarantine chips, badge, target-quarantine panel |
| `registry/observability/meters.py` | OTel counters (bounded labels only) | New quarantine counter |
| `docs/design/rate-limiting.md` | Design/ops guide | Extend axes + quarantine sections |
| `tests/unit/rate_limiting/test_limiter.py`, `test_models.py`, `tests/unit/api/test_rate_limit_routes.py` | Existing unit patterns (fake backend/repos, `AsyncMock` repos, TestClient + dependency overrides) | Follow for new tests |

### Existing Patterns Identified
1. **Fail-closed schema validation**: allowlists (`AXIS_ABBREVIATION`, `CALLER_ENTITY_TYPES`, `TARGET_ENTITY_TYPES`, `MEMBERSHIP_SUBJECT_TYPES`) with `model_validator` rejections. New values must be added to the allowlists, never special-cased at call sites.
2. **Cached hot-path reads with mutation invalidation**: `DefinitionsRepository` / `MembershipsRepository` keep ~30s in-process caches; every admin mutation calls `invalidate_cache()`. Quarantine reads reuse `MembershipsRepository` so they inherit this for free.
3. **Sequential tightest-window-first gates with deny-does-not-consume**: `_Gate` list sorted by window, short-circuit on first denial (`limiter.py` check docstring). New gates must slot into this order.
4. **Per-definition `fail_closed` overriding a global fail-open**: `_enforce` catches backend errors, logs, and either denies or allows.
5. **Throttle-over-auth_request convention**: a throttle leaves `/validate` as 403 + `X-RateLimit-Throttled: 1` headers; nginx `@forbidden_error` rewrites to 429. Anything without the marker is a genuine 403.
6. **Admin CRUD with server-derived `_id` + URL-id consistency check** and `_require_admin` guard on every route.
7. **Config-time footgun guards** in `rate_limit_routes.py`: `_validate_enforceable` (unenforced entity types) and `_validate_caller_floor` (short-window floor safeguard).

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `RateLimiter.check()` | Extends | New gate builder + pre-gate quarantine evaluation |
| `MembershipsRepository.get_groups_for` | Extends | Union of user/client docs already returned; quarantine rides on it. New: resolve `target:<name>` docs |
| `DefinitionsRepository` | Extends | New query for `axis="caller_target"` matching classified target + caller groups |
| `auth_server.server.startup_event` | Uses | Fire-and-forget seeding of the reserved membership anchor docs |
| `rate_limit_routes.py` PUT/DELETE guards | Extends | Reserved-name rejection |
| `RateLimitDecision.headers()` | Extends | Quarantine marker variant |
| nginx `@forbidden_error` | None (deliberately) | Quarantine marker must NOT trigger the 429 rewrite |

### Constraints and Limitations Discovered
- nginx `auth_request` forwards only 401/403; a 429 from `/validate` becomes a 500. Any deny must leave as 403.
- The throttle 429 rewrite keys solely on the `X-RateLimit-Throttled` header captured from the subrequest, so a *different* marker on a 403 is inert to nginx (no template change needed to keep quarantine a plain 403).
- `_enforce_rate_limit` returns early (no limiter call) for control-plane requests (no classified target) and when `RATE_LIMITING_ENABLED=false`. Caller quarantine therefore only guards the data plane, exactly like every other gate. This is accepted: the data plane is the exposure; the control plane stays admin-operable for releasing the quarantine.
- Memberships are the only source of rate-limit groups (never the token's authz groups claim).
- Membership docs carry an `enabled` flag (set true on upsert, filtered in reads) that is not part of the model; reserved seeds must set it so lookups match.
- The limiter already skips caller-gate building (including the groups lookup) for admins; quarantine-for-callers must not reintroduce a lookup there or it changes admin-path DB traffic.

## Architecture

### System Context Diagram

```
client -> nginx (auth_request /validate) -> auth-server /validate
                                              | _enforce_rate_limit
                                              v
                                    RateLimiter.check()          <-- single enforcement hook (unchanged location)
                                      | 1. QUARANTINE (early deny, no counters)
                                      |    caller groups vs __quarantined_callers__
                                      |    target membership vs __quarantined_targets__
                                      | 2. caller gates        (axis=caller)
                                      | 3. target gates        (axis=target)
                                      | 4. caller_target gates (axis=caller_target, composite subject)
                                      v
                       DocumentDB: mcp_rate_limits / rate_limit_memberships / rate_limit_counters
```

### Sequence Diagram (throttle vs quarantine)

```
caller -> /validate: token ok, target classified (mcp_server, /mcpgw)
  check(): groups = memberships.get_groups_for(user, client)      [cached 30s]
  if "__quarantined_callers__" in groups and not is_admin:
      metric(rate_limit_quarantined_total{subject=caller}); return Decision(kind=quarantine, deny)
  if memberships.is_target_quarantined("mcpgw"):                  [cached 30s]
      metric(rate_limit_quarantined_total{subject=target});  return Decision(kind=quarantine, deny)
  gates = caller_gates(groups) + target_gates(T) + caller_target_gates(groups, T)
  for gate in sorted(gates, by window):           # tightest first, short-circuit
      deny -> 403 + X-RateLimit-Throttled:1 + Retry-After   (nginx rewrites to 429)
  allow -> /validate 200
quarantine deny -> 403 + X-RateLimit-Quarantined:1, no Retry-After (nginx leaves it a plain 403)
```

### Component Diagram

```
models.py         limiter.py                     repositories                  surfaces
-----------       -----------------------        ----------------------        ----------------------
axis allowlist    check():                       MembershipsRepository:        rate_limit_routes.py
 +caller_target     quarantine early-deny          get_groups_for (existing)     new-axis validation
QUARANTINE_*       _build_caller_gates            get_target_groups (new)       reserved-name guards
 CallerTargetDef    _build_target_gates           ensure_quarantine_seeds(new)  registry_management.py
 membership         _build_caller_target_gates    DefinitionsRepository:        (CLI quarantine cmds)
  subject 'target'  _enforce / _deny (unchanged)    list_caller_target_limits   IAMRateLimits.tsx
RateLimitDecision  (composite _Gate.subject)      (new cached query)            RateLimitGroupsEditor
 kind + headers                                                                 + IAMUsers/IAMM2M chips
```

## Data Models

### New / Extended Models

`RateLimitDefinition` gains the axis and a validator branch; no new fields are introduced. For `axis="caller_target"`:

- `entity_type`: target kind (`mcp_server` | `a2a_agent`; tool/skill stay unenforced), from the same classification as the target axis.
- `name`: the **target** name (server path / agent path).
- `group`: **new optional field**, the rate-limit group the caller must belong to. Required for and only allowed on `caller_target` (a caller-side discriminator must not leak onto other axes).

```python
# models.py (additions)
AXIS_ABBREVIATION: dict[str, str] = {
    "caller": "clr", "target": "tgt", "caller_target": "ct",
}

group: str | None = Field(
    default=None,
    min_length=1,
    description="caller_target axis: rate-limit group the caller must belong to",
)

# in _check_axis_and_entity_type, after the existing caller/target branches:
if self.axis == "caller_target":
    if self.entity_type not in TARGET_ENTITY_TYPES:
        raise ValueError(...)
    if self.group is None:
        raise ValueError("a caller_target definition must set group")
    if self.user_max_requests is None and self.agent_max_requests is None:
        raise ValueError("a caller_target definition must set user_max_requests and/or agent_max_requests")
elif self.axis in ("caller", "target") and self.group is not None:
    raise ValueError("group is only valid on the caller_target axis")

def build_id(self) -> str:
    if self.axis == "caller_target":
        return f"{self.axis}:{self.entity_type}:{self.group}:{self.name}:{self.window_seconds}"
    return f"{self.axis}:{self.entity_type}:{self.name}:{self.window_seconds}"
```

`RateLimitMembership` gains one subject kind. A `target` subject uses the target path as `subject` and its `groups` list holds (at most) the reserved target-quarantine group:

```python
MEMBERSHIP_SUBJECT_TYPES: frozenset[str] = frozenset({"user", "client", "target"})

# doc ids therefore include: "target:/mcpgw" (or "target:mcpgw" as classified)
```

`RateLimitDecision` gains a `kind` and a quarantine header set:

```python
class RateLimitDecision(BaseModel):
    kind: str = "throttle"          # "throttle" | "quarantine" | "allow" (default keeps old shape)
    ...
    @classmethod
    def quarantine(cls, subject_kind: str) -> "RateLimitDecision":
        return cls(allowed=False, kind="quarantine", axis=subject_kind, remaining=0)

    def headers(self) -> dict[str, str]:
        if self.kind == "quarantine":
            return {"X-RateLimit-Quarantined": "1", "Connection": "close"}
        # existing throttle headers unchanged
```

### Reserved Group Constants (models.py)

```python
QUARANTINE_CALLER_GROUP: str = "__quarantined_callers__"
QUARANTINE_TARGET_GROUP: str = "__quarantined_targets__"
QUARANTINE_GROUPS: frozenset[str] = frozenset({QUARANTINE_CALLER_GROUP, QUARANTINE_TARGET_GROUP})
QUARANTINE_SEED_SUBJECT_TYPES: dict[str, str] = {
    QUARANTINE_CALLER_GROUP: "user",   # caller anchor doc id: "user:__quarantined_callers__"
    QUARANTINE_TARGET_GROUP: "target", # target anchor doc id: "target:__quarantined_targets__"
}
```

The seeds double as the name anchors: the caller-group seed lives at `user:<group>` (so it appears in `list_all()` as a normal membership document), and the target-group seed at `target:<group>`. Both carry `groups: ["<same reserved name>"]` so the document is self-describing and the reserved groups are always "defined" for UI purposes without a definitions row.

### Storage (unchanged collections)

| Collection | Doc | New use |
|-----------|-----|---------|
| `rate_limit_memberships` | `{_id: "user:alice", subject_type: "user", subject: "alice", groups: [..., "__quarantined_callers__"], enabled: true}` | Caller quarantine = one more group chip |
| `rate_limit_memberships` | `{_id: "target:/mcpgw", subject_type: "target", subject: "/mcpgw", groups: ["__quarantined_targets__"], enabled: true}` | Target quarantine |
| `mcp_rate_limits` | `{_id: "caller_target:mcp_server:tenant-a:/mcpgw:60", axis: "caller_target", entity_type: "mcp_server", group: "tenant-a", name: "/mcpgw", user_max_requests: 30, window_seconds: 60, ...}` | Per-(group caller, target) quota |
| `rate_limit_counters` | `{_id: "ct:mcp_server:alice|/mcpgw:60:<window_index>", count: N, ...}` | Composite-subject counter |

## API / CLI Design

### Admin API (all existing routes, extended)

- `PUT /api/rate-limits/{id}` accepts `axis="caller_target"` bodies. Id consistency check uses the new 5-segment `build_id()`. Guards extended: `_validate_enforceable` still rejects `mcp_tool`/`a2a_skill`; `_validate_caller_floor` extended to `caller_target` (short-window limits must respect the per-minute floors); new `_validate_reserved_groups` rejects any definition whose `name` or `group` is a reserved quarantine name (400, quarantine is not a throttle).
- `DELETE /api/rate-limits/{id}`: unchanged (definitions on reserved names are already prevented at PUT).
- `PUT /api/rate-limit-memberships/{id}`: accepts `subject_type="target"` bodies (id `target:<subject>`); new `_validate_membership_reserved` guard enforces SUBJECT-KIND/GROUP PAIRING (review resolution): a `user`/`client` membership may carry `__quarantined_callers__` and a `target` membership may carry `__quarantined_targets__`; cross-kind usage, carrying BOTH reserved groups, or editing a seed doc's own groups is rejected 400. So quarantining alice is a normal PUT on `user:alice` adding the reserved caller group.
- `DELETE /api/rate-limit-memberships/{id}`: **409** when the id is a reserved seed (`user:__quarantined_callers__`, `target:__quarantined_targets__`); quarantine is released by editing groups, not by deleting the anchor.

Error cases: 400 invalid definition/membership or reserved-name misuse; 401/403 per `_require_admin`; 404 unknown id; 409 reserved-seed delete.

### CLI (`python registry_management.py ...`)

Existing commands extended, three added (client methods mirror them):

```
rate-limit-set  --axis caller_target --entity-type mcp_server --name /mcpgw \
                --group tenant-a --user-max-requests 30 [--window-seconds 60] [--fail-closed]
rate-limit-list / rate-limit-get / rate-limit-delete        # ids render the 5-segment form
rate-limit-quarantine-list                                   # GET /api/rate-limit-memberships, filtered
rate-limit-quarantine-caller   --subject alice   [--release]
rate-limit-quarantine-target   --subject /mcpgw  [--release]
```

`--release` removes the reserved group from the subject's membership (and deletes a target membership doc that becomes empty, excluding seeds). Implementation reuses `set_rate_limit_membership` / `delete_rate_limit_membership` client methods plus a read-modify-write.

### Enforcement Behavior (the contract at `check()`)

**Invocation:** unchanged signature and call site (`auth_server/server.py:_enforce_rate_limit` passes `username, client_id, is_admin, target_entity_type, target_name`).

**Expected outcomes:**

| Scenario | Result |
|----------|--------|
| Non-admin caller in group G, (identity, T) counter over a matching `caller_target` def's per-caller-type limit | 403 + `X-RateLimit-Throttled: 1` (+ reset/limit/retry headers) -> nginx 429 |
| Same caller, different target, or different caller, same target | independent counter, still allowed |
| Caller membership includes `__quarantined_callers__`, non-admin | 403 + `X-RateLimit-Quarantined: 1`, no `Retry-After`, zero counter ops, WARNING log + metric |
| Target membership `target:T` includes `__quarantined_targets__` (any caller, admin included) | same as above with `axis="target"` attribution |
| Admin caller, quarantined | caller quarantine skipped (caller-gate bypass); target quarantine still applies |
| No classified target (control plane) | limiter not invoked (unchanged) |
| Store error during quarantine lookup | fail-open (log + allow) unless global fail-open disabled, then deny |

## Configuration Parameters

**No new environment variables and no settings-class fields.** Deliberately: the task forbids new deployment configuration, and every knob that matters already exists.

| Existing Parameter | Reuse |
|--------------------|-------|
| `RATE_LIMITING_ENABLED` | Master gate for everything, unchanged |
| `RATE_LIMIT_FAIL_OPEN` | Also governs the target-quarantine lookup on store error |
| `RATE_LIMIT_DEFINITIONS_CACHE_TTL_SECONDS` | Quarantine + caller_target definition reads ride the same caches |
| `RATE_LIMIT_USER_FLOOR_PER_MIN` / `RATE_LIMIT_AGENT_FLOOR_PER_MIN` | Extended to short-window `caller_target` definitions |

### Deployment Surface Checklist
- `.env.example`: no change (documented in `docs/design/rate-limiting.md` instead).
- `docker-compose*.yml` / `charts/` / `terraform/`: no change (no new parameters).
- nginx templates: no change (quarantine marker is not the throttle marker).

## New Dependencies

None. This change uses only existing dependencies (pydantic, motor, FastAPI, React/axios).

## Implementation Details

### Step-by-Step Plan

#### Step 1: Models (`registry/rate_limiting/models.py`)
**Lines:** ~49 (axis map), ~61-160 (definition validator, `group` field, `build_id`), ~160 (membership subjects), ~202-243 (decision `kind` + `headers`), plus the reserved-name constants block (~56).

Apply the model additions from [Data Models](#data-models) verbatim, including: `AXIS_ABBREVIATION["caller_target"] = "ct"`, the `group` field with the axis-conditional validator branch, the membership `target` subject type, `RateLimitDecision.kind` defaulting to `"throttle"` with `RateLimitDecision.quarantine(subject_kind)`, and the quarantine `headers()` branch (marker + `Connection: close` only; no `Retry-After`, no `X-RateLimit-Limit/Reset`).

#### Step 2: Limiter (`registry/rate_limiting/limiter.py`)
**Lines:** new imports/constants ~30-48; quarantine helpers ~160-200; `_build_caller_target_gates` ~200-240; `check()` rewiring ~183-237.

```python
async def _is_target_quarantined(self, target_entity_type: str | None, target_name: str | None) -> bool:
    if not target_entity_type or not target_name:
        return False
    try:
        target_groups = await self._memberships.get_groups_for_target(target_name)
    except Exception as exc:                      # store unavailable: same policy as counters
        rate_limit_errors_total.add(1, {"axis": "target"})
        if not self._fail_open:
            return True                            # fail closed
        logger.warning(f"rate-limit quarantine lookup failed (fail-open): {exc}")
        return False                               # fail open
    return QUARANTINE_TARGET_GROUP in target_groups
```

`check()` gains, immediately after the `caller_type`/`identity` resolution and BEFORE any gate building:

```python
if not is_admin:
    groups = await self._memberships.get_groups_for(username, client_id)   # already fetched today
    if QUARANTINE_CALLER_GROUP in groups:
        rate_limit_quarantined_total.add(1, {"subject": "caller"})
        logger.warning(
            f"rate-limit quarantine: caller quarantined "
            f"caller_username={username or ''} caller_client_id={client_id or ''}"
        )
        return RateLimitDecision.quarantine("caller")
    if await self._is_target_quarantined(target_entity_type, target_name):
        rate_limit_quarantined_total.add(1, {"subject": "target"})
        logger.warning(
            f"rate-limit quarantine: target quarantined name={target_name} "
            f"caller_username={username or ''} caller_client_id={client_id or ''}"
        )
        return RateLimitDecision.quarantine("target")
else:
    # Admins bypass caller quarantine (lockout safety) but not target quarantine.
    if await self._is_target_quarantined(target_entity_type, target_name):
        ... same deny with subject="target" ...
    groups = []
```

(Note the restructure: `get_groups_for` moves inside the `not is_admin` branch that already existed, so the admin path performs no membership read and gains only the target-quarantine lookup.)

Gate building then appends the third axis for non-admin callers with a classified target:

```python
async def _build_caller_target_gates(self, identity, groups, caller_type,
                                     target_entity_type, target_name) -> list[_Gate]:
    """One gate per (definition, window); composite subject, per-caller-type limit."""
    if not groups or not target_entity_type or not target_name:
        return []
    defs = await self._definitions.list_caller_target_limits(
        target_entity_type, target_name, groups,
    )
    gates = []
    for d in defs:
        limit = d.limit_for_caller_type(caller_type)
        if limit is None:
            continue
        gates.append(_Gate(
            AXIS_ABBREVIATION["caller_target"], d.entity_type,
            f"{identity}|{target_name}", d.window_seconds, limit, d.fail_closed,
        ))
    return gates
```

The composite subject deliberately uses `|` as the join separator; identities (usernames/client_ids) cannot contain `|` in the supported IdPs, and the counter key is never parsed back into fields (same convention as the colon-packed definition ids). Gates from all three axes are concatenated into the existing sort-by-window loop unchanged; `_enforce` needs **no** modification (it already keys labels/metrics off `gate.axis_abbr`, so `ct` metrics appear automatically; the `name=` log field will show the composite subject, which is the desired attribution).

`_deny()` stays window-based. A quarantined caller/target has no window; `RateLimitDecision.quarantine()` leaves `reset_epoch`/`retry_after` at 0 and `headers()` omits `Retry-After` entirely.

#### Step 3: Repositories
**`definitions_repository.py`** (~101-144, new method after `list_target_limits`):

```python
async def list_caller_target_limits(self, entity_type, name, groups) -> list[RateLimitDefinition]:
    """Enabled caller_target defs for this target whose group is in the caller's groups."""
    if not groups:
        return []
    cache_key = f"caller_target:{entity_type}:{name}:{','.join(sorted(groups))}"
    cached = self._cache_get(cache_key)
    if cached is not None:
        return cached
    query = {
        "axis": "caller_target", "entity_type": entity_type, "name": name,
        "group": {"$in": groups}, "enabled": True,
    }
    definitions = await self._find_definitions(query)
    self._cache_put(cache_key, definitions)
    return definitions
```

Cache-key growth is bounded (one entry per distinct target x group-set per process, invalidated on any mutation), and empty-result caching preserves the steady-state zero-DB-read property on the hot path.

**`memberships_repository.py`** (new method + seeding):

```python
QUARANTINE_SEED_IDS: tuple[str, ...] = (
    "user:__quarantined_callers__", "target:__quarantined_targets__",
)

async def get_groups_for_target(self, target_name: str) -> list[str]:
    """Resolve groups for a target-subject membership doc (cached like caller lookups)."""
    return await self._groups_for_id(f"target:{target_name}")

async def ensure_quarantine_seeds(self) -> None:
    """Idempotently create the reserved anchor docs so quarantine groups always exist."""
    from .models import QUARANTINE_SEED_SUBJECT_TYPES, QUARANTINE_GROUPS
    collection = await self._get_collection()
    for group, subject_type in QUARANTINE_SEED_SUBJECT_TYPES.items():
        doc_id = f"{subject_type}:{group}"
        await collection.update_one(
            {"_id": doc_id},
            {"$setOnInsert": {
                "subject_type": subject_type, "subject": group,
                "groups": [group], "enabled": True,
            }},
            upsert=True,
        )
    # reserved seeds must never be invisible because of the 30s cache
    self.invalidate_cache()
```

`$setOnInsert` + `upsert=True` makes seeding idempotent (never clobbers an operator's quarantine by re-running startup) and cheap (two upserts per process start). Failures are caught by the caller (seeding must not block startup).

#### Step 4: Auth-server wiring (`auth_server/server.py`, `rate_limiting_config.py`)
(SRE must-fix: the seeding helper is best-effort by construction -- it catches every exception, WARNING-logs, and returns; a unit test must simulate the store raising and assert the helper neither raises nor seeds partially.)
**`server.py` `startup_event`** (~1828-1838): after scopes load, best-effort seeding:

```python
try:
    from rate_limiting_config import ensure_quarantine_groups_seeded
except ImportError:
    from auth_server.rate_limiting_config import ensure_quarantine_groups_seeded
await ensure_quarantine_groups_seeded()
```

(the helper builds a throwaway `MembershipsRepository` and calls `ensure_quarantine_seeds()`, swallowing + WARNING-logging any exception; it must never fail startup, and it runs on every auth-server boot, not only when rate limiting is enabled, so the groups pre-exist the operator's first enablement)

**`_enforce_rate_limit`** (~1409-1426): pass the kind through the 403 detail:

```python
raise HTTPException(
    status_code=403,
    detail={
        "error": "rate_limit_exceeded" if decision.kind == "throttle" else "caller_quarantined"
        if decision.axis == "caller" else "target_quarantined",
        "axis": decision.axis,
        "retry_after": decision.retry_after,
    },
    headers=decision.headers(),
)
```

nginx is untouched: the quarantine 403 carries no `X-RateLimit-Throttled` marker, so `@forbidden_error` returns the plain-403 branch.

#### Step 5: Admin API guards (`registry/api/rate_limit_routes.py`)
- Import the reserved-group constants; add `_validate_reserved_groups(definition)` (reject `definition.name in QUARANTINE_GROUPS or definition.group in QUARANTINE_GROUPS`, 400) wired into `put_rate_limit` next to the existing guards; extend `_validate_caller_floor` to run for `axis in ("caller", "caller_target")`.
- Add `_validate_membership_reserved(membership, url_id)` implementing the pairing rule (review resolution): reject 400 when (a) a `target`-subject membership references `__quarantined_callers__`, or (b) a `user`/`client` membership references `__quarantined_targets__`, or (c) the body references BOTH reserved groups, or (d) the URL id is a seed id (`user:__quarantined_callers__` / `target:__quarantined_targets__`) and the body's `groups` differs from `[<its own reserved name>]` (seeds are frozen anchors). Wire into `put_rate_limit_membership` after id matching.
- `delete_rate_limit_membership`: return 409 for `QUARANTINE_SEED_IDS`.
- Accept `subject_type="target"` in `_parse_membership` inputs (model validator already allows it once Step 1 lands).

#### Step 6: CLI (`api/registry_management.py`, `api/registry_client.py`)
- `registry_client.py`: `set_rate_limit(..., group: str | None = None)` adds `group` to the body when set; `set_rate_limit_membership` unchanged (subject_type passes through). No new endpoints.
- `registry_management.py`: `--axis` choices gain `caller_target`; new `--group` argument on `rate-limit-set` (validated client-side: required iff axis is `caller_target`); `cmd_rate_limit_set` passes it through; three new subcommands `rate-limit-quarantine-list / -caller / -target` with `--subject` and `--release`, implemented over the memberships client methods (list-and-filter for list; read-modify-write for add/release; delete-empty-doc for released target subjects that are not seeds).
- `useRateLimits.ts`: `axis: 'caller' | 'target' | 'caller_target'` in the type; `definitionId` returns the 5-segment form for `caller_target`; export `QUARANTINE_CALLER_GROUP`, `QUARANTINE_TARGET_GROUP`; `setRateLimitMembership` / `RateLimitMembership` widen `subject_type` to include `'target'`.
- Form hygiene (Pixel should-fix): the definition form resets `group` to `''` whenever the axis select changes, so a stale group value is never submitted on a `caller`/`target` body; the target-quarantine panel reuses the `useServerList`/`useAgentList` data already loaded by `IAMRateLimits` (no new requests).
- `IAMRateLimits.tsx`: axis `<option>` "caller_target (per caller, per target)"; when selected, show a Group field (free text with datalist of existing caller-group names) in addition to the target type/name fields; `handleSave` includes `group` only on this axis; `limitSummary` renders `user N, agent M / Ws @ group G`; the list view gains a compact "Quarantine" panel: quarantined targets (from memberships where `subject_type==='target'` and groups include the reserved name) with a Release button, plus a server/agent select + Quarantine button; quarantined-target rows show a red `QUARANTINED` badge in the definitions table.
- `RateLimitGroupsEditor.tsx`: append the reserved caller group to the select options (labeled `__quarantined_callers__ (quarantine: block all)`); render any currentGroups entry equal to the reserved name as a red chip prefixed `quarantined`; this automatically equips both `IAMUsers.tsx` and `IAMM2M.tsx` (they pass `groupOptions` through unchanged).

### Error Handling
- Schema: fail-closed `ValueError` in model validators (axis/entity-type/subject allowlists, required `group`, floors).
- Admin API: 400 for invalid/reserved misuse; 409 for seed deletion; existing 401/403/404 unchanged.
- Limiter: quarantine lookup store errors follow the global fail-open policy (`_is_target_quarantined` above); counter ops unchanged (`_enforce`). The caller-groups lookup is pre-existing behavior (its failure path inside `check()` remains the outer `try/except` in `_enforce_rate_limit` which logs and skips enforcement).
- Startup seeding: never blocks or fails boot; WARNING on failure, retried on next restart.

### Logging
- Quarantine deny: WARNING `rate-limit quarantine: caller quarantined caller_username=... caller_client_id=...` / `... target quarantined name=... ...` (identity in logs, never in metric labels).
- Throttle on the new axis: existing `_enforce` WARNING with `axis=ct` and the composite `name=<identity>|<target>`.
- Seeding: INFO on first insert ("seeded reserved quarantine group X"), silent when already present.

## Observability
- New counter `mcpgw_rate_limit_quarantined_total` (`registry/observability/meters.py`) with label `subject` in {`caller`, `target`} (bounded, no identity). Emitted once per denied request instead of a counter check.
- Existing `mcpgw_rate_limit_checks_total` / `_throttled_total` gain the `axis="ct"` label value automatically via `_enforce`.
- Grafana/alert guidance: alert on `quarantined_total` increases (an active kill switch) and on `throttled_total{axis="ct"}` for per-tenant fairness tuning. Doc note added in `docs/design/rate-limiting.md`.

## Scaling Considerations
- Counter cardinality grows by (identities x targets x windows) for definitions that opt in; counters are TTL-expired exactly as today, so the counter collection self-cleans. Operators scope the blast radius by defining `caller_target` limits only on shared, multi-tenant targets.
- Definition-cache keys: one per (target, sorted-group-set) query, same 30s TTL and mutation invalidation; no unbounded growth on the hot path for a fixed config.
- Quarantine evaluation is O(1) after the (already-required) cached groups lookup for callers, and one extra cached lookup per request for targets; both are bounded by `RATE_LIMIT_BACKEND_TIMEOUT_MS` semantics of the existing repository code path.
- Seeding is two idempotent upserts per process start: negligible.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `tests/unit/rate_limiting/test_quarantine_and_caller_target.py` | Limiter-level tests: early deny, admin bypass matrix, composite counters, fail-open/closed lookup, gate stacking |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/rate_limiting/models.py` | ~+75 | New axis + `group` field + validator branches; `target` membership subject; reserved-group constants; decision `kind`/`quarantine()`/headers |
| `registry/rate_limiting/limiter.py` | ~+95 | Quarantine early-deny in `check()`; `_is_target_quarantined`; `_build_caller_target_gates`; composite-subject gates |
| `registry/rate_limiting/definitions_repository.py` | ~+30 | `list_caller_target_limits` cached query |
| `registry/rate_limiting/memberships_repository.py` | ~+40 | `get_groups_for_target`; `ensure_quarantine_seeds`; seed-id constant |
| `auth_server/rate_limiting_config.py` | ~+20 | `ensure_quarantine_groups_seeded()` helper |
| `auth_server/server.py` | ~+15 | Startup seeding call; quarantine-vs-throttle detail in the 403 |
| `registry/api/rate_limit_routes.py` | ~+55 | Reserved-name definition guard; floor extension to `caller_target`; membership reserved guard + seed-delete 409; `target` subject acceptance |
| `api/registry_client.py` | ~+12 | `group` passthrough on `set_rate_limit` |
| `api/registry_management.py` | ~+120 | `--axis caller_target`, `--group`, three quarantine subcommands + handlers |
| `frontend/src/hooks/useRateLimits.ts` | ~+20 | Axis/id/type updates; quarantine group exports |
| `frontend/src/components/IAMRateLimits.tsx` | ~+110 | caller_target form fields; quarantine panel + badge |
| `frontend/src/components/iam/RateLimitGroupsEditor.tsx` | ~+25 | Quarantine option + red chip rendering |
| `docs/design/rate-limiting.md` | ~+70 | Third axis + quarantine sections (semantics, ops runbook) |
| `tests/unit/rate_limiting/test_models.py` | ~+45 | Validator cases for the new axis/field/subjects |
| `tests/unit/api/test_rate_limit_routes.py` | ~+55 | Reserved-name 400s, seed-delete 409, target-subject PUT |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code (limiter, repos, seeding) | ~200 |
| Surfaces (API guards, CLI, UI) | ~330 |
| Modified code | ~120 |
| New tests | ~145 |
| **Total** | **~795** |

## Testing Strategy
See `testing.md` for the executable plan (unit, admin-API, backwards-compat, UX, deployment-surface, E2E). Limiter unit tests follow `test_limiter.py`'s fake-backend/fake-repo pattern; route tests follow `test_rate_limit_routes.py`'s dependency-override + `AsyncMock` repository pattern.

## Alternatives Considered

### Alternative 1: Quarantine as a special definition row (e.g. limit 0)
**Description:** encode quarantine as a `caller` definition with `max_requests=0`.
**Pros / Cons:** no new concept; but contradicts the floor safeguard (needs a special case anyway), is window-bound (auto-release at window reset), collides with most-restrictive resolution, and conflates "throttled" with "blocked" in both metrics and client semantics.
**Why Rejected:** the task explicitly requires an absolute, immediate, indefinite deny distinct from throttling.

### Alternative 2: Quarantine flag on the registry server record (target) + a disabled-user flag (caller)
**Description:** reuse existing enable/disable state instead of rate-limit groups.
**Pros / Cons:** semantically "removal from rotation"; but lives in different collections/APIs, is not visible or manageable at the rate-limit surfaces the task names, does not cover agents/M2M callers uniformly, and would not benefit from the membership cache on the hot path.
**Why Rejected:** the task mandates quarantine be managed through the existing rate-limit admin API/CLI/UI with memberships as storage.

### Alternative 3: Per-caller-per-target as two orthogonal counters intersected at enforce time
**Description:** reuse caller + target counters and deny when BOTH exceed.
**Pros / Cons:** zero schema change; but expresses "caller AND target exhausted", not "each caller may call each target N times", and still lets one caller consume another's target headroom.
**Why Rejected:** does not satisfy the stated quota.

### Comparison Matrix

| Criteria | Chosen (axis + reserved groups) | Alt 1 (zero-limit def) | Alt 2 (entity flags) | Alt 3 (counter intersection) |
|----------|--------------------------------|------------------------|----------------------|------------------------------|
| Expresses per-(caller,target) quota | Yes | No | No | No |
| Absolute immediate deny | Yes | No (floor/window) | Yes | No |
| Managed via rate-limit surfaces | Yes | Yes | No | Yes |
| New infra/config | None | None | None | None |
| Client semantic clarity (403 vs 429) | Yes | No | Partial | No |

## Rollout Plan
- Phase 1: Implementation (this change; no execution per skill constraints).
- Phase 2: Testing per `testing.md` (unit + admin-API + E2E against DocumentDB).
- Phase 3: Deployment: ship with `RATE_LIMITING_ENABLED` unchanged; seeding is automatic; operators opt in per target/group by creating `caller_target` definitions or editing memberships; rollback is revert-the-membership-edit (quarantine) or disable the definition (per-pair quota), both sub-second with no restart.

## Open Questions
- None blocking. (Deferred by design: quarantine reason/audit metadata and TTL auto-release; composite-subject tool/skill granularity.)

## References
- `docs/design/rate-limiting.md` (two-axis design this extends)
- Issue #295 (original rate-limiting LLD), Issue #1504 (this request)
- `docker/nginx_rev_proxy_http_and_https.conf` `@forbidden_error` (throttle rewrite; intentionally untouched)
