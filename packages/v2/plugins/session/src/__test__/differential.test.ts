import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, definePlugin } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionService, SessionEntry, SessionSummary } from "../index";
import { sessionStorage } from "../storage";
import { memoryStorage } from "./memory-storage";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { createJsonlSessionPlugin } from "../../../session-jsonl/src/index";
import { value } from "./helpers";
import type { Host } from "../../../../core/src/index";

type Backend = "memory" | "sqlite" | "jsonl";

async function openService(kind: Backend, dir: string) {
  const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
  let storage: ReturnType<typeof definePlugin>;
  if (kind === "memory") storage = definePlugin({ name: "diff-memory", provides: { storage: sessionStorage }, setup(ctx) { return ctx.service({ storage: memoryStorage() }); } });
  else if (kind === "sqlite") storage = value(createSqliteSessionPlugin({ path: join(dir, "diff.sqlite") }));
  else storage = value(createJsonlSessionPlugin({ path: join(dir, "diff-jsonl") }));
  value(await host.install([storage, value(createSessionPlugin({ namespace: "diff" }))]));
  return { service: value(host.use(session)), host };
}

function normalize(result: unknown): unknown {
  const text = JSON.stringify(result, (key, val) => (key === "createdAt" || key === "time" || key === "bytes" ? "<stripped>" : val));
  return JSON.parse(text);
}

function makeRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

interface Operation {
  kind: "create" | "append" | "fork" | "history" | "conversation" | "list" | "getCommit";
  id: string; sourceId?: string; throughRevision?: number; expectedRevision?: number; commitId?: string; entries?: SessionEntry[]; replace?: { startSeq: number; endSeq: number }; after?: number; limit?: number;
}

function planSequence(seed: number, steps: number): Operation[] {
  const random = makeRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const ids = ["one", "two", "child"];
  const ops: Operation[] = [];
  for (let step = 0; step < steps; step++) {
    const roll = random();
    const id = pick(ids);
    if (roll < 0.15) ops.push({ kind: "create", id, commitId: `c${step}` });
    else if (roll < 0.55 || !ops.some((op) => op.kind === "append")) {
      const replace = random() < 0.25 ? { startSeq: 1 + Math.floor(random() * 3), endSeq: 1 + Math.floor(random() * 3) } : undefined;
      const entries: SessionEntry[] = [{ kind: "message", message: { role: "user", content: [{ type: "text", text: `m${step}` }] }, ...(replace && replace.startSeq <= replace.endSeq ? { replace } : {}) }];
      ops.push({ kind: "append", id, expectedRevision: Math.floor(random() * 3), commitId: `c${step}`, entries });
    } else if (roll < 0.65) ops.push({ kind: "fork", id: "child", sourceId: id === "child" ? "one" : id, throughRevision: Math.floor(random() * 3), commitId: `c${step}` });
    else if (roll < 0.78) ops.push({ kind: "history", id, after: Math.floor(random() * 4), limit: 1 + Math.floor(random() * 3) });
    else if (roll < 0.9) ops.push({ kind: "conversation", id, limit: 1 + Math.floor(random() * 3) });
    else if (roll < 0.96) ops.push({ kind: "list", id, limit: 1 + Math.floor(random() * 3) });
    else ops.push({ kind: "getCommit", id, commitId: `c${Math.floor(random() * steps)}` });
  }
  return ops;
}

async function apply(service: SessionService, op: Operation): Promise<unknown> {
  switch (op.kind) {
    case "create": return service.create({ id: op.id, metadata: { step: op.commitId ?? "none" } });
    case "append": return service.append({ id: op.id, expectedRevision: op.expectedRevision!, commitId: op.commitId!, entries: op.entries! });
    case "fork": return service.fork({ id: op.id, sourceId: op.sourceId!, throughRevision: op.throughRevision! });
    case "history": return service.history({ id: op.id, after: op.after, limit: op.limit });
    case "conversation": return service.conversation({ id: op.id, limit: op.limit });
    case "list": return service.list({ limit: op.limit });
    case "getCommit": return service.getCommit({ id: op.id, commitId: op.commitId! });
  }
}

