import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

workspace = Path(__file__).resolve().parents[3]
repo = workspace.parents[1]
mutations = [
    ("CAS", "append-journal.ts", 'if (state.head.revision !== input.expectedRevision)', 'if (false)', "contract.test.ts"),
    ("fingerprint", "append-journal.ts", 'previous.fingerprint === input.fingerprint', 'true', "contract.test.ts"),
    ("checksum", "replay-journal.ts", 'if (chain.update(JSON.stringify(footer)).digest("hex") !== parsed.checksum)', 'chain.update(JSON.stringify(footer)).digest("hex"); if (false)', "recovery.test.ts"),
    ("durable sync", "append-journal.ts", 'await file.handle.sync();', 'await Promise.resolve();', "io-failures.test.ts"),
    ("fork prefix", "create-session.ts", 'index < head.revision', 'index < 0', "contract.test.ts"),
    ("tail recovery", "replay-journal.ts", 'if (state.end < size) await file.truncate(state.end);', 'if (state.end < size) await Promise.resolve();', "recovery.test.ts"),
    ("snapshot baseline", "replay-journal.ts", 'if (!state || mandatory)', 'if (!state)', "compaction.test.ts"),
    ("publication cancellation", "publish-file.ts", 'await handle.sync(); op.check();', 'await handle.sync();', "io-failures.test.ts"),
]
results = []
with tempfile.TemporaryDirectory(prefix="jsonl-protocol-mutations-") as temporary:
    root = Path(temporary)
    target = root / "packages/v2"
    shutil.copytree(workspace, target, ignore=shutil.ignore_patterns("dist", "coverage", "node_modules", ".vitest"))
    (root / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    (target / "node_modules").symlink_to(workspace / "node_modules", target_is_directory=True)
    (target / "vitest.mutation.config.ts").write_text('import { defineConfig } from "vitest/config"; export default defineConfig({test:{include:["plugins/session-jsonl/src/__test__/*.test.ts"],testTimeout:20000}});')
    for name, file, before, after, test in mutations:
        source = target / "plugins/session-jsonl/src" / file
        original = source.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f"Mutation anchor mismatch: {name}")
        source.write_text(original.replace(before, after))
        try:
            command = ["bun", str(repo / "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.mutation.config.ts", f"plugins/session-jsonl/src/__test__/{test}", "--reporter=json"]
            report_path = target / ".vitest/json/output.json"
            report_path.unlink(missing_ok=True)
            run = subprocess.run(command, cwd=target, capture_output=True, text=True, timeout=60, env=os.environ)
            if not report_path.exists():
                raise RuntimeError(f"No test report: {name}: {run.stdout}{run.stderr}")
            report = json.loads(report_path.read_text())
            detected = run.returncode != 0 and report["numFailedTests"] > 0 and report["numPassedTests"] > 0
            results.append({"mutation": name, "detected": detected, "failed": report["numFailedTests"], "passed": report["numPassedTests"]})
            if not detected:
                raise RuntimeError(f"Mutation escaped behavior checks: {name}")
        finally:
            source.write_text(original)
Path(__file__).with_name("mutation-results.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
