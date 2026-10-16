from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile

workspace = Path(sys.argv[1]).resolve()
package = workspace / "packages/v2"
normalizer = "core/src/contracts/normalize-result.ts"
execution = "core/src/execution/create-execution.ts"
contracts = "core/src/contracts/__test__/normalize-result.test.ts"
faults = "core/src/contracts/__test__/fault-boundaries.test.ts"
graph = "core/src/execution/__test__/waiting-graph.test.ts"
public = "core/src/context/__test__/result-boundary.test.ts"
mutations = [
    ("accessor-read", normalizer, 'Object.getOwnPropertyDescriptor(input, keys[0]!)', '{ value: Reflect.get(input, keys[0]!) }', contracts, "accessor is rejected without executing it"),
    ("extra-field", normalizer, 'keys.length !== 2', 'keys.length < 2', contracts, "malformed result envelopes are rejected"),
    ("foreign-prototype", normalizer, 'if (prototype !== Object.prototype && prototype !== null) return createFault("invalid-result");', 'void prototype;', contracts, "malformed result envelopes are rejected"),
    ("truthy-flag", normalizer, 'ok === true && payload === "value"', 'ok && payload === "value"', contracts, "malformed result envelopes are rejected"),
    ("raw-core-fault", normalizer, 'return normalizeFailure(value);', 'return { ok: false, error: value };', faults, "cannot escape as a valid CoreFault"),
    ("wait-cycle-bypass", execution, 'if (node === source) return fault("wait-cycle");', 'void source;', graph, "self waiting is rejected"),
]
compiler = workspace / "node_modules/vitest/vitest.mjs"
records = []
with tempfile.TemporaryDirectory(prefix="kernel-result-mutations-") as temporary:
    target = Path(temporary) / "workspace/packages/v2"
    shutil.copytree(package, target, ignore=shutil.ignore_patterns("node_modules", "coverage", "dist", ".vite", ".DS_Store"))
    (target.parent.parent / "node_modules").symlink_to((workspace / "node_modules").resolve(), target_is_directory=True)
    (target / "node_modules").symlink_to((package / "node_modules").resolve(), target_is_directory=True)
    def run(files):
        command = ["bun", str(compiler), "run", "--config", "vitest.config.ts", *files]
        return subprocess.run(command, cwd=target, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
    baseline = run([contracts, faults, graph, public])
    assert baseline.returncode == 0, baseline.stdout
    for name, file, previous, replacement, test, symptom in mutations:
        path = target / file
        source = path.read_text()
        assert source.count(previous) == 1, name
        mutant = source.replace(previous, replacement)
        path.write_text(mutant)
        try:
            result = run([test])
            assert result.returncode > 0, name + " was not rejected"
            assert "AssertionError" in result.stdout and symptom in result.stdout, result.stdout
            assert not any(error in result.stdout for error in ["Failed Suites", "TransformError", "Cannot find module", "Test timed out"]), result.stdout
            records.append({"mutation": name, "file": file, "normalHash": hashlib.sha256(source.encode()).hexdigest(), "mutantHash": hashlib.sha256(mutant.encode()).hexdigest(), "rejectedBy": symptom, "exitCode": result.returncode, "evidence": result.stdout})
        finally:
            path.write_text(source)
print(json.dumps({"workspace": str(workspace), "baselinePassed": True, "mutations": records}, indent=2))
