import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { SessionId } from "@x-harness/session";

export type RealpathFn = (p: string) => Promise<string>;

export class PathGate {
  readonly root: string;
  readonly lexicalRoot: string;

  constructor(root: string) {
    this.lexicalRoot = resolve(root);
    this.root = realpathOrSelf(this.lexicalRoot);
  }

  static hasNul(value: string): boolean {
    return value.includes("\u0000");
  }

  async admit(
    target: string,
    realpath: RealpathFn,
    opts: { readonly extraRoots?: readonly string[]; readonly overrideRoot?: string } = {},
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const gate = opts.overrideRoot !== undefined ? new PathGate(opts.overrideRoot) : this;
    const extraRoots = opts.extraRoots ?? [];
    const { root } = gate;
    if (PathGate.hasNul(target)) return { ok: false, reason: "NUL_IN_ARGUMENT: path contains NUL" };
    const lexical = isAbsolute(target) ? resolve(gate.rebaseToRoot(resolve(target))) : resolve(root, target);
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

export interface SessionAdmitInput {
  readonly gate: PathGate;
  readonly realpath: RealpathFn;
  readonly session: SessionId | undefined;
  readonly extraRootsOf: (session: SessionId | undefined) => readonly string[];
  readonly rootOverrideOf?: RootOverrideOf;
  readonly target: string;
}

export async function admitSession(input: SessionAdmitInput): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const override = input.rootOverrideOf?.(input.session);
  const extraRoots = override === undefined
    ? input.extraRootsOf(input.session)
    : input.extraRootsOf(input.session).filter((r) => !withinLexical(override.guard, resolve(r)));
  return input.gate.admit(input.target, input.realpath, { extraRoots, overrideRoot: override?.dir });
}
