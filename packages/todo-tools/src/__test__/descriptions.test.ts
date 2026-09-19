// 描述与参数对账（docs/TODO.md §2/§6）：正文与规格 blockquote 原文逐字符一致
// （唯一合法偏离 = 已知工具名替换集）；per-param description 与规格参数表格列全量
// 逐字一致（表格解析对账——零转录风险）；参数面双向对账（描述承诺的参数 schema 必有、
// schema 有的参数描述必提）。

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createTodoStore } from "../store.ts";
import { createTodoTools } from "../tools.ts";
import {
  TASK_CREATE_DESCRIPTION,
  TASK_GET_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
} from "../descriptions.ts";

const SPEC_PATH = "/Users/wrr/work/claude-tool/task-tools.md";

/** 已知替换集（docs/TODO.md §2①）：本仓注册名——对账时施加于 spec 原文后应逐字符相等 */
const RENAMES: Array<[RegExp, string]> = [
  [/TaskUpdate/g, "task_update"],
  [/TaskList/g, "task_list"],
  [/TaskGet/g, "task_get"],
];

const tools = createTodoTools(createTodoStore());
const descriptions: Record<string, string> = {
  task_create: TASK_CREATE_DESCRIPTION,
  task_get: TASK_GET_DESCRIPTION,
  task_list: TASK_LIST_DESCRIPTION,
  task_update: TASK_UPDATE_DESCRIPTION,
};

/** spec blockquote 原文块抽取（> 前缀剥除，连续块合并） */
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

/** spec 参数表格解析：工具节内 `### 参数` 后首表 → 参数名 → description 全映射。
 *  行内 `\|` 是转义竖线（enum 值），split 前先占位再还原 */
function paramTableOf(spec: string, section: string): Record<string, string> {
  const start = spec.indexOf(section);
  expect(start, `spec 节在场：${section}`).toBeGreaterThan(-1);
  const body = spec.slice(start, spec.indexOf("\n## ", start));
  const tableStart = body.indexOf("| 参数 |");
  expect(tableStart, `参数表格在场：${section}`).toBeGreaterThan(-1);
  const rows = body.slice(tableStart).split("\n").filter((line) => line.startsWith("|"));
  const out: Record<string, string> = {};
  for (const row of rows.slice(2)) {
    const cells = row.replace(/\\\|/g, "<PIPE/>").split("|").map((cell) => cell.replace(/<PIPE\/>/g, "|").trim());
    const name = (cells[1] ?? "").replace(/^`|`$/g, "");
    if (name !== "") out[name] = cells[4] ?? "";
  }
  return out;
}

function propsOf(name: string): Record<string, { description?: string }> {
  const schema = tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
  return schema?.properties ?? {};
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

describe("per-param description 全量对账（spec 参数表格列逐字）", () => {
  it("task_create 四参数 + task_get/task_update 参数与规格表格逐字符一致", async () => {
    const spec = await readFile(SPEC_PATH, "utf8");
    const tableOf = (name: string): Record<string, string> => {
      const table = paramTableOf(spec, name);
      expect(Object.keys(table).length, `${name} 表格非空`).toBeGreaterThan(0);
      return table;
    };
    const check = (tool: string, table: Record<string, string>): void => {
      const props = propsOf(tool);
      expect(Object.keys(props).sort()).toEqual(Object.keys(table).sort());
      for (const [param, doc] of Object.entries(table)) {
        expect(props[param]?.description, `${tool}.${param} description 与规格逐字一致`).toBe(doc);
      }
    };
    check("task_create", tableOf("## 1. TaskCreate"));
    check("task_get", tableOf("## 2. TaskGet"));
    check("task_update", tableOf("## 4. TaskUpdate"));
  });

  it("task_list 无参数（schema 空对象）", () => {
    expect(propsOf("task_list")).toEqual({});
  });
});

describe("参数面双向对账（schema 结构事实）", () => {
  it("task_create required 为空（规格原样）；task_get/task_update 必填 taskId", () => {
    const schemaOf = (name: string): { required?: string[] } =>
      tools.find((t) => t.name === name)?.inputSchema as { required?: string[] };
    expect(schemaOf("task_create").required ?? []).toEqual([]);
    expect(schemaOf("task_get").required).toEqual(["taskId"]);
    expect(schemaOf("task_update").required).toEqual(["taskId"]);
  });

  it("task_update 参数面 = taskId + 8 可选字段（规格参数表全集）", () => {
    expect(Object.keys(propsOf("task_update")).sort()).toEqual(
      ["taskId", "subject", "description", "activeForm", "status", "owner", "metadata", "addBlocks", "addBlockedBy"].sort(),
    );
  });
});
