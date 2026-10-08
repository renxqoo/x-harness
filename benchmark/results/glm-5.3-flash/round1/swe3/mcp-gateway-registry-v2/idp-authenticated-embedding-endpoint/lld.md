# Low-Level Design: IdP-Authenticated Embedding Endpoint (OAuth2 Client-Credentials Bearer for LiteLLM Embeddings)

*Created: 2026-09-30*
*Author: Claude (glm-5.3-flash)*
*Status: Draft (post-review revisions incorporated)*

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
The LiteLLM embeddings path authenticates with a static credential: `EMBEDDINGS_API_KEY` is
read once and pushed into a provider environment variable when the client is constructed
(`LiteLLMClient._set_api_key_env`). Enterprise OpenAI-compatible endpoints gated by an
IdP-issued, short-lived (~60 min) bearer token start returning 401 after one token lifetime,
breaking every embedding call and every semantic-search query until an operator manually
rotates the key.

### Goals
- Opt-in OAuth2 client-credentials token provider for the LiteLLM embeddings path.
- Thread-safe token caching with a configurable pre-expiry refresh buffer; automatic
  refresh on the next call once the buffer window is entered; no cross-call stampede.
- Fresh bearer supplied per embedding call via LiteLLM's per-call `api_key` parameter
  (no environment-variable mutation, no wire-format change).
- Fail-fast startup validation when IdP mode is enabled but required settings are missing.
- Secret hygiene: client secret never logged, masked in the config UI.
- Byte-for-byte unchanged behaviour for every existing configuration when the new settings
  are unset (the default).
- Wiring through Docker, Terraform/ECS, and Helm surfaces plus the parameter reference.

### Non-Goals
- Authorization-code / refresh-token / device-code grants (client-credentials only).
- Retry-once-after-401 on embedding calls (follow-up; the refresh buffer makes expiry
  refreshes a non-event in normal operation).
- Automated re-indexing when the embedding model or dimension changes.
- Per-request token audiences / dynamic resource indicators; a static optional scope string
  is supported instead.
- CDK (`infra/`) surface.

## Codebase Analysis

### Key Files Reviewed

