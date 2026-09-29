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

function sanitize(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/<\s*\/?\s*system/gi, "<\\/system").trim();
}

function clip(value: string): string {
  const units = Array.from(value);
  return units.length > DESCRIPTION_MAX ? `${units.slice(0, DESCRIPTION_MAX).join("")}…` : value;
}
