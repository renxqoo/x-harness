# Expert Review: Fix reserved-variable GROUPS assignment in Keycloak setup scripts

*Created: 2026-09-29*
*Reviewed artifacts: `./github-issue.md`, `./lld.md`, target scripts at tag `1.27.1`*

## Frontend Engineer (Pixel)

Focus: CLI output, operator-facing surfaces, UX of the setup flow.

**Strengths**
- The fix restores the operator-visible verification output (`Service account groups: ...`, the green membership and mapper lines) that today never prints - that output is the entire point of `verify_setup()` and is the operator's only per-run evidence that authorization is wired correctly.
- No wording, color, or flow changes; `docs/macos-setup-guide.md` screenshots and muscle memory stay valid. The success banner (`SUCCESS! Agent service account setup complete.`) becomes reachable again, which is what the guided flow expects to see.

**Concerns**
- (minor) On success, operators will now see a multi-line group listing and two extra green lines that have never printed before on a first run. This is additive, correct output, but anyone diffing run transcripts against old captures will see new lines. Worth a sentence in release notes; not a design change.
- (minor, pre-existing) Line 17 of `setup-agent-service-account.sh` interpolates `${RED}`/`${NC}` before the constants are defined (lines 24-29), so the "password required" error prints uncolored. Correctly listed as a Non-Goal; do not fold it into this patch.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** None at the output layer; the text is deliberately unchanged.

**Recommendations**
- Keep every user-visible string byte-identical except the previously-dead lines coming alive.

**Questions for author**
- None.

**Verdict:** APPROVED

## Backend Engineer (Byte)

Focus: shell semantics, script logic, correctness of the membership check.

**Strengths**
- Root cause is exactly right and empirically demonstrated: `GROUPS` is a bash reserved array; scalar assignment fails under `set -e` (reproduced on bash 3.2.57). The chosen fix (safe name + `local` + split declaration) removes both the abort and the latent SC2128 first-element expansion.
- The declaration/assignment split is the correct `set -e` interaction; `local var=$(cmd)` would mask curl/jq failures. The LLD calls this out explicitly and puts the warning in a code comment where the next "simplification" attempt will see it.
- Upgrading the membership check to `grep -Fxq` is the right call, not gold-plating: the task explicitly says the old check is latently wrong and must compare against the real group names. Exact-line matching also removes the substring false-positive class (verifying `mcp-servers-finance` while the account is in `mcp-servers-finance/read` would previously pass) and, with `-F`, removes regex-metacharacter surprises from group names.

**Concerns**
1. **(should-fix, portability)** The LLD should state explicitly that the combined short flags in `grep -Fxq` must work on both GNU grep and the macOS BSD grep, since bash 3.2 on macOS implies BSD userland. They are supported by both, but the constraint belongs in the LLD's Constraints section so an implementer does not "port" it to long flags inconsistently.
2. **(should-fix, parity)** Both scripts must receive the identical comment + declaration block. The m2m script is the one most likely to be missed because its bug produces the same silent failure and it has fewer steps; the LLD says "identical", and the implementation diff must show it.
3. **(informational)** Empty group list from a transport failure now reports `✗ Service account is NOT in '<group>' group` - slightly misattributed (it was a read failure, not a membership failure), but legible and exit-1 either way. Acceptable for an operator script; documented in the LLD Error Handling section.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** `mapfile` arrays (rejected: bash 4+ only); keeping substring `grep -q` (rejected: leaves the check the task calls latently wrong).

**Recommendations**
- In testing, exercise `verify_setup()` in both directions with a stubbed harness (membership present -> exit 0 and output printed; absent -> exit 1) before any live Keycloak run.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

## SRE/DevOps Engineer (Circuit)

Focus: automation contracts, failure modes, platform compatibility, blast radius.

**Strengths**
- Restores the exit-code contract (0 = success) that the macos-setup skill and any CI wrapper depend on; a wrong exit code is worse than a loud failure because it is a lie that propagates.
- bash 3.2 compatibility treated as a hard constraint; nothing bash-4+ is introduced.
- The sweep is done with evidence (table with dispositions, including why `IFS='x' read` prefixes and `ENV_FILE` are not violations), so "sweep the setup scripts" closes verifiably.

**Concerns**
1. **(should-fix, tracked follow-up)** The same `GROUPS=` latent bug exists in `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126` and WILL abort under `set -e` when `list_groups()` runs. Deferring is defensible (not setup scripts; one is deprecated) but the follow-up must be recorded with file:line in `implementation.md` so the next PR is mechanical. The issue and LLD already name both; keep it that way.
2. **(minor)** No shellcheck gate exists, so SC2178/SC2128 can silently return. A one-line CI addition is the cheap systemic fix; out of scope here, Rollout Phase 3.
3. **(minor)** Verification still makes two admin API calls, unchanged; no operational load concern.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Adding CI shellcheck in this patch - rejected as scope creep; recommended as follow-up.

**Recommendations**
- Static verification should include `bash -n` on both bash 3.2 and bash 5.x, `git apply --check` of the final patch, and a post-fix re-run of the reserved-variable sweep.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

## Security Engineer (Cipher)

Focus: validation, secret handling, false-assurance risk in auth tooling.

**Strengths**
- The patch strengthens an authorization verification: exact-line membership matching eliminates a false-positive path where `verify_setup()` could print a green `✓` for a group the account is not actually in (prefix overlap). A verification function that can pass wrongly is an auth-tooling defect, so this is a genuine (if small) security improvement, not just robustness.
- `-F` (fixed-string) matching means a group name containing regex metacharacters cannot alter what the check matches - removes a (theoretical) pattern-injection wrinkle in a privileged script.
- No new inputs, no new privilege, no secrets touched; behavior is otherwise narrowed to "correct exit code + restored output".