| File / Directory | Purpose | Relevance to This Change |
|------------------|---------|--------------------------|
| `registry/embeddings/client.py` | Embeddings client abstraction; `LiteLLMClient` wraps `litellm.embedding()` | Where per-call bearer injection happens (`encode()` builds the kwargs dict) |
| `registry/embeddings/__init__.py` | Exports `create_embeddings_client` factory | Re-export surface for the new token manager module |
| `registry/repositories/documentdb/search_repository.py` | `DocumentDBSearchRepository._get_embedding_model()` (~line 664) constructs the client from settings | The single production call site of the factory |
| `registry/services/federation/federation_auth.py` | `FederationAuthManager`: singleton, `threading.Lock`, client-credentials POST via `httpx`, `TOKEN_REFRESH_BUFFER_SECONDS = 60`, expiry-aware `_is_token_valid` | The token-manager pattern to mirror |
| `registry/core/config.py` | pydantic-settings `Settings`; embeddings block at ~426; fail-fast precedent in `__init__` (`_validate_egress_auth_config`) | Where the new settings and startup validation live |
| `registry/api/config_routes.py` | `CONFIG_GROUPS["embeddings"]` field tuples `(name, label, is_sensitive)`; `_mask_sensitive_value` masks secrets | Where the client secret gets masked |
| `docker-compose.yml` (lines 388-393) | Registry service `environment:` entries for `EMBEDDINGS_*` | Docker wiring |
| `docker-compose.prebuilt.yml`, `docker-compose.podman.yml` | Variants of the same registry env block | Docker wiring |
| `docker/registry-entrypoint.sh` (lines 260-298, 332-334) | Echoes embeddings config at startup; exports litellm vars | Startup visibility (echo only; must not print secrets) |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | Registry task definition: plain env at ~1069-1084, Secrets Manager entries at ~1795-1801 | Terraform wiring |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` (line 342) | `embeddings_api_key` variable (sensitive) | Terraform variable pattern to follow |
| `terraform/aws-ecs/modules/mcp-gateway/secrets.tf` (lines 190-201) | `aws_secretsmanager_secret.embeddings_api_key` + version | Secrets Manager pattern for the new client secret |
| `terraform/aws-ecs/modules/mcp-gateway/iam.tf` (line 21) | IAM grant reading `embeddings_api_key` secret | IAM grant pattern for the new secret |
| `charts/registry/templates/deployment.yaml`, `values.yaml` | Helm: chart-managed env + `extraEnv` / `extraEnvFrom` (native EnvVar schema, validated against reserved names) | Helm carries `EMBEDDINGS_*` via these mechanisms; no native embedding values exist, so the design documents the mechanism rather than inventing new chart values |
| `docs/unified-parameter-reference.md` (Group 20, lines 520-534) | The parameter table (Docker / Terraform / Helm columns) | Documentation target |
| `docs/embeddings.md` | Embeddings configuration docs (env table ~line 90) | Documentation target |
| `tests/unit/embeddings/test_embeddings_client.py` | Existing unit-test conventions for the embeddings module | Test style to match |
| `tests/unit/core/test_egress_config_validation.py` | Settings cross-field validation test conventions | Test style for fail-fast validation |

### Existing Patterns Identified
1. **Federation token manager** (`registry/services/federation/federation_auth.py`):
   singleton via `__new__` + class-level `Lock`, instance-level `_token_lock` around
   cache-check + refresh, `TOKEN_REFRESH_BUFFER_SECONDS = 60`, `expires_in` (default 3600)
   from the token response, `httpx.Client(timeout=30)`, errors logged without token/secret
   material. The new manager mirrors this structure but is instantiated per embeddings
   client (not keyed on federation credentials); the repository lazily builds the client
   once and caches it in `self._embedding_model`, so one manager (and one token cache)
   serves all embedding calls per process.
2. **Fail-fast cross-field validation** (`registry/core/config.py`, `Settings.__init__` ->
   `_validate_egress_auth_config`): plain `ValueError`/`RuntimeError` naming the offending
   env vars. The new validator follows this shape, called unconditionally from `__init__`.
3. **Sensitive-field masking** (`registry/api/config_routes.py`): field tuples carry an
   `is_sensitive` flag; `_mask_sensitive_value` renders `****` / `(not set)`; the env export
   comments sensitive values out unless explicitly included.
4. **Secrets Manager wiring** (`terraform/.../secrets.tf` + `ecs-services.tf`): non-secret
   settings become plain `environment` entries via tfvars; secrets live in Secrets Manager
   resources injected with `valueFrom` and granted via IAM.

### Integration Points

| Component | Integration Type | Details |
|-----------|------------------|---------|
| `Settings` (registry/core/config.py) | Extends | Six new fields in the embeddings block + `_validate_embeddings_idp_config()` called from `__init__` |
| `create_embeddings_client` (registry/embeddings/client.py) | Extends | New keyword parameter forwarded to `LiteLLMClient`; default keeps old behaviour |
| `LiteLLMClient.encode` (registry/embeddings/client.py) | Extends | When a token manager is present, add `api_key=<current bearer>` to the LiteLLM kwargs |
| `DocumentDBSearchRepository._get_embedding_model` | Uses | Forwards the new settings fields to the factory (single call site) |
| `CONFIG_GROUPS["embeddings"]` (registry/api/config_routes.py) | Extends | New field tuples; secret flagged sensitive so it is masked |
| Docker / Terraform / Helm surfaces | Config | New env vars on each surface (see Deployment Surface Checklist) |

### Constraints and Limitations Discovered
- `LiteLLMClient` currently pushes `api_key` into a provider env var at construction time
  (`_set_api_key_env`). IdP mode must bypass that mutation entirely: per-call `api_key`
  wins over env vars in LiteLLM, and writing short-lived tokens to the environment would
  leak them to child processes.
- The LiteLLM `embedding()` call is synchronous and executed by repository code that itself
  runs inside async FastAPI handlers; the token manager must be thread-safe (concurrent
  calls) but synchronous is acceptable, mirroring federation.
- A token fetch happens lazily inside `encode()`; a slow or unreachable IdP adds latency to
  the first search call. Buffer pre-warming is deliberately not done (keeps the failure
  surface inside the already-failing-call path and avoids network I/O at import time).
- Helm charts carry `EMBEDDINGS_*` config through the generic `extraEnv` / `extraEnvFrom`
  mechanism (the registry chart has no native embedding values; the parameter reference's
  Group 20 Helm column maps legacy keys on the old `mcpgw` chart). The design documents the
  `extraEnv` + `extraEnvFrom` secret mechanism instead of adding chart values that do not
  exist today.
- `docs/unified-parameter-reference.md` Group 20 already has the Docker / Terraform / Helm
  column structure the new rows must follow.
- Only additive settings changes are allowed; existing `.env` files must keep parsing
  identically (new fields all default to unset/disabled).
- Trust boundary (from security review): `EMBEDDINGS_IDP_TOKEN_URL` is operator-supplied
  deployment configuration, the same trust level as `FEDERATION_TOKEN_ENDPOINT`, which uses
  a plain `httpx.Client`. A tenant-supplied token URL would require the SSRF-guarded
  client; that is not the case here, so the plain client is consistent with the existing
  trust boundary. The startup scheme check (http/https only) stays as defence in depth.

## Architecture

### System Context Diagram

```
                       +---------------------+
                       | Identity Provider   |
                       | (OAuth2 token       |
                       |  endpoint)          |
                       +----------^----------+
                                  | 5. client_credentials grant
                                  | 6. {access_token, expires_in}
