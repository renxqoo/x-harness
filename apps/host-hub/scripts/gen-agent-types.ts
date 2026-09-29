import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const sourceDir = join(root, "../agent-types");
const outFile = join(root, "../src/worker/agent-types-data.ts");

const files = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

const entries = files.map((name) => {
  const text = readFileSync(join(sourceDir, name), "utf8");
  const stem = name.slice(0, -".md".length);
  return { stem, text };
});

const lines = [
  "// 生成的资源模块（scripts/gen-agent-types.ts 产物——勿手改；源 = agent-types/*.md）。",
  "// 内置 agent 类型随 bundle 内联分发：worker 任意运行形态（src/dist/打包发行）恒装载，",
  "// 不依赖盘上 agent-types 目录。",
  "export interface BuiltinAgentTypeResource {",
  "  readonly stem: string;",
  "  readonly text: string;",
  "}",
  "",
  `export const BUILTIN_AGENT_TYPES: readonly BuiltinAgentTypeResource[] = [`,
  ...entries.map(({ stem, text }) => `  { stem: ${JSON.stringify(stem)}, text: ${JSON.stringify(text)} },`),
  "];",
  "",
];

writeFileSync(outFile, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`gen-agent-types: ${entries.length} types -> ${outFile}\n`);
