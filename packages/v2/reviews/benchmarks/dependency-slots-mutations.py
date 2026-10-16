from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile

workspace = Path(sys.argv[1]).resolve()
package = workspace / "packages/v2"
source_file = "core/src/context/create-dependencies.ts"
behavior = "core/src/context/__test__/dependency-slots.test.ts"
collection = "core/src/context/__test__/dependency-slots-gc.test.ts"
mutations = [
    ("retain-source", 'return () => { cell.current = undefined; };', 'return () => { void cell.current; };', collection, "Retired dependency tokens retained"),
    ("poison-on-lease-failure", 'if (!resolved.ok) return Promise.resolve(resolved);', 'if (!resolved.ok) { cell.current = undefined; return Promise.resolve(resolved); }', behavior, "does not poison a later acquisition"),
    ("forget-acquired-status", 'acquired ? "service-unavailable" : "cancelled"', '"cancelled"', behavior, "saved setup dependencies distinguish acquired and untouched slots"),
]
records = []
with tempfile.TemporaryDirectory(prefix="kernel-slot-mutations-") as temporary:
    target = Path(temporary) / "workspace/packages/v2"
    shutil.copytree(package, target, ignore=shutil.ignore_patterns("node_modules", "coverage", "dist", ".vite", ".DS_Store"))
    (target.parent.parent / "node_modules").symlink_to((workspace / "node_modules").resolve(), target_is_directory=True)
    (target / "node_modules").symlink_to((package / "node_modules").resolve(), target_is_directory=True)
    def run(files):
        command = ["bun", str(workspace / "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts", *files]
        return subprocess.run(command, cwd=target, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
    baseline = run([behavior, collection])
    assert baseline.returncode == 0, baseline.stdout
    for name, previous, replacement, test, symptom in mutations:
        path = target / source_file
        source = path.read_text()
        assert source.count(previous) == 1, name
        mutant = source.replace(previous, replacement)
        path.write_text(mutant)
        try:
            result = run([test])
            assert result.returncode > 0 and "AssertionError" in result.stdout and symptom in result.stdout, result.stdout
            assert not any(error in result.stdout for error in ["Failed Suites", "TransformError", "Cannot find module", "Test timed out"]), result.stdout
            records.append({"mutation": name, "normalHash": hashlib.sha256(source.encode()).hexdigest(), "mutantHash": hashlib.sha256(mutant.encode()).hexdigest(), "rejectedBy": symptom, "exitCode": result.returncode, "evidence": result.stdout})
        finally:
            path.write_text(source)
print(json.dumps({"workspace": str(workspace), "baselinePassed": True, "mutations": records}, indent=2))