+---------------------+   3. get_token()  +---------------------------+
| Embedding endpoint  |                   | EmbeddingsIdPTokenManager |
| (OpenAI-compatible, |<------------------| (registry/embeddings/     |
|  IdP-gated)         |   4. Bearer in    |  idp_token_manager.py)    |
+---------^-----------+   Authorization    +------------^--------------+
          |                                            | 2. builds manager
          | 2'. POST /embeddings (api_key)             |    from settings
+---------+-----------+          +---------------------+---------+
| litellm.embedding() |<---------| LiteLLMClient.encode()        |
+---------------------+          | (registry/embeddings/         |
                                  |  client.py)                   |
                                  +---------------^---------------+
                                                  | 1. encode(texts)
                                  +---------------+---------------+
                                  | DocumentDBSearchRepository    |
                                  | (semantic search / indexing)  |
                                  +-------------------------------+
```

Static path (settings unset) is unchanged: `EMBEDDINGS_API_KEY` -> `_set_api_key_env()` ->
provider env var -> LiteLLM. No token manager is constructed, nothing else runs.

### Sequence Diagram (IdP mode, token refresh)

```
encode(texts)         TokenManager               IdP                LiteLLM
    |  get_token()         |                       |                    |
    |--------------------->| lock; cached+valid?   |                    |
    |                      |   no -> POST grant -->|                    |
    |                      |<-- access_token,      |                    |
    |                      |    expires_in         |                    |
    |                      | cache token+expiry;   |                    |
    |<-- bearer -----------| unlock                |                    |
    | kwargs["api_key"]=bearer                     |                    |
    |----------------------------------------------------------->       |
    |<--------------------------- embeddings response ----------|       |
```

Expired-within-buffer -> same flow; the POST happens under the same lock that guarded the
check (single-flight: a second caller re-checks after acquiring the lock and finds the
fresh token).

### Component Diagram

```
registry/core/config.py
  Settings
    +-- embeddings_idp_enabled: bool = False
    +-- embeddings_idp_token_url: str | None = None
    +-- embeddings_idp_client_id: str | None = None
    +-- embeddings_idp_client_secret: SecretStr | None = None   (secret; masked)
    +-- embeddings_idp_scope: str | None = None
    +-- embeddings_idp_refresh_buffer_seconds: int = 60
    +-- _validate_embeddings_idp_config()   (called in __init__)

registry/embeddings/idp_token_manager.py (new)
  EmbeddingsIdPTokenError(RuntimeError)
  EmbeddingsIdPTokenManager
    +-- __init__(token_url, client_id, client_secret, scope, refresh_buffer_seconds)
    +-- get_token() -> str          (lock; cache or refresh; raises on failure)
    +-- clear_token() -> None
  create_idp_token_manager(settings) -> manager | None   (None when disabled)

registry/embeddings/client.py
  LiteLLMClient
    +-- idp_token_manager: EmbeddingsIdPTokenManager | None  (new kwarg)
    +-- encode(): injects api_key per call when manager present
  create_embeddings_client(): new kwarg forwarded
```

## Data Models

### New Models
No Pydantic request/response models are added. The token manager is a plain class:

```python
class EmbeddingsIdPTokenError(RuntimeError):
    """OAuth2 token-endpoint failure for the embeddings IdP flow."""


class EmbeddingsIdPTokenManager:
    """OAuth2 client-credentials token cache for the embeddings IdP flow.

    Mirrors registry/services/federation/federation_auth.py: thread-safe,
    expiry-buffer refresh, never logs the secret or the bearer token.
    """

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: str | None = None,
        refresh_buffer_seconds: int = DEFAULT_REFRESH_BUFFER_SECONDS,
        timeout_seconds: float = DEFAULT_TOKEN_TIMEOUT_SECONDS,
    ) -> None: ...

    def get_token(self) -> str:
        """Return a cached bearer, refreshing if within the buffer window.

        Raises EmbeddingsIdPTokenError when the IdP rejects the grant or is
        unreachable. Never returns None: a None bearer would silently degrade
        to an unauthenticated call.
        """

    def clear_token(self) -> None: ...
```

### Model Changes
- `Settings` gains six fields (see Configuration Parameters).
- `embeddings_idp_client_secret` uses `SecretStr` so accidental `repr()` of settings does
  not print the secret (defence in depth on top of log discipline and UI masking).
- `LiteLLMClient.__init__` and `create_embeddings_client` gain an optional keyword-only
  parameter; the default (`None`) keeps existing callers unaffected.

## API / CLI Design

No new HTTP endpoints or CLI commands. The change surfaces through configuration only.

**Behavioural contract of the existing search endpoint (unchanged shape):** with IdP mode
enabled, each query embedding uses a bearer at most `buffer + one round-trip` old; after
IdP-side revocation the next refresh cycle recovers automatically.

**Error Cases:**
- Startup: `ValueError` naming every missing `EMBEDDINGS_IDP_*` variable when
  `EMBEDDINGS_IDP_ENABLED=true` and required settings are absent, or when the token URL is
  not `http(s)://`, or when the buffer is negative.