**Concerns**
1. **(informational)** Failure message misattribution on transport errors (same as Byte-3): an operator debugging an outage sees "NOT in group" when the real problem was the admin API being unreachable. Documented; acceptable.
2. **(informational, pre-existing)** `assign_to_group()` still uses substring matching for its pre-check. That function's job is idempotency (skip re-assign), not verification, and a false "already assigned" there would still be caught by the now-exact `verify_setup()` - the layered check makes this acceptable. Noted as the natural next step if the team ever tightens it.
3. **(informational, pre-existing)** The summary prints a 10-char secret prefix (`${AGENT_CLIENT_SECRET:0:10}`) and the token file contains the full secret; unchanged by this patch.

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** None; no security-relevant alternatives needed.

**Recommendations**
- None for this patch.

**Questions for author**
- None.

**Verdict:** APPROVED

## SMTS (Sage)

Focus: architecture, minimality, review integrity, requirement fidelity.

**Strengths**
- Requirement fidelity is high. The task has three explicit demands - exit 0 on success, print the verification output, check membership against the real group names - and the design maps one-to-one onto them: rename+local (exit 0), preserved output lines (print), `grep -Fxq` on the scalar (real names). The sweep requirement is closed with a table, not an assertion.
- Minimal, inspection-verifiable diff: two functions, each a rename plus declaration split plus one flag change. The estimated LOC (~20) is honest.
- The `set -e` / `local` masking pitfall - the most commonly botched detail in exactly this fix - is handled and documented in the LLD and in the code comment.

**Concerns**
1. **(must-satisfy, consistency)** The LLD's Alternatives section originally reasoning against exact-match (in earlier drafts of this class of fix) must not contradict the chosen design: since the task text itself declares the old membership check latently wrong, `grep -Fxq` is requirement-driven, and the Alternatives entry for "keep substring grep" must be recorded as rejected for that reason (it is). Keep the Comparison Matrix consistent with the final design.
2. **(should-fix, doc)** Byte-1's grep-portability note should land in the LLD Constraints section before implementation, so the design and the code cannot drift.
3. **(minor)** Scoping: deferring the two `user_mgmt.sh` fixes is correct - the task says "the setup scripts", and those are not setup scripts - provided the finding stays visible in issue + LLD + implementation.md (it does in the first two; `implementation.md` must repeat it).

**New libraries / infra dependencies required:** None.

**Better alternatives considered:** Repo-wide reserved-variable lint - nice-to-have, deferred to the CI-shellcheck follow-up.

**Recommendations**
- Land after the two doc updates (Constraints + parity emphasis); this is a model minimal fix.

**Questions for author**
- None.

**Verdict:** APPROVED WITH CHANGES

## Review Summary

| Reviewer | Verdict | Blocking / Must-Fix Items | Key Recommendations |
|----------|---------|---------------------------|---------------------|
| Frontend (Pixel) | APPROVED | 0 | Keep user-visible strings byte-identical; note additive output in release notes |
| Backend (Byte) | APPROVED WITH CHANGES | 0 blocking, 2 should-fix | grep `-Fxq` portability note into LLD; identical block in both scripts; test verify both directions |
| SRE (Circuit) | APPROVED WITH CHANGES | 0 blocking, 1 should-fix | Record `user_mgmt.sh` follow-ups with file:line in implementation.md |
| Security (Cipher) | APPROVED | 0 | Exact-line match is a small auth-verification improvement; keep layered checks |
| SMTS (Sage) | APPROVED WITH CHANGES | 1 must-satisfy (doc consistency) | Alternatives/Matrix must reflect requirement-driven exact-match; portability note into Constraints |

### Findings triage and dispositions (Step 7.5)

Reviewers raised should-fix items but no critical/NEEDS-REVISION blocker. Per the feedback loop, the LLD is revised before implementation:

1. **Byte-1 / Sage-2 (grep portability note):** RESOLVED - LLD "Constraints and Limitations Discovered" now states that combined short flags (`-Fxq`) must work on both GNU grep and macOS BSD grep, and that they do; implementers should not switch to a mixed long/short form.
2. **Byte-2 (parity of the two fix blocks):** RESOLVED - LLD Step 2 explicitly requires the identical comment + `local` + split assignment + `grep -Fxq` block in `setup-m2m-service-account.sh`, and `implementation.md` will show both diffs for comparison.
3. **Circuit-1 / Sage-3 (user_mgmt.sh follow-up tracking):** RESOLVED - `cli/user_mgmt.sh:109` and `terraform/aws-ecs/scripts/user_mgmt.sh:126` are named with file:line in the issue, the LLD (sweep table, Non-Goals), and will be repeated in `implementation.md`.
4. **Byte-3 / Cipher-1 (transport-failure message attribution):** ACCEPTED AS DOCUMENTED - LLD Error Handling records that an empty group list reports "NOT in group" and exits 1; legible and fail-closed for an operator script. Explicitly not a silent pass.
5. **Sage-1 (Alternatives/Matrix consistency):** RESOLVED - the LLD Alternatives section records substring `grep -q` as rejected because the task text declares the old check latently wrong; the Comparison Matrix row "Membership check actually correct" reflects the chosen design.
6. **Circuit-2 (CI shellcheck):** DEFERRED - Non-Goals; Rollout Phase 3.

**No blocking findings; the LLD revisions above are applied; proceeding to implementation.**

### Next Steps
- Implement per the revised LLD (Steps 1-3), capture `patch.diff`, write `implementation.md` with the follow-up list.
