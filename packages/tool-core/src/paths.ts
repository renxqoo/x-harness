// 路径门（docs/TOOLBOX.md §1 + docs/EXEC-ENV.md §3）：root 词法解析、越根拒绝（路径段边界）、
// 物理归一判定经注入的 env.realpath（单源在 exec-env——本文件不再持有 realpath 实现），
// 实际 I/O 落词法路径；NUL 拒绝。会话根替换（worktree 隔离——件13 接缝 4）：overrideRoot
// 替换主根（原根不可达），extraRoots 由调用方按守卫根过滤。

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { SessionId } from "@x-harness/session";

export type RealpathFn = (p: string) => Promise<string>;

export class PathGate {
  readonly root: string;
  readonly lexicalRoot: string;

  constructor(root: string) {
    // root 自身归一到物理路径（macOS tmpdir 是 /var→/private/var symlink——词法 root 会把
    // 一切合法子路径判越根）；不存在的 root 保持词法（mkdir 前的门判定）
    this.lexicalRoot = resolve(root);
    this.root = realpathOrSelf(this.lexicalRoot);
  }

  /** 入参含 NUL → 拒（统一口径：工具路径入参与 bash command） */
  static hasNul(value: string): boolean {
    return value.includes("\u0000");
  }

  /** 越根/逃逸 → 错误码；通过 → 返回词法绝对路径（I/O 用这条，不用 realpath）。
   *  物理判定（symlink 逃逸防护）经 realpath 参数——由调用方注入 env.realpath（单源）。
   *  opts.extraRoots：会话授权根（permission 批准落账）——同样词法+物理双查后放行。
   *  opts.overrideRoot：会话根替换（替换 this.root——词法/物理双形同源子门）。 */
  async admit(
    target: string,
    realpath: RealpathFn,
    opts: { readonly extraRoots?: readonly string[]; readonly overrideRoot?: string } = {},
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const gate = opts.overrideRoot !== undefined ? new PathGate(opts.overrideRoot) : this;
    const extraRoots = opts.extraRoots ?? [];
    const { root } = gate;
    if (PathGate.hasNul(target)) return { ok: false, reason: "NUL_IN_ARGUMENT: path contains NUL" };
    // 绝对入参可能以词法 root 写入（如 /var/... 而门 root 是 /private/...）——先归一到词法 root 再判
    const lexical = isAbsolute(target) ? resolve(gate.rebaseToRoot(resolve(target))) : resolve(root, target);
    // 授权根双形（词法 + 物理——macOS /var→/private/var；symlink 逃逸双查每根独立执行）
    const roots = [root];
    for (const r of extraRoots) {
      roots.push(resolve(r));
      const physicalRoot = await realpath(resolve(r));
      if (!roots.includes(physicalRoot)) roots.push(physicalRoot);
    }
    if (!roots.some((r) => gate.withinRootLexicalOf(r, lexical))) {
      return { ok: false, reason: `PATH_ESCAPES_ROOT: ${target} resolves outside the workspace root` };
    }
    const physical = await realpath(lexical);
    if (!roots.some((r) => gate.withinRootLexicalOf(r, physical))) {
      return { ok: false, reason: `PATH_ESCAPES_ROOT: ${target} resolves (through symlink) outside the workspace root` };
    }
    return { ok: true, path: lexical };
  }

  private withinRootLexicalOf(root: string, p: string): boolean {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return p === root || p.startsWith(prefix);
  }

  /** 词法 root（/var/...）的入参换算到物理 root（/private/...）前缀；非 root 前缀原样返回 */
  private rebaseToRoot(absolute: string): string {
    if (this.lexicalRoot !== this.root && (absolute === this.lexicalRoot || absolute.startsWith(this.lexicalRoot + sep))) {
      return absolute === this.lexicalRoot ? this.root : this.root + absolute.slice(this.lexicalRoot.length);
    }
    return absolute;
  }

}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export type RootOverrideOf = (session: SessionId | undefined) => { readonly dir: string; readonly guard: string } | undefined;

function withinLexical(root: string, p: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(prefix);
}

/** 会话面统一入口：override 在场 → 原根不可达 + 守卫根子树的 extraRoots 批准被过滤（件13 §8.2） */
export interface SessionAdmitInput {
  readonly gate: PathGate;
  readonly realpath: RealpathFn;
  readonly session: SessionId | undefined;
  readonly extraRootsOf: (session: SessionId | undefined) => readonly string[];
  readonly rootOverrideOf?: RootOverrideOf;
  readonly target: string;
}

/** 会话面统一入口：override 在场 → 原根不可达 + 守卫根子树的 extraRoots 批准被过滤（件13 §8.2） */
export async function admitSession(input: SessionAdmitInput): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const override = input.rootOverrideOf?.(input.session);
  const extraRoots = override === undefined
    ? input.extraRootsOf(input.session)
    : input.extraRootsOf(input.session).filter((r) => !withinLexical(override.guard, resolve(r)));
  return input.gate.admit(input.target, input.realpath, { extraRoots, overrideRoot: override?.dir });
}
