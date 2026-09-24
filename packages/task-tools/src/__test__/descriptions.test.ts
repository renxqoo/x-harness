// 描述对账（docs/TASKS.md §1.1/§5 + docs/TASK-PUSH-DESIGN.md §2.1）：锚词与参数面双向
// 对账——描述承诺的参数 schema 必有，schema 有的参数描述必提（防描述承诺缺口复发——
// 件14 立项目的）。task_stop 单工具。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { TASK_STOP_DESCRIPTION } from "../descriptions.ts";
import { createTaskTools } from "../tools.ts";
import { createTaskHub } from "../hub.ts";

describe("task tool descriptions vs schemas", () => {
  it("carries the stop anchors: task_id / Idempotent / agent_message revival note", () => {
    for (const anchor of ["task_id", "Idempotent", "agent_message"]) {
      expect(TASK_STOP_DESCRIPTION).toContain(anchor);
    }
  });

  it("names the id sources truthfully (agent_spawn result / bash run_in_background) and never the absent /tasks command", () => {
    expect(TASK_STOP_DESCRIPTION).toContain("from agent_spawn");
    expect(TASK_STOP_DESCRIPTION).toContain("run_in_background");
    expect(TASK_STOP_DESCRIPTION).not.toContain("/tasks");
  });

  it("parameter parity: the single tool's schema params are exactly task_id", () => {
    const [stopTool] = createTaskTools(createTaskHub());
    if (stopTool === undefined) throw new Error("tool missing");
    const stopProps = Object.keys((stopTool.inputSchema as ReturnType<typeof Type.Object>).properties);
    expect(stopProps).toEqual(["task_id"]);
  });
});
