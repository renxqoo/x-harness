// 清单渲染（docs/SKILL.md §1.2）：纯函数；空表空串；三字段同洗（控制字符压空格 +
// </system 字面量中和）+ description 截断 + 条目上限——把无门披露面做成有界。

import type { SkillMeta } from "./types.ts";

const MAX_ENTRIES = 50;
const DESCRIPTION_MAX = 200;

export function renderSkillsBlock(skills: Readonly<Record<string, SkillMeta>>): string {
  const names = Object.keys(skills).sort();
  if (names.length === 0) return "";
  const lines: string[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const meta = skills[name];
    if (meta !== undefined) {
      lines.push(`- ${sanitize(meta.name)}: ${clip(sanitize(meta.description))} (${sanitize(meta.path)})`);
    }
  }
  if (names.length > MAX_ENTRIES) lines.push(`… and ${names.length - MAX_ENTRIES} more`);
  return `<system-reminder>\n### Available skills\n${lines.join("\n")}\n</system-reminder>`;
}

/** 控制字符（含换行/中位 \r/ESC，Unicode Cc 类）压成空格；</system 中和防 reminder 包装击穿 */
function sanitize(value: string): string {
  return value.replace(/[\p{Cc}]+/gu, " ").replaceAll("</system", "<\\/system").trim();
}

function clip(value: string): string {
  return value.length > DESCRIPTION_MAX ? `${value.slice(0, DESCRIPTION_MAX)}…` : value;
}