- Runtime: `EmbeddingsIdPTokenError` (wrapped by the existing `RuntimeError` funnel in
  `encode()`) when the token endpoint returns a non-2xx or non-JSON response or is
  unreachable. Messages contain the HTTP status / exception type only, never the request
  body, the client secret, or the bearer.

## Configuration Parameters

### New Environment Variables

| Variable Name | Type | Default | Required | Description |
|---------------|------|---------|----------|-------------|
| `EMBEDDINGS_IDP_ENABLED` | bool | `false` | No | Enable the IdP token provider for LiteLLM embeddings |
| `EMBEDDINGS_IDP_TOKEN_URL` | str | unset | When enabled | OAuth2 token endpoint URL (must be http/https) |
| `EMBEDDINGS_IDP_CLIENT_ID` | str | unset | When enabled | OAuth2 client id |
| `EMBEDDINGS_IDP_CLIENT_SECRET` | str (secret) | unset | When enabled | OAuth2 client secret; never logged, masked in UI |
| `EMBEDDINGS_IDP_SCOPE` | str | unset | No | Optional space-separated scope string sent with the grant |
| `EMBEDDINGS_IDP_REFRESH_BUFFER_SECONDS` | int | `60` | No | Refresh the token this many seconds before actual expiry |

### Settings / Config Class Updates

```python
# LiteLLM IdP token provider (only used when embeddings_provider='litellm' and
# embeddings_idp_enabled=true). All default to unset/disabled.
embeddings_idp_enabled: bool = Field(
    default=False,
    description="Enable OAuth2 client-credentials bearer tokens for LiteLLM embeddings",
)
embeddings_idp_token_url: str | None = Field(default=None, description="OAuth2 token endpoint URL")
embeddings_idp_client_id: str | None = Field(default=None, description="OAuth2 client id")
embeddings_idp_client_secret: SecretStr | None = Field(
    default=None, description="OAuth2 client secret (never logged, masked in UI)"
)
embeddings_idp_scope: str | None = Field(default=None, description="Optional OAuth2 scope string")
embeddings_idp_refresh_buffer_seconds: int = Field(
    default=60, description="Refresh the embeddings bearer this many seconds before expiry"
)
```

### Deployment Surface Checklist

| Surface | File | Change |
|---------|------|--------|
| docker-compose | `docker-compose.yml` (registry env block) | 6 new `EMBEDDINGS_IDP_*` entries with `${VAR:-}` / `${VAR:-false}` defaults |
| docker-compose prebuilt | `docker-compose.prebuilt.yml` | Same entries |
| docker-compose podman | `docker-compose.podman.yml` | Same entries |
| Docker entrypoint banner | `docker/registry-entrypoint.sh` | Echo IdP enabled state and token endpoint; never the secret |
| Terraform variables | `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | `embeddings_idp_*` variables (secret marked `sensitive`) |
| Terraform task env | `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | Plain env entries for non-secrets; `valueFrom` entry for the client secret |
| Terraform secrets | `terraform/aws-ecs/modules/mcp-gateway/secrets.tf` | `aws_secretsmanager_secret.embeddings_idp_client_secret` + version (mirrors `embeddings_api_key`) |
| Terraform IAM | `terraform/aws-ecs/modules/mcp-gateway/iam.tf` | `secretsmanager:GetSecretValue` on the new secret ARN |
| Helm | docs (Group 20) | Document `extraEnv` for non-secret vars and `extraEnvFrom.secretRef` for the client secret (chart supports both natively today) |
| Docs | `docs/unified-parameter-reference.md` (Group 20), `docs/embeddings.md` | New parameter rows + IdP section + dimension/re-index caveat |

## New Dependencies

None. The token flow uses `httpx` (already a project dependency, used by
`FederationAuthManager`) and LiteLLM's existing per-call `api_key` parameter.

## Implementation Details

### Step-by-Step Plan (for a future implementer)

#### Step 1: New settings + fail-fast validation
**File:** `registry/core/config.py`
**Lines:** embeddings block (~426, after `embeddings_aws_region`); validation called in
`Settings.__init__` next to the egress validation

Add the six fields from Configuration Parameters. Add:

