import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { SessionStore } from "@x-harness/session";
import { createTodoStore } from "../store.ts";
import { createTodoTools } from "../tools.ts";

const noSessions = { get: () => undefined } as unknown as SessionStore;
import {
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "../descriptions.ts";

const SPEC_PATH = new URL("./fixtures/task-tools.spec.md", import.meta.url).pathname;

const RENAMES: Array<[RegExp, string]> = [
  [/TaskUpdate/g, "task_update"],
  [/TaskList/g, "task_list"],
  [/TaskGet/g, "task_get"],
];

const tools = createTodoTools(createTodoStore(), noSessions);
const descriptions: Record<string, string> = {
  task_create: TASK_CREATE_DESCRIPTION,
  task_get: TASK_GET_DESCRIPTION,
  task_list: TASK_LIST_DESCRIPTION,
  task_update: TASK_UPDATE_DESCRIPTION,
};

function blockRuns(spec: string): string[] {
  const runs: string[] = [];
  let cur: string[] = [];
  for (const line of spec.split("\n")) {
    if (line.startsWith(">")) cur.push(line.replace(/^> ?/, ""));
    else if (cur.length > 0) {
      runs.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length > 0) runs.push(cur.join("\n"));
  return runs;
}

function tableRows(spec: string, section: string): Array<[string, string, string, string]> {
  const start = spec.indexOf(section);
  expect(start, `spec 节在场：${section}`).toBeGreaterThan(-1);
  const body = spec.slice(start, spec.indexOf("\n## ", start));
  const tableStart = body.indexOf("| 参数 |");
  expect(tableStart, `参数表格在场：${section}`).toBeGreaterThan(-1);
  const rows = body.slice(tableStart).split("\n").filter((line) => line.startsWith("|"));
  return rows
    .slice(2)
    .map((row) => {
      const cells = row.replace(/\\\|/g, "<PIPE/>").split("|").map((cell) => cell.replace(/<PIPE\/>/g, "|").trim());
      return [cells[1] ?? "", cells[2] ?? "", cells[3] ?? "", cells[4] ?? ""] as [string, string, string, string];
    })
    .filter(([name]) => name !== "");
}

function propsOf(name: string): Record<string, { description?: string; anyOf?: Array<{ const?: string }> }> {
  const schema = tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, never> } | undefined;
  return (schema?.properties ?? {}) as never;
}

describe("正文逐字对账（spec blockquote + 已知替换集）", () => {
  it("四条 description 与 spec 原文块逐字符相等（偏离仅工具名实名化）", async () => {
    const spec = await readFile(SPEC_PATH, "utf8");
    const runs = blockRuns(spec);
    const block = (prefix: string): string => {
      const hit = runs.filter((run) => run.startsWith(prefix));
      expect(hit.length, `spec 原文块唯一：${prefix}`).toBe(1);
      return hit[0] as string;
    };
    const renamed = (text: string): string => RENAMES.reduce((acc, [from, to]) => acc.replace(from, to), text);
    expect(descriptions.task_create).toBe(renamed(block("Use this tool to create a structured task list")));
    expect(descriptions.task_get).toBe(renamed(block("Use this tool to retrieve a task by its ID")));
    expect(descriptions.task_list).toBe(renamed(block("Use this tool to list all tasks")));
    expect(descriptions.task_update).toBe(renamed(block("Use this tool to update a task")));
  });

  it("描述内引用的本仓实名在场、驼峰名绝迹", () => {
    for (const text of Object.values(descriptions)) {
      expect(text).not.toMatch(/Task(Create|Get|List|Update)/);
    }
    expect(TASK_CREATE_DESCRIPTION).toContain("use task_update to set up dependencies");
    expect(TASK_CREATE_DESCRIPTION).toContain("Check task_list first");
    expect(TASK_UPDATE_DESCRIPTION).toContain("using task_get before updating it");
  });
});

describe("参数面对账（spec 参数表格解析——description/enum/必填面全量）", () => {
  it("per-param description 逐字一致；参数集双向相等；必填面 ↔ required；status enum ↔ Union literals", async () => {
    const spec = await readFile(SPEC_PATH, "utf8");
    const requiredOf = (name: string): string[] => {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { required?: string[] };
      return schema.required ?? [];
    };
    const check = (tool: string, section: string, requiredFromTable: boolean): Array<[string, string, string]> => {
      const rows = tableRows(spec, section);
      expect(rows.length, `${tool} 表格非空`).toBeGreaterThan(0);
      const props = propsOf(tool);
      const named = rows.map(([rawName]) => rawName.replace(/^`|`$/g, ""));
      expect(Object.keys(props).sort()).toEqual([...named].sort());
      for (const [rawName, , , doc] of rows) {
        expect(props[rawName.replace(/^`|`$/g, "")]?.description, `${tool}.${rawName} description 与规格逐字一致`).toBe(doc);
      }
      if (requiredFromTable) {
        expect(requiredOf(tool)).toEqual(rows.filter(([, , req]) => req === "✅").map(([name]) => name.replace(/^`|`$/g, "")));
      }
      return rows.map(([name, type, req]) => [name.replace(/^`|`$/g, ""), type, req] as [string, string, string]);
    };
    check("task_create", "## 1. TaskCreate", false);
    expect(requiredOf("task_create")).toEqual([]);
    check("task_get", "## 2. TaskGet", true);
    const updateRows = check("task_update", "## 4. TaskUpdate", true);

    const statusRow = updateRows.find(([name]) => name === "status");
    if (statusRow === undefined) throw new Error("status 行缺席");
    const specEnum = (statusRow[1] ?? "").replace(/^enum:\s*/, "").split("|").map((v) => v.trim().replace(/`/g, ""));
    const schemaEnum = (propsOf("task_update").status as { anyOf?: Array<{ const?: string }> } | undefined)?.anyOf?.map((l) => l.const);
    expect(schemaEnum, "schema enum 从 Union 解析").toEqual(specEnum);
    expect(specEnum).toEqual(["pending", "in_progress", "completed", "deleted"]);
  });

  it("task_list 无参数（schema 空对象）", () => {
    expect(propsOf("task_list")).toEqual({});
  });
});
