# Testing Plan: `egress-configure` custom-provider OAuth flags

*Created: 2026-09-29*
*Related LLD: `./lld.md`*
*Related Issue: `./github-issue.md`*

## Overview

### Scope of Testing
The change is CLI-side only: five new flags on `egress-configure`, forwarded through
`RegistryClient.configure_egress_auth` to the unchanged
`POST /api/servers/{path}/egress-auth` endpoint. Testing therefore concentrates on (a)
the request body the client produces, (b) the handler's pass-through wiring, (c)
argparse acceptance/validation, and (d) end-to-end behavior against a running registry
where available.

### Prerequisites
- [ ] Python environment with the repo's dev dependencies (`uv sync`)
- [ ] For E2E checks: a running registry with the egress-auth feature enabled and admin
      credentials (see repo docs; skip if unavailable - sections marked accordingly)
- [ ] No new services, tokens, or fixtures are required by the unit tests

### Shared Variables
```bash
REGISTRY_URL="https://registry.example.test"   # E2E only
REGISTRY_DIR="$(git rev-parse --show-toplevel)"
AUTHORIZE_URL="https://tenant.example.com/oauth2/authorize"
TOKEN_URL="https://tenant.example.com/oauth2/token"
RESOURCE_URI="https://api.example.com"
```

## 1. Functional Tests

### 1.1 CLI / HTTP Tests (unit level, executable)

These are the automated tests added by the patch
(`tests/unit/api/test_egress_configure_cli_custom_flags.py`). Run with:

```bash
cd "$REGISTRY_DIR"
uv run pytest tests/unit/api/test_egress_configure_cli_custom_flags.py -v
```

**1.1.1 Client sends all five custom fields when supplied**

```python
client = RegistryClient("https://reg.example", "tok")
with patch("api.registry_client.requests.request") as req:
    req.return_value = _mock_response({})  # status 200, .json() -> {}
    client.configure_egress_auth(
        server_path="/github",
        mode="oauth_user",
        provider="custom",
        client_id="cid",
        client_secret="sek",
        scopes=["openid"],
        custom_authorize_url="https://t.example/a",
        custom_token_url="https://t.example/t",
        custom_scope_separator=" ",
        custom_token_auth_style="post_body",
        custom_resource="https://api.example",
    )
body = req.call_args.kwargs["json"]
assert body["custom_authorize_url"] == "https://t.example/a"
assert body["custom_token_url"] == "https://t.example/t"
assert body["custom_scope_separator"] == " "
assert body["custom_token_auth_style"] == "post_body"
assert body["custom_resource"] == "https://api.example"
assert body["egress_auth_mode"] == "oauth_user"
assert body["egress_provider"] == "custom"
assert req.call_args.kwargs["url"].endswith("/api/servers/github/egress-auth")
```

Expected: all assertions pass. Pre-fix expectation: `TypeError: unexpected keyword
argument 'custom_authorize_url'` (test fails - this is the desired failing state).

**1.1.2 Omitted custom flags produce no payload keys (negative case)**

```python
with patch("api.registry_client.requests.request") as req:
    req.return_value = _mock_response({})
    client.configure_egress_auth(server_path="/github", mode="none")
body = req.call_args.kwargs["json"]
assert set(body) == {"egress_auth_mode"}
for key in (
    "custom_authorize_url", "custom_token_url", "custom_scope_separator",
    "custom_token_auth_style", "custom_resource",
):
    assert key not in body        # absent, not null
    assert body.get(key) is not None or key not in body
```

Expected: only `egress_auth_mode` in the body; no `None` values anywhere.

**1.1.3 Falsy-but-valid values are still sent**

```python
with patch("api.registry_client.requests.request") as req:
    req.return_value = _mock_response({})
    client.configure_egress_auth(
        server_path="/github", mode="oauth_user", provider="custom",
        custom_scope_separator=" ", custom_token_auth_style="basic_header",
    )
body = req.call_args.kwargs["json"]
assert body["custom_scope_separator"] == " "          # falsy but valid
assert body["custom_token_auth_style"] == "basic_header"
```

Expected: the single-space separator is not dropped (guards must be `is not None`).

**1.1.4 Handler forwards the new namespace attributes**

```python
ns = argparse.Namespace(
    path="/github", mode="oauth_user", provider="custom",
    client_id="cid", client_secret="sek", scopes="openid,profile",
    target_audience=None,
    custom_authorize_url="https://t.example/a",
    custom_token_url="https://t.example/t",
    custom_scope_separator=None,
    custom_token_auth_style="post_body",
    custom_resource=None,
)
with patch("api.registry_management.RegistryClient") as rc:
    rc.return_value.configure_egress_auth.return_value = {"ok": True}
    rc.return_value.get_access_token.return_value = "tok"
    with patch("api.registry_management._get_token", return_value="tok", create=True):
        rc_reset = patch("api.registry_management.RegistryClient", rc)
        code = cmd_egress_configure(ns)
assert code == 0
kwargs = rc.return_value.configure_egress_auth.call_args.kwargs
assert kwargs["custom_authorize_url"] == "https://t.example/a"
assert kwargs["custom_token_url"] == "https://t.example/t"
assert kwargs["custom_scope_separator"] is None
assert kwargs["custom_token_auth_style"] == "post_body"
assert kwargs["custom_resource"] is None
assert kwargs["provider"] == "custom"
```

(The exact patch points used in the added tests follow the module's actual
`_create_client` implementation; the assertion targets are the five custom kwargs plus
`scopes` parsed from the comma string.)

