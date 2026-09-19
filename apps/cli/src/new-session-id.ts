// 会话唯一 id 生成（docs/CLI.md §2.5）：SessionStore 缺省铸号是进程内计数，持久目录下
// 跨进程必撞 session-id-reused 永久拒写——CLI 一律显式生成。形态 `<UTC时间戳>-<随机>`，
// 满足 isSafeSessionId 词表 ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$（同时按字典序即时间序）。

import { isSafeSessionId } from "@x-harness/session";

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 6;

function randomSuffix(random: () => number): string {
  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    suffix += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)];
  }
  return suffix;
}

function timestamp(now: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
}

export function newSessionId(now: Date = new Date(), random: () => number = Math.random): string {
  const id = `${timestamp(now)}-${randomSuffix(random)}`;
  if (!isSafeSessionId(id)) {
    // 词表护栏：时间戳段恒安全，随机段恒取词表内字符——到达这里说明实现漂移，立即暴露
    throw new Error(`newSessionId produced an unsafe id: ${id}`);
  }
  return id;
}
