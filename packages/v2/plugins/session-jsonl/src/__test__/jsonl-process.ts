import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { sessionStorage, defaultSessionLimits, storagePolicyKeys } from "../../../session/src/storage";
import { createFileIO } from "../create-file-io";
import { openLock } from "../open-lock";
import { sessionPath } from "../store-path";
import { openFile } from "../open-file";
import { directStore } from "./direct-store";
const [entry, path, mode, commitId = "once"] = process.argv.slice(2) as [string, string, string, string?];
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
function send(phase: string, result?: unknown) { process.send!({ phase, result }); }
async function pause(phase: string): Promise<never> { send(phase); setInterval(() => undefined, 1000); return new Promise(() => undefined); }
const key = { namespace: "default", id: "one" }; const hash = "a".repeat(64);
if (mode === "lock") { const lock = openLock(); const file = await openFile(createFileIO(), join(path, "store.lock")); if (!lock.try(file.fd)) throw new Error("lock unavailable"); await pause("locked"); }
else if (["partial", "stage", "bootstrap", "format", "policy", "published"].includes(mode)) {
  const io = createFileIO(); const originalOpen = io.open; const originalRename = io.rename;
  io.open = async (...args) => { const file = await originalOpen(...args); const name = String(args[0]);
    if (mode === "bootstrap" && name.endsWith("store.lock")) await pause("bootstrap");
    if (mode !== "partial" || name !== sessionPath(path, key)) return file;
    return new Proxy(file, { get(target, key) { if (key === "write") return async (...input: [Buffer, number, number, number]) => { const [buffer, offset, length, position] = input; if (buffer.toString().includes('"kind":"commit"')) { await target.write(buffer, offset, Math.floor(length / 2), position); await target.sync(); await pause("partial"); } return target.write(buffer, offset, length, position); }; const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  };
  io.rename = async (...args) => { if (mode === "stage" && String(args[1]) === sessionPath(path, { ...key, id: "fork" })) await pause("staging"); if ((mode === "format" && String(args[1]).endsWith("/format.json")) || (mode === "policy" && String(args[1]).endsWith("/policy.json"))) await pause(mode); const result = await originalRename(...args); if (mode === "published" && String(args[1]) === sessionPath(path, { ...key, id: "fork" })) await pause("published"); return result; };
  const opened = await directStore(path, { io });
  if (mode === "policy") value(await opened.storage.initialize({ namespace: key.namespace, policy: Object.fromEntries(storagePolicyKeys.map((key) => [key, defaultSessionLimits[key]])) as never }));
  if (mode === "partial") value(await opened.storage.commit({ ...key, expectedRevision: 0, commitId, fingerprint: hash, records: [{ seq: 1, time: 0, json: "opaque", bytes: 6 }], nodes: [{ position: 1, seq: 1 }] }));
  if (["stage", "published"].includes(mode)) value(await opened.storage.fork({ ...key, id: "fork", sourceId: "one", throughRevision: 1, bytes: 6, origin: hash, metadata: "null", nodes: [{ position: 1, seq: 1 }] }));
  await opened.store.close();
} else {
  const module = await import(entry) as typeof import("../index"); const host = value(createHost()); value(await host.install([value(module.createJsonlSessionPlugin({ path }))])); const storage = value(host.use(sessionStorage));
  send("ready"); await new Promise<void>((resolve) => { process.once("message", () => resolve()); });
  const result = await storage.commit({ ...key, expectedRevision: 0, commitId, fingerprint: hash, records: [{ seq: 1, time: 0, json: "opaque", bytes: 6 }], nodes: [{ position: 1, seq: 1 }] }); send("result", result);
  if (mode === "crash") await pause("committed"); value(await host.close()); process.disconnect();
}
