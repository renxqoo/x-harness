import json, subprocess, sys, pathlib

root = pathlib.Path("/Users/wrr/work/x-harness/packages/v2")
mutations = [
  ("read-history.ts", "record.seq !== after + index + 1", "record.seq !== after + index + 2", "read-history: page continuity", ["plugins/session/src/__test__/adversarial-inputs.test.ts", "plugins/session/src/__test__/forged-backend.test.ts", "plugins/session/src/__test__/concurrency.test.ts", "plugins/session/src/__test__/performance-invariants.test.ts"]),
  ("append-session.ts", "head.value.bytes + bytes > limits.maxSessionBytes", "head.value.bytes + bytes >= limits.maxSessionBytes", "append: session byte budget is inclusive", ["plugins/session/src/__test__/adversarial-inputs.test.ts"]),
  ("append-session.ts", "if (state.value.commit) {\n    if (state.value.commit.fingerprint !== requestFingerprint) return fail(\"commit-conflict\");\n    const receipt = readStoredCommit(state.value.commit); return receipt;\n  }", "if (state.value.commit) { return { ok: true, value: state.value.commit.receipt as never }; }", "append: receipt passthrough restored", ["plugins/session/src/__test__/forged-backend.test.ts"]),
  ("get-commit.ts", "return result.ok ? readStoredCommit(result.value) : result;", "return result.ok ? { ok: true, value: result.value.receipt as never } : result;", "getCommit: receipt passthrough restored", ["plugins/session/src/__test__/forged-backend.test.ts"]),
  ("read-conversation.ts", "row.position <= previous", "false", "read-conversation: position order check dropped", ["plugins/session/src/__test__/forged-backend.test.ts"]),
  ("read-conversation.ts", "result.value.next <= position || (nodes.at(-1)?.position ?? position) > result.value.next", "false", "read-conversation: next advance check dropped", ["plugins/session/src/__test__/forged-backend.test.ts"]),
  ("read-history.ts", "result.value.next <= after", "false", "read-history: next advance check dropped", ["plugins/session/src/__test__/forged-backend.test.ts"]),
  ("read-entry.ts", "value.content.length > 10000", "value.content.length > 10001", "read-entry: content block ceiling off-by-one", ["plugins/session/src/__test__/adversarial-inputs.test.ts"]),
]
config = """import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: [%s] } });
"""

results = []
for file, old, new, name, targets in mutations:
    path = root / "plugins/session/src/operations" / file
    if not path.exists():
        path = root / "plugins/session/src/domain" / file
    if not path.exists():
        path = root / "plugins/session/src/contracts" / file
    original = path.read_text()
    if old not in original:
        results.append({"mutation": name, "detected": False, "error": "anchor not found"})
        continue
    path.write_text(original.replace(old, new, 1))
    cfg = root / "vitest.mutation.config.ts"
    cfg.write_text(config % ", ".join(f'"{t}"' for t in targets))
    try:
        report = root / ".vitest/json/output.json"
        if report.exists():
            report.unlink()
        run = subprocess.run(["bunx", "--bun", "vitest", "run", "--config", "./vitest.mutation.config.ts", "--coverage.enabled=false", "--reporter=json"], cwd=root, capture_output=True, text=True, timeout=180, env={"PATH": "/Users/wrr/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"})
        detected = False
        detail = ""
        if report.exists():
            try:
                payload = json.loads(report.read_text())
                failed = payload.get("numFailedTests", 0)
                detected = failed > 0
                detail = f"failed={failed} passed={payload.get('numPassedTests', 0)}"
            except Exception as error:
                detail = f"report parse failed: {error}"
        if not detected and not detail:
            detail = (run.stdout[-300:] + run.stderr[-300:]).replace("\n", " ")
        results.append({"mutation": name, "detected": detected, "detail": detail})
    finally:
        path.write_text(original)
        cfg.unlink(missing_ok=True)

out = root / "plugins/session/reviews/adversarial-mutation-results.json"
out.write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps(results, ensure_ascii=False, indent=2))
