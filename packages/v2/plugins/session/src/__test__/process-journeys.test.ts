import { expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, value } from "./helpers";
import type { SessionResult } from "../index";
import type { FixtureOptions } from "./helpers";

const directory = dirname(fileURLToPath(import.meta.url));
const setup = fixtures(); const source = resolve(directory, "../index.ts"); const built = resolve(directory, "../../dist/index.js");
for (const kind of ["sqlite", "postgres"] as const) {
  it(`${kind} two independent processes cannot both commit the same revision`, async () => {
    const fixture = await setup(kind); const a = child({ options: fixture.options, entry: source, mode: "write", commitId: "a" }); const b = child({ options: fixture.options, entry: source, mode: "write", commitId: "b" });
    try {
      await Promise.all([a.wait("ready"), b.wait("ready")]); a.process.send("go"); b.process.send("go");
      const results = await Promise.all([a.wait("result"), b.wait("result")]); expect(results.filter((item) => (item.result as SessionResult<unknown>).ok)).toHaveLength(1); expect(results.find((item) => !(item.result as SessionResult<unknown>).ok)?.result).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
      expect(await Promise.all([a.process.exited, b.process.exited])).toEqual([0, 0]); expect(value(await fixture.service.history({ id: "one" })).records).toHaveLength(1);
    } finally { await a.close(); await b.close(); }
  }, 15000);
  it(`${kind} committed data survives SIGKILL and an interrupted transaction leaves no partial head`, async () => {
    const fixture = await setup(kind); const processA = child({ options: fixture.options, entry: source, mode: "crash" });
    try { await processA.wait("ready"); processA.process.send("go"); expect((await processA.wait("result")).result).toMatchObject({ ok: true }); }
    finally { await processA.close(); }
    expect(value(await fixture.service.getCommit({ id: "one", commitId: "once" })).revision).toBe(1); expect(value(await fixture.service.conversation({ id: "one" })).nodes.map((node) => node.seq)).toEqual([1]);
    const empty = await setup(kind); const processB = child({ options: empty.options, entry: source, mode: "uncommitted" });
    try { await processB.wait("ready"); processB.process.send("go"); await processB.wait("uncommitted"); }
    finally { await processB.close(); }
    expect(value(await empty.service.get({ id: "one" })).revision).toBe(0); expect(value(await empty.service.history({ id: "one" })).records).toEqual([]);
  }, 15000);
  for (const entry of [source, built]) it(`${kind} ${entry === source ? "source" : "build"} entry closes cleanly and reopens persisted records`, async () => {
    const fixture = await setup(kind); const running = child({ options: fixture.options, entry, mode: "write" });
    try { await running.wait("ready"); running.process.send("go"); expect((await running.wait("result")).result).toMatchObject({ ok: true }); expect(await running.process.exited).toBe(0); expect(value(await fixture.service.history({ id: "one" })).records).toHaveLength(1); }
    finally { await running.close(); }
  }, 15000);
}
function child(input: { options: FixtureOptions; entry: string; mode: string; commitId?: string }) {
  const messages: Record<string, unknown>[] = []; const subscribers = new Set<() => void>(); let exited = false;
  const process = Bun.spawn([Bun.which("bun")!, resolve(directory, "session-process.ts"), input.entry, JSON.stringify(input.options), input.mode, input.commitId ?? "once"], { stdout: "pipe", stderr: "pipe", ipc(message) { messages.push(message as Record<string, unknown>); for (const notify of subscribers) notify(); } });
  const errors = new Response(process.stderr).text(); const output = new Response(process.stdout).text();
  void process.exited.then(() => { exited = true; for (const notify of subscribers) notify(); });
  return {
    process,
    async wait(phase: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { subscribers.delete(check); reject(new Error(`Child timed out at ${phase}`)); }, 10000);
        const check = () => {
          const message = messages.find((item) => item.phase === phase);
          if (message) { clearTimeout(timer); subscribers.delete(check); resolve(message); }
          else if (exited) { clearTimeout(timer); subscribers.delete(check); void Promise.all([errors, output]).then(([err, out]) => reject(new Error(`Child exited before ${phase}: ${err}${out}`))); }
        };
        subscribers.add(check); check();
      });
    },
    async close() { if (!exited) process.kill("SIGKILL"); await process.exited; await Promise.all([errors, output]); },
  };
}
