# Expert Review: `egress-configure` custom-provider OAuth flags

*Created: 2026-09-29*
*Reviewed artifacts: `github-issue.md`, `lld.md` (pre-review draft), target repo at tag `1.28.0`*

---

## Frontend Engineer (Pixel)

Focus: CLI/UX surfaces, help text, error messaging, interaction consistency.

### Strengths
- Five explicit flags with per-field help text beat any JSON-blob alternative for
  discoverability; `--help` remains self-documenting.
- Reusing the flat flag style of every other `registry_management.py` subcommand keeps
  the CLI mentally uniform.

### Concerns
1. **Should fix (UX, error locality):** `--custom-token-auth-style` must use argparse
   `choices`. Without it, a typo like `--custom-token-auth-style body` travels to the
   server and comes back as a confusing 400 during `resolve_provider`. Argparse choices
   turn it into an immediate usage error with the valid values listed.
2. **Nice to have:** the help text for the URL flags should mention "https required"
   since the server rejects plain-http URLs (SSRF guard); saves one round trip of
   confusion.
3. **Acceptance:** scope-separator values like a literal space are awkward to pass on a
   shell (`--custom-scope-separator " "` works fine quoted); help text should not imply a
   default change when the flag is omitted.

### New libraries / infra dependencies
None.

### Better alternatives considered
None within scope; a prompt-driven interactive mode is out of scope for this CLI.

### Questions for author
- Should omitted flags on an edit visibly "keep stored value"? (Answer per LLD: yes, by
  omission from the payload - the server keeps prior values for absent fields.)

### Verdict
**APPROVED WITH CHANGES** - the argparse `choices` constraint is required before
implementation.

---

## Backend Engineer (Byte)

Focus: API contract fidelity, client design, payload semantics, tests.

### Strengths
- The field mapping is exactly the server's `EgressConfigRequest` surface; no invented
  fields, no endpoint or method change.
- The "only send what was supplied" convention matches how
  `update_auth_credential` and the m2m client update methods already build payloads, and
  it is the correct edit semantics for this endpoint (the server keeps prior stored
  values for absent fields).

### Concerns
1. **Must fix (correctness):** The client body guards must be `is not None`, not truthy
   checks. `if custom_scope_separator:` would drop an intentionally supplied `" "` (a
   single space is a legitimate separator and is falsy). Same reasoning applies to all
   five new fields; note the pre-existing code already uses `if client_secret is not
   None:` style for exactly this reason.
2. **Should fix (test design):** Tests must assert the negative case, not only the
   positive one: omitted flags produce *no key* (not `"key": null`). A `null` would be
   accepted by `EgressConfigRequest` (`str | None`) and would clobber server-side
   defaults on edit - the exact regression the issue warns about.
3. **Should fix (signature safety):** New parameters must be appended after
   `target_audience` with `None` defaults, keeping every existing positional call
   working. The LLD's signature does this; keep it that way in the patch.
4. **Note:** the endpoint receives JSON (the `_make_request` `/egress-auth` branch), so
   "omitted vs null" is directly observable server-side; the payload discipline is not
   cosmetic.

### New libraries / infra dependencies
None.

### Better alternatives considered
- Passing a pre-built `extra: dict` through the client: rejected - loses the typed
  signature, help text parity, and the choices validation site.

### Questions for author
- None; payload semantics are now pinned by the tests.

### Verdict
**APPROVED WITH CHANGES** - the `is not None` guard requirement and negative payload
tests are must-fix/should-fix before implementation.

---

## SRE/DevOps Engineer (Circuit)

Focus: operability, rollout, deployment surface, monitoring.

### Strengths
- Zero deployment-surface change: no new env vars, config files, images, or schema
  migrations. The change ships and rolls back with the CLI alone.
- The endpoint is unchanged, so canary/rollback analysis is trivial - no behavioral delta
  for existing invocations (all new parameters default to `None` and emit no payload
  keys).

### Concerns
1. **Nice to have:** because `--client-secret` is already a plain CLI flag in this
   command, the new flags do not worsen the secret-handling story, but operators should
   be reminded (docs follow-up, not this patch) that secrets on argv are visible in
   process listings. Pre-existing pattern; not a blocker.
2. **Note:** no new metrics/logs. Failures remain CLI-exit-code-1 with a logged error,
   same as today; alerting surfaces are unaffected.

### New libraries / infra dependencies
None.

### Better alternatives considered
None; the minimal-diff approach is exactly right for ops.

### Questions for author
- None.

### Verdict
**APPROVED**

---

## Security Engineer (Cipher)

