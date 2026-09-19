// 描述对账（docs/TASKS.md §1.1/§5/§10 偏离清单）：锚词与参数面双向对账——描述承诺的
// 参数 schema 必有，schema 有的参数描述必提（防描述承诺缺口复发——件14 立项目的）。

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { TASK_OUTPUT_DESCRIPTION, TASK_STOP_DESCRIPTION } from "../descriptions.ts";
import { createTaskTools } from "../tools.ts";
import { createTaskHub } from "../hub.ts";

describe("task tool descriptions vs schemas", () => {
  it("carries the doc anchors: task_id / block=true default / block=false / timeout / offset / nextOffset", () => {
    for (const anchor of ["task_id", "block=true (default)", "block=false", "timeout", "offset", "nextOffset"]) {
      expect(TASK_OUTPUT_DESCRIPTION).toContain(anchor);
    }
  });

  it("carries the stop anchors: task_id / Idempotent / agent_message revival note", () => {
    for (const anchor of ["task_id", "Idempotent", "agent_message"]) {
      expect(TASK_STOP_DESCRIPTION).toContain(anchor);
    }
  });

  it("names the id sources truthfully (agent_spawn result / bash run_in_background) and never the absent /tasks command", () => {
    expect(TASK_OUTPUT_DESCRIPTION).toContain("from agent_spawn");
    expect(TASK_OUTPUT_DESCRIPTION).toContain("run_in_background");
    expect(TASK_OUTPUT_DESCRIPTION).not.toContain("/tasks");
    expect(TASK_STOP_DESCRIPTION).not.toContain("/tasks");
  });

  it("parameter parity: every schema param is described and every described param exists in the schema", () => {
    const [outputTool, stopTool] = createTaskTools(createTaskHub());
    if (outputTool === undefined || stopTool === undefined) throw new Error("tools missing");
    const outputProps = Object.keys((outputTool.inputSchema as ReturnType<typeof Type.Object>).properties);
    const stopProps = Object.keys((stopTool.inputSchema as ReturnType<typeof Type.Object>).properties);
    expect(outputProps).toEqual(["task_id", "offset", "block", "timeout"]);
    expect(stopProps).toEqual(["task_id"]);
    for (const param of ["task_id", "offset", "block", "timeout"]) {
      expect(TASK_OUTPUT_DESCRIPTION).toContain(param);
    }
  });
});
