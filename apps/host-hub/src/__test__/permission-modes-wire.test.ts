import { afterAll, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHost } from "./kit/host-client.ts";
import type { HostHandle } from "./kit/host-client.ts";

const WIRE_MODES = ["plan", "auto", "edit-confirm", "full", "sandboxed-auto"];

const hosts: HostHandle[] = [];

afterAll(() => {
  for (const host of hosts) host.end();
});

async function parkedWithMode(host: HostHandle, sid: string, mode: string): Promise<void> {
  const dir = join(host.sessionsRoot, sid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "header.json"), JSON.stringify({ id: sid, createdAt: 1, cwd: "/proj" }), "utf8");
  const events = [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
    { type: "session/meta", seq: 1, time: 2, data: { key: "permission-mode", value: mode } },
    { type: "turn/end", seq: 2, time: 3, data: { turn: 0, reason: { kind: "completed" } } },
  ];
  await writeFile(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  host.send({ type: "thread/register", id: `rg-${sid}`, sessionPath: join(dir, "events.jsonl") });
  await host.response(`rg-${sid}`);
}

describe("permission/get_mode modes 暴露面（UI 选择器渲染源）", () => {
  test("症状回归：UI 模式选择无 edit-confirm 可选（get_mode 不暴露词表 + 宿主持三档硬编码）——modes 暴露五档单源；parked edit-confirm 尾值不再被丢弃", async () => {
    const host = await startHost({ script: [] });
    hosts.push(host);
    host.send({ type: "permission/get_mode", id: "mv1" });
    const globalGet = await host.response("mv1");
    expect(globalGet.data).toEqual({ mode: "auto", source: "default", modes: WIRE_MODES });
    await parkedWithMode(host, "editconfirmsession", "edit-confirm");
    host.send({ type: "permission/get_mode", id: "mv2", threadId: "editconfirmsession" });
    const parked = await host.response("mv2");
    expect(parked.data).toEqual({ mode: "edit-confirm", source: "session", modes: WIRE_MODES });
  });
});
