// 路径门（docs/TOOLBOX.md §1）：root 解析、越根拒绝（路径段边界）、realpath 归一判定
// （仅用于门判定——实际 I/O 落词法路径）、NUL 拒绝。

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export class PathGate {
  readonly root: string;
  readonly lexicalRoot: string;

  constructor(root: string) {
    // root 自身归一到物理路径（macOS tmpdir 是 /var→/private/var symlink——词法 root 会把
    // 一切合法子路径判越根）；不存在的 root 保持词法（mkdir 前的门判定）
    this.lexicalRoot = resolve(root);
    this.root = realpathOrSelf(this.lexicalRoot);
  }

  /** 入参含 NUL → 拒（统一口径：三工具与 bash command/workdir） */
  static hasNul(value: string): boolean {
    return value.includes("\u0000");
  }

  /** 越根/逃逸 → 错误码；通过 → 返回词法绝对路径（I/O 用这条，不用 realpath） */
  admit(target: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (PathGate.hasNul(target)) return { ok: false, reason: "NUL_IN_ARGUMENT: path contains NUL" };
    // 绝对入参可能以词法 root 写入（如 /var/... 而门 root 是 /private/...）——先归一到词法 root 再判
    const lexical = isAbsolute(target) ? resolve(this.rebaseToRoot(resolve(target))) : resolve(this.root, target);
    if (!this.withinRootLexical(lexical)) {
      return { ok: false, reason: `PATH_ESCAPES_ROOT: ${target} resolves outside the workspace root` };
    }
    const physical = this.physicalOf(lexical);
    if (!this.withinRootLexical(physical)) {
      return { ok: false, reason: `PATH_ESCAPES_ROOT: ${target} resolves (through symlink) outside the workspace root` };
    }
    return { ok: true, path: lexical };
  }

  /** 词法 root（/var/...）的入参换算到物理 root（/private/...）前缀；非 root 前缀原样返回 */
  private rebaseToRoot(absolute: string): string {
    const lexicalRoot = this.lexicalRoot;
    if (lexicalRoot !== this.root && (absolute === lexicalRoot || absolute.startsWith(lexicalRoot + sep))) {
      return absolute === lexicalRoot ? this.root : this.root + absolute.slice(lexicalRoot.length);
    }
    return absolute;
  }

  /** 路径段边界前缀判定（防 /w/app vs /w/appdir 混淆；root="/" 时前缀即 "/"——一切绝对路径都在根内） */
  private withinRootLexical(p: string): boolean {
    const prefix = this.root.endsWith(sep) ? this.root : this.root + sep;
    return p === this.root || p.startsWith(prefix);
  }

  /** 对已存在最深祖先做 realpath（symlink 逃逸防护；不存在部分保持词法拼接） */
  private physicalOf(lexical: string): string {
    let probe = lexical;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = realpathSync(probe);
        return tail.length === 0 ? real : resolve(real, ...tail);
      } catch {
        const at = probe.lastIndexOf(sep);
        if (at <= 0) return lexical; // 一直探到根都不存在：词法判定已够
        tail.unshift(probe.slice(at + 1));
        probe = probe.slice(0, at);
      }
    }
  }
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