```python
def _validate_embeddings_idp_config(self) -> None:
    """Fail fast when IdP mode is selected but required settings are missing."""
    if not self.embeddings_idp_enabled:
        return
    missing = [
        name
        for name, value in (
            ("EMBEDDINGS_IDP_TOKEN_URL", self.embeddings_idp_token_url),
            ("EMBEDDINGS_IDP_CLIENT_ID", self.embeddings_idp_client_id),
            ("EMBEDDINGS_IDP_CLIENT_SECRET", self.embeddings_idp_client_secret),
        )
        if not value
    ]
    if missing:
        raise ValueError(
            f"EMBEDDINGS_IDP_ENABLED=true requires {', '.join(missing)} to be set. "
            "Set them or unset EMBEDDINGS_IDP_ENABLED."
        )
    if not self.embeddings_idp_token_url.lower().startswith(("http://", "https://")):
        raise ValueError(
            f"EMBEDDINGS_IDP_TOKEN_URL must be an http(s) URL; got "
            f"{self.embeddings_idp_token_url!r}."
        )
    if self.embeddings_idp_refresh_buffer_seconds < 0:
        raise ValueError("EMBEDDINGS_IDP_REFRESH_BUFFER_SECONDS must be >= 0.")
```

Call it from `Settings.__init__` right after `_validate_egress_auth_config()`.

#### Step 2: Token manager module
**File:** `registry/embeddings/idp_token_manager.py` (new, ~150 lines)

Mirror `federation_auth.py` but fail-loud and per-client:

```python
DEFAULT_REFRESH_BUFFER_SECONDS = 60
DEFAULT_TOKEN_TIMEOUT_SECONDS = 30.0


class EmbeddingsIdPTokenError(RuntimeError):
    """OAuth2 token-endpoint failure for the embeddings IdP flow."""


class EmbeddingsIdPTokenManager:
    def __init__(self, token_url, client_id, client_secret, scope=None,
                 refresh_buffer_seconds=DEFAULT_REFRESH_BUFFER_SECONDS,
                 timeout_seconds=DEFAULT_TOKEN_TIMEOUT_SECONDS):
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._refresh_buffer_seconds = refresh_buffer_seconds
        self._token_lock = threading.Lock()
        self._access_token: str | None = None
        self._token_expiry: datetime | None = None
        self._http_client = httpx.Client(timeout=timeout_seconds)

    def get_token(self) -> str:
        with self._token_lock:
            if self._is_token_valid():
                return self._access_token
            return self._refresh_token()

    def _is_token_valid(self) -> bool:
        if not self._access_token or not self._token_expiry:
            return False
        buffered = self._token_expiry - timedelta(seconds=self._refresh_buffer_seconds)
        return datetime.now(UTC) < buffered

    def _refresh_token(self) -> str:
        data = {"grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret}
        if self._scope:
            data["scope"] = self._scope
        logger.debug("Requesting embeddings IdP token from %s", self._token_url)
        try:
            response = self._http_client.post(
                self._token_url, data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise EmbeddingsIdPTokenError(
                f"embeddings IdP token endpoint unreachable: {type(exc).__name__}"
            ) from exc
        if response.status_code >= 400:
            raise EmbeddingsIdPTokenError(
                f"embeddings IdP token request failed with HTTP {response.status_code}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise EmbeddingsIdPTokenError(
                "embeddings IdP token endpoint returned a non-JSON response"
            ) from exc
        token = payload.get("access_token")
        if not token:
            raise EmbeddingsIdPTokenError(
                "embeddings IdP token response missing access_token"
            )
        expires_in = payload.get("expires_in")
        if expires_in is None:
            # RFC 6749 makes expires_in RECOMMENDED; mirror federation's 3600
            # default but say so, because a short-lived IdP token with an
            # optimistic default risks caching past real expiry.
            logger.warning(
                "Embeddings IdP token response omitted expires_in; assuming %ss",
                DEFAULT_EXPIRES_IN_SECONDS,
            )
            expires_in = DEFAULT_EXPIRES_IN_SECONDS
        self._access_token = token
        self._token_expiry = datetime.now(UTC) + timedelta(seconds=int(expires_in))
        logger.info("Embeddings IdP token refreshed (expires in %ss)", expires_in)
        return token

    def clear_token(self) -> None:
        with self._token_lock:
            self._access_token = None
            self._token_expiry = None

    def __del__(self):
        if hasattr(self, "_http_client"):
            self._http_client.close()


def create_idp_token_manager(settings) -> EmbeddingsIdPTokenManager | None:
    """Factory: returns None unless embeddings IdP mode is enabled.

    With EMBEDDINGS_IDP_ENABLED=false this returns None and the embeddings
    path behaves exactly as before. The repository caches the resulting
    client (and therefore this manager) in self._embedding_model, so one
    token cache serves every embedding call per process.
    """
    if not settings.embeddings_idp_enabled:
        return None
    secret = settings.embeddings_idp_client_secret
    return EmbeddingsIdPTokenManager(
        token_url=settings.embeddings_idp_token_url,
        client_id=settings.embeddings_idp_client_id,
        client_secret=secret.get_secret_value() if secret else "",
        scope=settings.embeddings_idp_scope,
        refresh_buffer_seconds=settings.embeddings_idp_refresh_buffer_seconds,
    )
```

