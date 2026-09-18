// jsonl 读面：list 只认 header.json；read 校验 header 版本/形状后逐行解析事件，
// 末行残缺（JSON.parse 失败）按崩溃痕迹跳过，中间损坏拒绝（docs/SESSION.md §1.8）。

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deepFreeze } from "@x-harness/core";
import { isSafeSessionId, validateSessionEvents } from "@x-harness/session";
import type { SessionArchive, SessionEvent, SessionHeader, SessionId } from "@x-harness/session";

export function createArchiveReader(root: string): SessionArchive {
  return {
    list: () => {
      let entries;
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch (error) {
        // 仅「root 尚未创建」视为无档案；权限等环境错误上抛（区分可见性，不静默折叠）
        if ((error as { code?: unknown }).code === "ENOENT") return Object.freeze([] as SessionId[]);
        throw error;
      }
      return Object.freeze(
        entries
          .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "header.json")))
          .map((entry) => entry.name as SessionId),
      );
    },

    read: async (id) => {
      if (!isSafeSessionId(id)) return { ok: false, reason: `invalid-id:${id}` };
      const dir = join(root, id);

      let headerText: string;
      try {
        headerText = await readFile(join(dir, "header.json"), "utf8");
      } catch {
        return { ok: false, reason: `no-header:${id}` };
      }
      let headerJson: unknown;
      try {
        headerJson = JSON.parse(headerText);
      } catch {
        return { ok: false, reason: `corrupt-header:${id}` };
      }
      const headerErr = gateHeader(headerJson, id);
      if (headerErr !== undefined) return { ok: false, reason: headerErr };
      const header = headerJson as SessionHeader;

      let text: string;
      try {
        text = await readFile(join(dir, "events.jsonl"), "utf8");
      } catch {
        return { ok: true, value: deepFreeze({ header, events: [] as SessionEvent[] }) };
      }
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const events: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line === "") return { ok: false, reason: `corrupt:${id}:line${i}` };
        try {
          events.push(JSON.parse(line));
        } catch {
          if (i === lines.length - 1) break; // 末行残缺 = 崩溃痕迹，跳过
          return { ok: false, reason: `corrupt:${id}:line${i}` };
        }
      }
      const validateErr = validateSessionEvents(events);
      if (validateErr !== undefined) return { ok: false, reason: `${validateErr}:${id}` };
      return { ok: true, value: deepFreeze({ header, events: events as SessionEvent[] }) };
    },
  };
}

function gateHeader(value: unknown, id: string): string | undefined {
  if (typeof value !== "object" || value === null) return `corrupt-header:${id}`;
  const record = value as Record<string, unknown>;
  if (record["id"] !== id) return `corrupt-header:${id}:id-mismatch`;
  if (typeof record["createdAt"] !== "number" || !Number.isFinite(record["createdAt"])) return `corrupt-header:${id}`;
  return undefined;
}