Focus: injection surface, secret handling, validation boundaries, SSRF posture.

### Strengths
- The change adds pure pass-through fields to an existing admin-only, CSRF-checked,
  auth-gated endpoint. All validation (https-only URLs, SSRF structural guard,
  `resolve_provider`, RFC 8707 resource check, secret encryption) stays server-side where
  it already exists and is tested.
- Not duplicating URL validation in the CLI avoids a false sense of safety and prevents
  drift from the server's `PROXY_PROFILE` rules.

### Concerns
1. **Must fix (do not weaken the boundary):** The patch must not add any client-side
   "allow http for testing" escape hatch or local allowlist for the custom URLs. The LLD
   already lists this in Non-Goals; implementation must not grow one.
2. **Should fix (secret hygiene parity):** `custom_token_auth_style` governs where
   `client_secret` goes on the token POST. Constraining to argparse `choices`
   (`post_body`/`basic_header`) prevents arbitrary strings from reaching
   `resolve_provider`; this is the same value set the server enum accepts, so the CLI is
   not stricter or looser than the server.
3. **Note:** `--custom-resource` is reflected into authorize/token requests by the
   server's design; the server already enforces absolute-https-no-fragment. CLI-side
   silence is correct here.
4. **Note (positive):** no `null`-payload regression also protects audit trails - an
   accidental edit cannot silently blank a stored provider config.

### New libraries / infra dependencies
None.

### Better alternatives considered
None; server-authoritative validation is the right boundary.

### Questions for author
- None.

### Verdict
**APPROVED WITH CHANGES** - conditional on keeping validation server-side (no client
bypass flags) and on the argparse choices constraint.

---

## SMTS (Sage)

Focus: architecture, code quality, maintainability, test value.

### Strengths
- The smallest change that restores parity: three touch points (parser, handler, client)
  in one direction each, no new abstraction. Diff stays reviewable in one sitting.
- Tests are structured to fail on the pre-fix tree at three independent layers (client
  payload, handler wiring, parser acceptance), so a partial implementation cannot pass
  the suite.

### Concerns
1. **Must fix (review-loop item):** the pre-review draft did not explicitly pin the
   `is not None` guard style or the argparse `choices` for the auth-style flag. Both are
   now incorporated into the LLD (Implementation Details Step 1 and Step 3) - guards use
   `is not None` and `--custom-token-auth-style` carries
   `choices=["post_body", "basic_header"]`.
2. **Should fix (test ergonomics):** the CLI module imports `registry_client` as a
   top-level sibling (script-style execution from `api/`), so tests must patch the
   CLI module's imported `RegistryClient` symbol rather than rely on package-relative
   import paths; this is noted in the LLD's constraints so the tests do not fight the
   import model.
3. **Nice to have:** keep the patch free of drive-by refactors in the two touched files;
   both are large and shared.

### New libraries / infra dependencies
None.

### Better alternatives considered
- A generic `**extra_fields` sink on the client method: rejected - it erases the typed
  contract that makes the CLI-to-server parity auditable.

### Questions for author
- None.

### Verdict
**APPROVED WITH CHANGES** - LLD revisions (guards + choices + test import note) are
recorded and incorporated.

---

## Review Summary

| Reviewer | Verdict | Blocking Findings | Key Recommendations |
|----------|---------|-------------------|---------------------|
| Frontend (Pixel) | APPROVED WITH CHANGES | 1 (should-fix, absorbed) | argparse `choices` for `--custom-token-auth-style`; mention https in URL help |
| Backend (Byte) | APPROVED WITH CHANGES | 1 must-fix + 2 should-fix | `is not None` guards; assert omitted keys are absent (not null); append-only signature |
| SRE (Circuit) | APPROVED | 0 | None - no deployment surface change |
| Security (Cipher) | APPROVED WITH CHANGES | 1 (constraint) | Keep validation server-side; choices mirror the server enum |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 (resolved) | LLD revised with guard style, choices, and test import note |

### Next Steps
All blocking and should-fix findings were folded back into `lld.md` before
implementation (Step 7.5 loop):

- Guards in `configure_egress_auth` use `if value is not None:` (Byte must-fix, Sage).
- `--custom-token-auth-style` uses argparse `choices=["post_body", "basic_header"]`
  (Pixel, Cipher).
- Tests assert omitted flags produce no payload key (Byte should-fix) and patch the CLI
  module's `RegistryClient` symbol to respect the script-style import model (Sage
  should-fix).

No blocking findings remain; proceeding to implementation.

No new dependencies proposed by any reviewer.