Notes:
- Error messages deliberately contain only `type(exc).__name__` and the HTTP status: no
  URL query, no request body, no secret, no bearer (review finding C1).
- The grant is form-encoded via httpx `data=` (never interpolated into a URL).
- Logging mirrors federation: log the refresh event and the endpoint, never the secret or
  the bearer.

#### Step 3: Per-call bearer injection in LiteLLMClient
**File:** `registry/embeddings/client.py`
**Lines:** `LiteLLMClient.__init__` (~179), `encode()` (~239), factory (~327)

- Add keyword argument `idp_token_manager: EmbeddingsIdPTokenManager | None = None` to
  `LiteLLMClient.__init__`; store it. `client.py` references the manager type only under
  `TYPE_CHECKING` (no runtime import), and the manager module imports nothing from
  `client.py`, so there is no import cycle and the dependency direction is one-way.
- In `encode()`, when `self.idp_token_manager is not None`, set
  `kwargs["api_key"] = self.idp_token_manager.get_token()` before calling
  `litellm.embedding(...)`. When it is `None`, do nothing (exact current behaviour).
- In `create_embeddings_client`, add the same keyword parameter and pass it through in the
  litellm branch only. The sentence-transformers branch ignores it (documented in the
  docstring), matching how `api_key` is handled today.
- When IdP mode is active the constructor must not push `EMBEDDINGS_API_KEY` into the
  provider env var. Guard: `if self.api_key and self.idp_token_manager is None:
  self._set_api_key_env()`. With settings unset both branches reduce to today's behaviour
  (`api_key` is None anyway). (Review finding B2.)

#### Step 4: Wire settings through the repository call site
**File:** `registry/repositories/documentdb/search_repository.py`
**Lines:** `_get_embedding_model` (~664-678)

```python
from ...embeddings import create_embeddings_client, create_idp_token_manager

self._embedding_model = create_embeddings_client(
    provider=settings.embeddings_provider,
    model_name=settings.embeddings_model_name,
    model_dir=settings.embeddings_model_dir,
    api_key=settings.embeddings_api_key,
    api_base=settings.embeddings_api_base,
    aws_region=settings.embeddings_aws_region,
    embedding_dimension=settings.embeddings_model_dimensions,
    idp_token_manager=create_idp_token_manager(settings),
)
```

`create_idp_token_manager` returns `None` when disabled, so the existing call is unchanged
in the default configuration. The lazy import inside the method (current style) keeps
module import cost at zero for non-DocumentDB backends, and the cached `self._embedding_model`
means the manager (and its token cache) is built once per process.

#### Step 5: Config UI masking
**File:** `registry/api/config_routes.py`
**Lines:** `CONFIG_GROUPS["embeddings"]["fields"]` (~176)

Append tuples so the new values render (secret masked):

```python
("embeddings_idp_enabled", "IdP Enabled", False),
("embeddings_idp_token_url", "IdP Token URL", False),
("embeddings_idp_client_id", "IdP Client ID", False),
("embeddings_idp_client_secret", "IdP Client Secret", True),
("embeddings_idp_scope", "IdP Scope", False),
("embeddings_idp_refresh_buffer_seconds", "IdP Refresh Buffer (s)", False),
```

The `True` on the secret reuses the existing masking pipeline (`_mask_sensitive_value`,
env export commenting). No new masking code.

#### Step 6: Docker surface
**Files:** `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml`,
`docker/registry-entrypoint.sh`

Compose registry service env block (mirroring the `EMBEDDINGS_API_KEY` line):

```yaml
      - EMBEDDINGS_IDP_ENABLED=${EMBEDDINGS_IDP_ENABLED:-false}
      - EMBEDDINGS_IDP_TOKEN_URL=${EMBEDDINGS_IDP_TOKEN_URL:-}
      - EMBEDDINGS_IDP_CLIENT_ID=${EMBEDDINGS_IDP_CLIENT_ID:-}
      - EMBEDDINGS_IDP_CLIENT_SECRET=${EMBEDDINGS_IDP_CLIENT_SECRET:-}
      - EMBEDDINGS_IDP_SCOPE=${EMBEDDINGS_IDP_SCOPE:-}
      - EMBEDDINGS_IDP_REFRESH_BUFFER_SECONDS=${EMBEDDINGS_IDP_REFRESH_BUFFER_SECONDS:-60}
```

Entrypoint: in the litellm banner branch, add `echo "  IdP auth: $EMBEDDINGS_IDP_ENABLED"`
and, when enabled, echo the token endpoint (it is not a secret) but never the client
secret. Keep it a pure echo - the Settings class owns validation.

#### Step 7: Terraform/ECS surface
**Files:** `terraform/aws-ecs/modules/mcp-gateway/{variables.tf,ecs-services.tf,secrets.tf,iam.tf}`

