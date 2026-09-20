// 会话唯一 id 铸号（单一来源：store 缺省铸号即此）。形态 `<UTC时间戳>-<6位随机>`，满足
// isSafeSessionId 词表 ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$（字典序即时间序）——跨进程唯一，
// 持久目录下撞名即 session-id-reused 永久拒写（fail-closed，不做重试）。

import { isSafeSessionId } from "./gates.ts";
import type { SessionId } from "./types.ts";

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 6;

function randomSuffix(random: () => number): string {
  let suffix = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) {
    // 上界钳制：注入 random 返回 ≥1 时 floor 越界取 undefined——词表护栏拦不住拼接串，钳到末位
    const at = Math.min(Math.floor(random() * RANDOM_ALPHABET.length), RANDOM_ALPHABET.length - 1);
    suffix += RANDOM_ALPHABET[at];
  }
  return suffix;
}

function timestamp(now: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
}

export function mintSessionId(now: Date = new Date(), random: () => number = Math.random): SessionId {
  const id = `${timestamp(now)}-${randomSuffix(random)}`;
  if (!isSafeSessionId(id)) {
    // 词表护栏：时间戳段恒安全，随机段恒取词表内字符——到达这里说明实现漂移，立即暴露
    throw new Error(`mintSessionId produced an unsafe id: ${id}`);
  }
  return id as SessionId;
}
