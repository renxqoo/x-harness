import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const [beforeRoot, afterRoot] = process.argv.slice(2); assert(beforeRoot && afterRoot && isAbsolute(beforeRoot) && isAbsolute(afterRoot));
const entries = [beforeRoot, afterRoot].map((root) => resolve(root, "core/src/contracts/normalize-result.ts"));
const implementations: ((input: unknown) => unknown)[] = [];
for (const entry of entries) { const module: unknown = await import(entry); assert(module && typeof module === "object" && "normalizeResult" in module && typeof module.normalizeResult === "function"); implementations.push(module.normalizeResult as (input: unknown) => unknown); }
const [before, after] = implementations; assert(before && after); let checks = 0;
const same = (factory: (normalize: (input: unknown) => unknown) => unknown) => { const a = before(factory(before)); const b = after(factory(after)); assert.deepEqual(b, a); checks++; };
const business = { source: "domain", payload: { nested: true } }; const core = { source: "core", code: "cancelled", message: "cancelled", details: { deep: [1, "a", null] } };
const values = [undefined, null, false, 0, "value", business, core];
const keysets: PropertyKey[][] = [["ok", "value"], ["value", "ok"], ["ok", "error"], ["error", "ok"], ["ok"], ["value", "error"], ["ok", "value", "extra"], ["ok", Symbol("payload")]];
for (const prototype of [Object.prototype, null, {}, Array.prototype]) for (const keys of keysets) for (const ok of [true, false, 1, undefined]) for (const value of values) for (const enumerable of [true, false]) {
  same(() => { const target: object = Object.create(prototype); for (const key of keys) Object.defineProperty(target, key, { value: key === "ok" ? ok : value, enumerable, configurable: true, writable: true }); return target; });
}
for (const reverse of [false, true]) for (const branch of [true, false]) for (const changeAt of [1, 2]) for (const action of ["flip-ok", "change-payload", "delete-first", "delete-second", "accessor-second", "null-proto", "bad-proto", "throw", "revoke", "reenter"]) {
  same((normalize) => {
    const payload = branch ? "value" : "error"; const target: Record<string, unknown> = reverse ? { [payload]: business, ok: branch } : { ok: branch, [payload]: business }; let reads = 0; let revoke = () => {};
    const pair = Proxy.revocable(target, { get() { throw new Error("unexpected get"); }, getOwnPropertyDescriptor(object, key) {
      reads++;
      if (reads === changeAt) {
        if (action === "flip-ok") object.ok = !branch;
        if (action === "change-payload") object[payload] = "changed";
        if (action === "delete-first") delete object[reverse ? payload : "ok"];
        if (action === "delete-second") delete object[reverse ? "ok" : payload];
        if (action === "accessor-second") Object.defineProperty(object, reverse ? "ok" : payload, { get() { throw new Error("unexpected accessor"); }, configurable: true });
        if (action === "null-proto") Object.setPrototypeOf(object, null);
        if (action === "bad-proto") Object.setPrototypeOf(object, Array.prototype);
        if (action === "throw") throw new Error("metadata");
        if (action === "revoke") revoke();
        if (action === "reenter") normalize({ ok: true, value: "inner" });
      }
      return Reflect.getOwnPropertyDescriptor(object, key);
    } });
    revoke = pair.revoke; return pair.proxy;
  });
}
for (const error of [core, business, new Error("domain"), null, undefined, () => false]) same(() => ({ ok: false, error }));
for (const prototype of [Object.prototype, null]) same(() => ({ error: Object.assign(Object.create(prototype) as object, core), ok: false }));
assert.equal(checks, 1880);
const sourceHashes = await Promise.all(entries.map(async (entry) => ({ entry, hash: createHash("sha256").update(await readFile(entry)).digest("hex") })));
process.stdout.write(JSON.stringify({ checks, sourceHashes, scope: "Envelope structures, descriptor snapshots, metadata mutations and valid fault/business payloads; not exhaustive over arbitrary Proxy programs" }, null, 2) + "\n");