- `variables.tf`: five non-secret variables (`embeddings_idp_enabled` bool default false,
  `embeddings_idp_token_url`, `embeddings_idp_client_id`, `embeddings_idp_scope` strings
  default `""`, `embeddings_idp_refresh_buffer_seconds` number default 60) plus
  `embeddings_idp_client_secret` (string, default `""`, `sensitive = true`), following the
  `embeddings_api_key` precedent.
- `ecs-services.tf`: plain `environment` entries for the five non-secrets next to the
  `EMBEDDINGS_PROVIDER` block; a `valueFrom` entry for the client secret next to
  `EMBEDDINGS_API_KEY`.
- `secrets.tf`: `aws_secretsmanager_secret.embeddings_idp_client_secret` + version, with
  `secret_string = var.embeddings_idp_client_secret != "" ? var.embeddings_idp_client_secret :
  "not-configured"` (same pattern as `embeddings_api_key`).
- `iam.tf`: add the new secret ARN to the statement that lists
  `aws_secretsmanager_secret.embeddings_api_key.arn`.

#### Step 8: Helm documentation
**Files:** `docs/unified-parameter-reference.md` (Group 20), `docs/embeddings.md`

The registry chart intentionally has no native embedding values; `EMBEDDINGS_*` reach the
pod via `extraEnv` / `extraEnvFrom` (validated, reserved-name-checked). Document:

```yaml
# values.yaml (registry subchart)
extraEnv:
  - name: EMBEDDINGS_IDP_ENABLED
    value: "true"
  - name: EMBEDDINGS_IDP_TOKEN_URL
    value: "https://idp.example.com/oauth2/token"
  - name: EMBEDDINGS_IDP_CLIENT_ID
    value: "embeddings-client"
extraEnvFrom:
  - secretRef:
      name: embeddings-idp   # must expose EMBEDDINGS_IDP_CLIENT_SECRET
```

#### Step 9: Docs (dimension / re-index caveat)
**Files:** `docs/embeddings.md`, `docs/unified-parameter-reference.md`

- Add the six parameters to the env-var table and the Group 20 table (Terraform names
  `embeddings_idp_*`; Helm column points at `extraEnv` / `extraEnvFrom`).
- New "IdP-authenticated endpoints" section: the client-credentials flow, the buffer
  behaviour, the fail-fast requirements, secret handling, the buffer-sizing guidance
  (>= 60 seconds recommended so clock skew cannot serve an already-expired token), and the
  caveat: switching to an IdP-gated endpoint usually changes the embedding model and
  therefore its dimension; existing vectors must be re-indexed (or collected under the new
  dimension) or hybrid search quality degrades - cross-reference the switching-models FAQ.

### Error Handling
- Startup: `ValueError` with the exact missing env names (fail fast, actionable).
- Token fetch failures raise `EmbeddingsIdPTokenError`; `LiteLLMClient.encode` wraps it in
  the existing `RuntimeError` funnel, which the repository already latches as
  `_embedding_unavailable` for search paths (indexing retries keep working).
- No silent fallback to the static key when IdP mode is enabled: a token failure must be
  loud, not a downgrade to a credential that is known-absent.

### Logging
- Token manager logs the refresh event and the token endpoint at debug/info. Never the
  secret, never the bearer, never a full URL with query string.
- Failure logs include HTTP status / exception type only (see Step 2 note).

## Observability
- The existing `embeddings_provider` telemetry tag stays; IdP mode is visible via the
  config API (masked) and the startup banner.
- Key log events: first token fetch, each proactive refresh, token-endpoint failures (with
  status). No new metrics required for this scope.

## Scaling Considerations
- Single-flight refresh: the lock guarantees one in-flight token request per process;
  concurrent `encode` calls serialize only on the cache check (microseconds) or on a
  refresh (one HTTP round-trip per buffer window).
- Multi-replica deployments each hold their own cache; token endpoint load is bounded by
  `replicas / (token_lifetime - buffer)` requests per interval, negligible for typical
  60-minute IdP tokens with a 60-second buffer.
- The `httpx.Client` is created per manager instance (one per repository client), matching
  federation's footprint.

## File Changes

### New Files

| File Path | Description |
|-----------|-------------|
| `registry/embeddings/idp_token_manager.py` | Thread-safe OAuth2 client-credentials token manager + factory |
| `tests/unit/embeddings/test_idp_token_manager.py` | Unit tests for the manager (caching, buffer, thread-safety, error handling, no-secret-in-logs) |

### Modified Files

