// realpath 契约实现（docs/EXEC-ENV.md §1/§2）：对已存在最深祖先做 realpath，不存在部分保持词法拼接。
// 语义自 toolbox PathGate.physicalOf 迁移（B1 起 PathGate 委托此处，删本地实现）——
// 「写新建文件」的门判定依赖不存在路径也有物理归一可用。

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** 契约 realpath：ENOENT 沿祖先上溯；EACCES 等其他错误同样上溯（词法兜底——与迁移前行为一致）；
 *  一路不存在到根也保留完整尾段（最深存在祖先=/——契约句「祖先 realpath 后拼接余段」不容丢段） */
export function realpathDeep(p: string, anchor: string = process.cwd()): string {
  let probe = resolve(anchor, p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch {
      const at = probe.lastIndexOf(sep);
      if (at <= 0) return resolve("/", ...tail); // 探到根都不存在：锚在根上的完整词法路径
      tail.unshift(probe.slice(at + 1));
      probe = probe.slice(0, at);
    }
  }
}

/** root 自身归一（macOS tmpdir /var→/private/var——词法 root 会把一切合法子路径判越根） */
export function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