**1.1.5 Parser accepts the new flags and rejects a bad auth style**

```python
# Valid parse: main() exits 0 with the client patched out.
argv = [
    "registry_management.py", "--registry-url", "https://reg.example",
    "egress-configure", "--path", "/github", "--mode", "oauth_user",
    "--provider", "custom", "--client-id", "cid", "--client-secret", "sek",
    "--custom-authorize-url", "https://t.example/a",
    "--custom-token-url", "https://t.example/t",
    "--custom-token-auth-style", "post_body",
    "--custom-resource", "https://api.example",
]
with patch.object(sys, "argv", argv), patch("api.registry_management.RegistryClient"):
    assert main() == 0

# Invalid choice: argparse exits 2 before any network call.
bad = argv[:7] + ["--custom-token-auth-style", "header", *argv[7:]]
# (rebuild argv with the bad value substituted)
with patch.object(sys, "argv", bad), pytest.raises(SystemExit) as exc:
    main()
assert exc.value.code == 2
```

Expected: `main()` returns 0 on the valid invocation; the invalid auth style exits with
code 2 and a usage message listing `post_body`/`basic_header`.

### 1.2 CLI Tests (manual, against a running registry - E2E optional)

```bash
cd "$REGISTRY_DIR/api"
uv run python registry_management.py \
  --registry-url "$REGISTRY_URL" egress-configure \
  --path /github --mode oauth_user --provider custom \
  --client-id cid --client-secret sek --scopes "openid,profile" \
  --custom-authorize-url "$AUTHORIZE_URL" \
  --custom-token-url "$TOKEN_URL" \
  --custom-scope-separator " " \
  --custom-token-auth-style post_body \
  --custom-resource "$RESOURCE_URI"
```

Expected: exit 0; JSON output shows `egress_provider: "custom"` and the stored custom
fields echoed by the non-secret config view.

Negative (server-enforced, documents the 400 path):

```bash
# http URL is rejected by the SSRF guard (exit 1, server 400 detail logged)
uv run python registry_management.py --registry-url "$REGISTRY_URL" egress-configure \
  --path /github --mode oauth_user --provider custom --client-id cid --client-secret sek \
  --custom-authorize-url "http://tenant.example.com/a" \
  --custom-token-url "$TOKEN_URL"
```

## 2. Backwards Compatibility Tests

**Applicable** - the client method signature and the CLI command are existing surfaces.

- **2.1 Existing invocations unchanged:** calling `configure_egress_auth(server_path,
  mode)` with no optional kwargs sends exactly `{"egress_auth_mode": mode}` (covered by
  test 1.1.2).
- **2.2 CLI without new flags behaves as before:** `egress-configure --path /x --mode
  none` still exits 0 (server accepts mode none) and sends no custom keys.
- **2.3 Positional compatibility:** existing positional calls
  `configure_egress_auth("/github", "oauth_user", "github", "cid", "sek", ["repo"])`
  keep working (new params are appended with defaults).
- **2.4 No endpoint/method change:** the URL and method asserted in test 1.1.1 are
  `POST /api/servers/{encoded}/egress-auth`, byte-identical to pre-change.

## 3. UX Tests

**Applicable** - CLI output surfaces.

- **3.1 `--help` lists the five flags** with descriptions:
  ```bash
  uv run python registry_management.py egress-configure --help | grep -- "--custom-"
  ```
  Expected: five `--custom-*` lines; the auth-style help shows the valid choices.
- **3.2 Invalid auth style fails locally with a clear message:** see test 1.1.5; the
  stderr usage text names `{post_body,basic_header}`.
- **3.3 Success output is unchanged in shape:** the command prints the server's JSON
  config view (same keys as before, plus custom fields now populated).

## 4. Deployment Surface Tests

**Not Applicable** - no new configuration parameters on any surface: no env vars, no
compose/Terraform/Helm values, no image or schema changes (per LLD Deployment Surface
Checklist).

## 5. End-to-End API Tests

**Applicable when a registry is running; otherwise marked as the manual follow-up.**

- **5.1 CLI-to-server round trip:** run the 1.2 success command against a live registry
  with an https-enabled custom provider stub, then
  ```bash
  uv run python registry_management.py --registry-url "$REGISTRY_URL" egress-config-get --path /github
  ```
  Expected: the config view shows `egress_provider: "custom"`,
  `custom_authorize_url`, `custom_token_url`, and `custom_resource` as configured.
- **5.2 Edit without clobbering:** re-run 1.2 with `--scopes` changed but without
  `--custom-resource`. Expected: `custom_resource` remains the previously stored value
  (proves omitted flags did not send nulls).
- **5.3 Server still rejects bad configs:** repeat the 1.2 negative case; expected 400
  with the SSRF-guard detail and CLI exit 1 (unchanged server behavior).

## 6. Test Execution Checklist
- [ ] Section 1 (Functional) passes - `uv run pytest tests/unit/api/test_egress_configure_cli_custom_flags.py -v`
- [ ] Section 2 (Backwards Compat) verified (tests 1.1.2 + 1.1.1 cover 2.1/2.4; manual for the rest if a registry is available)
- [ ] Section 3 (UX) verified or marked manual (`--help` grep is copy-pasteable)
- [ ] Section 4 (Deployment) marked Not Applicable
- [ ] Section 5 (E2E) verified or marked manual (requires a live registry)
- [ ] Unit tests added under `tests/unit/api/`
- [ ] `uv run pytest tests/` passes with no regressions

Per the benchmark skill constraints, tests were designed but NOT executed; execution is
out of scope for the run that produced this plan.
