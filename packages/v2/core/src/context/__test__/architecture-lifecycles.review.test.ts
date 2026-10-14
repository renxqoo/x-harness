import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createContext, defineChain, defineService } from "../../index";
import type { Result, RootContext, Scheduler, TaskHandle } from "../../index";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.reason));
  return result.value;
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

function clock() {
  let time = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const scheduler: Scheduler = {
    now: () => time,
    delay(run, delayMs) {
      const timer = { at: time + delayMs, run };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
  };
  return { scheduler, advance(ms: number) {
    time += ms;
    for (const timer of timers) if (timer.at <= time) { timers.delete(timer); timer.run(); }
  } };
}

it("cleanup outward timeout must not publish closed while its actual service still runs", async () => {
  const time = clock();
  const host = value(createContext({ scheduler: time.scheduler, limits: { callTimeoutMs: 10, closeTimeoutMs: 100 } }));
  const token = value(defineService<{ run(input: void): Promise<Result<void>> }>({ name: "review/cleanup-drain", methods: { run: {} } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  value(host.provide(token, { async run() { await gate; return { ok: true, value: undefined }; } }));
  value(host.effect(async (cleanup) => {
    await value(cleanup.context.use(token)).run(undefined);
    return { ok: true, value: undefined };
  }));
  const closing = host.dispose();
  try {
    await flush();
    time.advance(10);
    await flush();
    const snapshot = host.inspect();
    expect({ state: snapshot.state, activeCalls: snapshot.activeCalls, effects: snapshot.effects }).toEqual({ state: "closing", activeCalls: 1, effects: 2 });
  } finally {
    release();
    await flush();
    await closing;
  }
});

it("activation ctx.spawn background work must not block the plugin batch publication", async () => {
  const time = clock();
  const host = value(createContext({ scheduler: time.scheduler, limits: { activationTimeoutMs: 10 } }));
  let published = false;
  const loading = host.load([{ name: "review-background", apply(ctx) {
    const task = ctx.spawn({ label: "background", async run(call) {
      await new Promise<void>((resolve) => { call.signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { ok: true, value: undefined };
    } });
    if (!task.ok) return task;
    return { ok: true, value: undefined };
  } }]).then((result) => { published = result.ok; return result; });
  try {
    await flush();
    expect(published).toBe(true);
    expect(host.inspect().activeTasks).toBe(1);
  } finally {
    const closing = host.dispose();
    time.advance(100);
    await flush();
    await loading;
    await closing;
  }
});

it("root wait must use the default call budget even when its target has a longer deadline", async () => {
  const time = clock();
  const host: RootContext = value(createContext({ scheduler: time.scheduler, limits: { callTimeoutMs: 10 } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const task = value(host.spawn({ label: "long-target", timeoutMs: 100, async run() { await gate; return { ok: true, value: 1 }; } }));
  let result: Result<number> | undefined;
  const waiting = host.wait(task).then((settled) => { result = settled; });
  try {
    await flush();
    time.advance(10);
    await flush();
    expect(result).toMatchObject({ ok: false, reason: { code: "timeout" } });
    expect(task.state).toBe("running");
  } finally {
    release();
    await waiting;
    await host.dispose();
  }
});

it("a structured child waiting on its parent reports wait-cycle instead of deadlocking", async () => {
  const host = value(createContext());
  let parent!: TaskHandle<undefined>;
  parent = value(host.spawn({ label: "parent", run(call) {
    value(call.spawn({ label: "child", run: (child) => child.wait(parent) }));
    return { ok: true, value: undefined };
  } }));
  try {
    expect(await host.wait(parent)).toMatchObject({ ok: false, reason: { code: "wait-cycle" } });
    await flush();
    expect(host.inspect().activeTasks).toBe(0);
  } finally {
    await host.dispose();
  }
});

it("outward child timeout remains a parent failure after the child's actual late success", async () => {
  const time = clock();
  const host = value(createContext({ scheduler: time.scheduler }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let child!: TaskHandle<undefined>;
  const parent = value(host.spawn({ label: "parent", run(call) {
    child = value(call.spawn({ label: "child", timeoutMs: 10, async run() { await gate; return { ok: true, value: undefined }; } }));
    return { ok: true, value: undefined };
  } }));
  try {
    await flush();
    time.advance(10);
    await flush();
    expect(child.state).toBe("running");
    release();
    expect(await host.wait(parent)).toMatchObject({ ok: false, reason: { code: "timeout" } });
    await flush();
    expect(child.state).toBe("settled");
    expect(host.inspect().activeTasks).toBe(0);
  } finally {
    release();
    await host.dispose();
  }
});

it("unobserved completed continuation failure becomes a managed dispatch failure", async () => {
  const host = value(createContext());
  const validate = (input: unknown): Result<string> => typeof input === "string"
    ? { ok: true, value: input }
    : { ok: false, reason: { source: "core", code: "invalid-input", message: "invalid" } };
  const token = value(defineChain({ name: "review/unobserved", input: validate, output: validate }));
  value(host.provide(token, () => ({ ok: false, reason: { source: "core", code: "callback-failed", message: "failed" } })));
  value(host.on(token, async (input, next) => { void next(input); await flush(); return { ok: true, value: input }; }));
  try {
    expect(await host.dispatch(token, "input")).toMatchObject({ ok: false, reason: { code: "unobserved-next" } });
    await flush();
    expect(host.inspect().activeCalls).toBe(0);
  } finally {
    await host.dispose();
  }
});

async function collect(caseName: string) {
  const child = Bun.spawn(["bun", fileURLToPath(new URL("./architecture-lifecycles.review.gc-case.ts", import.meta.url)), caseName], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe("");
    expect(status).toBe(0);
    return JSON.parse(output) as { controlCollected: boolean; subjectCollected: boolean };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

it.each(["bound", "cleanup", "wait"])("revoked %s capability must release consumer references with a successful GC control", async (caseName) => {
  const result = await collect(caseName);
  expect(result.controlCollected).toBe(true);
  expect(result.subjectCollected).toBe(true);
});

it("online provider churn must not retain every retired definition beyond maxDefinitions", async () => {
  const result = await collect("tombstone");
  expect(result.controlCollected).toBe(true);
  expect(result.subjectCollected).toBe(true);
});
