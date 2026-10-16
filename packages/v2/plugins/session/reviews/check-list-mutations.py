import json
import shutil
import subprocess
import tempfile
from pathlib import Path

workspace = Path(__file__).resolve().parents[3]
repo = workspace.parents[1]
list_test = "plugins/session/src/__test__/list.test.ts"
forged_test = "plugins/session/src/__test__/list-forged.test.ts"
catalog_test = "plugins/session-jsonl/src/__test__/catalog.test.ts"
mutations = [
    ("SQL namespace isolation", "plugins/session-storage-sql/src/list-sessions.ts", "WHERE namespace=$1 AND", "WHERE (namespace=$1 OR namespace<>$1) AND", [list_test]),
    ("SQL cursor advancement", "plugins/session-storage-sql/src/list-sessions.ts", "id COLLATE ${order}>$2", "(id COLLATE ${order}>$2 OR id COLLATE ${order}<=$2)", [list_test]),
    ("public namespace cursor", "plugins/session/src/operations/list-sessions.ts", "ns !== namespace", "false", [list_test]),
    ("public summary order", "plugins/session/src/operations/list-sessions.ts", "parsed.value.id <= previous", "false", [forged_test, list_test]),
    ("storage page budget", "plugins/session/src/storage/create-list-page.ts", "if (bytes + size > input.maxPageBytes)", "if (false)", [list_test]),
    ("public next identity", "plugins/session/src/operations/list-sessions.ts", "read.value.next !== previous", "false", [forged_test, list_test]),
    ("filesystem identity case", "plugins/session-jsonl/src/encode-id.ts", "Buffer.from(id)", "Buffer.from(id.toLowerCase())", [list_test]),
    ("path format recognition", "plugins/session-jsonl/src/read-config.ts", ', paths: "base32"', "", [catalog_test]),
]
results = []
with tempfile.TemporaryDirectory(prefix="session-list-mutations-") as temporary:
    root = Path(temporary)
    target = root / "packages/v2"
    shutil.copytree(workspace, target, ignore=shutil.ignore_patterns("dist", "coverage", "node_modules", ".vitest"))
    (root / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    (target / "node_modules").symlink_to(workspace / "node_modules", target_is_directory=True)
    for name, file, before, after, tests in mutations:
        path = target / file
        original = path.read_text()
        if original.count(before) != 1:
            raise RuntimeError(f"Mutation anchor mismatch: {name}")
        config = 'import { defineConfig } from "vitest/config"; export default defineConfig({test:{maxWorkers:4,globalSetup:["./plugins/session/src/__test__/start-postgres.ts"],include:' + json.dumps(tests) + ',testTimeout:15000}});'
        (target / "vitest.list-mutation.config.ts").write_text(config)
        path.write_text(original.replace(before, after))
        try:
            report_path = target / ".vitest/json/output.json"
            report_path.unlink(missing_ok=True)
            command = ["bun", str(repo / "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.list-mutation.config.ts", "--reporter=json"]
            run = subprocess.run(command, cwd=target, capture_output=True, text=True, timeout=60)
            if not report_path.exists():
                raise RuntimeError(f"No behavior report: {name}: {run.stdout}{run.stderr}")
            report = json.loads(report_path.read_text())
            detected = run.returncode != 0 and report["numFailedTests"] > 0 and report["numPassedTests"] > 0 and report.get("numRuntimeErrorTestSuites", 0) == 0
            result = {"mutation": name, "detected": detected, "failed": report["numFailedTests"], "passed": report["numPassedTests"]}
            results.append(result)
            print(json.dumps(result), flush=True)
            if not detected:
                raise RuntimeError(f"Mutation escaped behavioral checks: {name}")
        finally:
            path.write_text(original)
Path(__file__).with_name("list-mutation-results.json").write_text(json.dumps(results, indent=2) + "\n")
