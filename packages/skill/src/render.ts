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

/** 控制字符（Cc）与格式字符（Cf：ZWSP/RTL override 等）压成空格；system 开/闭标签
 *  中和（大小写不敏感——防 reminder 包装击穿） */
function sanitize(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/<\s*\/?\s*system/gi, "<\\/system").trim();
}

/** 按码点截断——UTF-16 代理对不截半（孤立代理项出进程会变 U+FFFD） */
function clip(value: string): string {
  const units = Array.from(value);
  return units.length > DESCRIPTION_MAX ? `${units.slice(0, DESCRIPTION_MAX).join("")}…` : value;
}