| File Path | Lines | Change Description |
|-----------|-------|--------------------|
| `registry/core/config.py` | ~426, ~1836 | Six new settings; `_validate_embeddings_idp_config()` called in `__init__` |
| `registry/embeddings/client.py` | ~179, ~239, ~327 | `idp_token_manager` kwarg; per-call `api_key` injection; env-var push guarded; factory pass-through |
| `registry/embeddings/__init__.py` | 3-15 | Export `EmbeddingsIdPTokenManager`, `EmbeddingsIdPTokenError`, `create_idp_token_manager` |
| `registry/repositories/documentdb/search_repository.py` | ~664 | Forward `idp_token_manager` from settings |
| `registry/api/config_routes.py` | ~176 | Six new field tuples (secret sensitive) |
| `docker-compose.yml`, `docker-compose.prebuilt.yml`, `docker-compose.podman.yml` | registry env block | Six new env entries |
| `docker/registry-entrypoint.sh` | ~290 | Banner echo (no secret) |
| `terraform/aws-ecs/modules/mcp-gateway/variables.tf` | ~342 | Five plain + one sensitive variable |
| `terraform/aws-ecs/modules/mcp-gateway/ecs-services.tf` | ~1069, ~1798 | Plain env + secret `valueFrom` entries |
| `terraform/aws-ecs/modules/mcp-gateway/secrets.tf` | ~190 | New Secrets Manager resource + version |
| `terraform/aws-ecs/modules/mcp-gateway/iam.tf` | ~21 | Grant on the new secret ARN |
| `docs/unified-parameter-reference.md` | Group 20 | New parameter rows + Helm mechanism |
| `docs/embeddings.md` | ~90, new section | Env table rows + IdP section + re-index caveat |
| `tests/unit/embeddings/test_embeddings_client.py` | factory section | Tests for the new factory kwarg and injection behaviour |

### Estimated Lines of Code

| Category | Lines |
|----------|-------|
| New code | ~170 |
| New tests | ~260 |
| Modified code | ~90 |
| Docs / deployment surface | ~120 |
| **Total** | **~640** |

## Testing Strategy
See `testing.md`. Highlights: unit tests for the manager (cache hit, buffer refresh,
thread-safety with a barrier, HTTP-error classes, non-JSON body, missing access_token,
clear_token, no-secret-in-logs via `caplog`), injection tests on `LiteLLMClient.encode`
(kwargs assertion via monkeypatched `litellm.embedding`), factory pass-through tests,
Settings validation tests (enabled-but-missing, bad URL scheme, negative buffer, disabled
ignores everything), and grep-based backwards-compatibility checks.

## Alternatives Considered

### Alternative 1: Static key rotation via external refresher process
**Description:** Keep `EMBEDDINGS_API_KEY` and refresh the environment out-of-band (sidecar
or cron rewriting the env file and restarting).
**Pros / Cons:** No code change / restart per rotation, env vars leak to child processes,
poor operational story, races with running workers.
**Why Rejected:** The task explicitly calls for a token provider that supplies the bearer
per call without environment variables.

### Alternative 2: Async token manager with prefetch task
**Description:** An asyncio task prefetches tokens; callers await a cached future.
**Pros / Cons:** No refresh latency on the hot path / more moving parts, needs an event
loop at construction, diverges from the federation pattern this task says to mirror.
**Why Rejected:** The LiteLLM call here is synchronous; the buffer means refresh cost lands
on at most one call per window. Threaded single-flight is sufficient and matches the
codebase's existing pattern.

### Alternative 3: Custom httpx client replacing LiteLLM
**Description:** Bypass LiteLLM and implement the OpenAI embeddings HTTP calls directly.
**Pros / Cons:** Total auth control / re-implements retry, routing, and provider quirks the
task explicitly wants to keep ("keep the existing LiteLLM request/response path").
**Why Rejected:** Out of scope by definition.

### Comparison Matrix

| Criteria | Chosen (per-call api_key + manager) | Alt 1 (env rotation) | Alt 2 (async prefetch) | Alt 3 (custom client) |
|----------|-------------------------------------|----------------------|------------------------|------------------------|
| Complexity | Low | High | Medium | High |
| Matches repo pattern | Yes (mirrors federation) | No | No | No |
| Secret-in-env risk | Removed on IdP path | Kept | Removed | Removed |
| Wire format change | None | None | None | Yes |
| Multi-replica safe | Yes | Partially | Yes | Yes |

## Rollout Plan
- Phase 1: Implementation (this change; default-off).
- Phase 2: Testing per `testing.md` (unit + manual docker-compose run).
- Phase 3: Deployment - operators opt in by setting the six variables on their surface of
  choice; rollback is unsetting `EMBEDDINGS_IDP_ENABLED` (behaviour reverts to the static
  key path with no data migration).

## Open Questions
- Should a 401 from the embedding endpoint trigger `clear_token()` + a single retry? Left
  as a follow-up (documented in the issue's Out of Scope).
- Should IdP token fetches be counted in metrics? Deferred until there is a consumer.

## References
- `registry/services/federation/federation_auth.py` (pattern being mirrored)
- LiteLLM per-call `api_key` parameter documentation
- `docs/faq/switching-embedding-models.md` (re-index caveat)
- Issue #1415