for (const seed of [1, 42, 777, 2026]) it(`differential: backends agree on random sequence seed ${seed}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-diff-"));
  const backends: { service: SessionService; host: Host }[] = [];
  try {
    for (const kind of ["memory", "sqlite", "jsonl"] as const) backends.push(await openService(kind, directory));
    const plan = planSequence(seed, 60);
    let diverged = -1;
    for (const [index, op] of plan.entries()) {
      const responses = await Promise.all(backends.map((b) => apply(b.service, op).catch((error) => ({ ok: false, error: { code: String(error) } }))));
      const normalized = responses.map(normalize);
      if (normalized.some((r) => JSON.stringify(r) !== JSON.stringify(normalized[0]))) { diverged = index; break; }
    }
    expect(diverged).toBe(-1);
    for (const b of backends) value(await b.host.close());
  } finally { for (const b of backends) { try { await b.host.close(); } catch {} } await rm(directory, { recursive: true, force: true }); }
}, 60000);

it("differential: full conversation walks agree across backends after mixed replace sequences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-diff2-"));
  const backends: { service: SessionService; host: Host }[] = [];
  try {
    for (const kind of ["memory", "sqlite", "jsonl"] as const) backends.push(await openService(kind, directory));
    for (const b of backends) value(await b.service.create({ id: "one" }));
    const random = makeRandom(99);
    let revision = 0;
    const live: number[] = [];
    for (let step = 0; step < 40; step++) {
      const replace = live.length >= 2 && random() < 0.4 ? (() => { const start = Math.floor(random() * live.length); const end = start + Math.floor(random() * (live.length - start)); return { startSeq: live[start]!, endSeq: live[end]! }; })() : undefined;
      const entry: SessionEntry = { kind: "message", message: { role: "user", content: [{ type: "text", text: `s${step}` }] }, ...(replace ? { replace } : {}) };
      const results = await Promise.all(backends.map((b) => b.service.append({ id: "one", expectedRevision: revision, commitId: `c${step}`, entries: [entry] })));
      const ok = results.filter((r) => r.ok);
      if (ok.length !== results.length) throw new Error(`append disagreement at step ${step}: ${JSON.stringify(results.map((r) => (r.ok ? "ok" : r.error.code)))}`);
      revision += 1;
      if (replace) { const start = live.indexOf(replace.startSeq); const end = live.indexOf(replace.endSeq); live.splice(start, end - start + 1, revision); }
      else live.push(revision);
    }
    const walks = await Promise.all(backends.map(async (b) => { const nodes: unknown[] = []; let cursor: string | undefined; do { const page = value(await b.service.conversation({ id: "one", limit: 5, ...(cursor ? { after: cursor } : {}) })); nodes.push(...page.nodes.map((n) => ({ position: n.position, seq: n.seq, text: n.message.content[0]?.type === "text" ? n.message.content[0].text : null }))); cursor = page.next; } while (cursor); return nodes; }));
    expect(JSON.stringify(walks[1])).toBe(JSON.stringify(walks[0]));
    expect(JSON.stringify(walks[2])).toBe(JSON.stringify(walks[0]));
    const summaries = await Promise.all(backends.map((b) => b.service.list({ limit: 10 })));
    const shapes = summaries.map((s) => value(s).sessions.map((x: SessionSummary) => ({ id: x.id, revision: "<stripped>" })));
    expect(JSON.stringify(shapes[1])).toBe(JSON.stringify(shapes[0]));
    for (const b of backends) value(await b.host.close());
  } finally { for (const b of backends) { try { await b.host.close(); } catch {} } await rm(directory, { recursive: true, force: true }); }
}, 60000);
