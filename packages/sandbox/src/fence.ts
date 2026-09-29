import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { GrantsRegistry } from "@x-harness/permission";

export interface Fence {
  readonly writable: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly unfenced: boolean;
  readonly isolated: boolean;
}

export interface FenceBase {
  readonly root: string;
  readonly writableExtra?: readonly string[];
  readonly denyReadExtra?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly allowedDomains?: readonly string[];
  readonly networkOff?: boolean;
  readonly allowLocalBinding?: boolean;
}

export const DEFAULT_DENY_READ: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

export const CHILD_TMPDIR: string = process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";

function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function withinLexical(root: string, p: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(prefix);
}

export function fenceFor(base: FenceBase, grants: GrantsRegistry, session: SessionId | undefined): Fence {
  const override = grants.rootOverrideOf(session);
  const unrestricted = grants.isUnrestricted(session);
  const extraRoots = override === undefined
    ? grants.extraRootsOf(session)
    : grants.extraRootsOf(session).filter((r) => !withinLexical(resolve(override.guard), resolve(r)));
  const writable = [
    ...(unrestricted ? ["/"] : []),
    override?.dir ?? base.root,
    tmpdir(),
    CHILD_TMPDIR,
    ...(base.writableExtra ?? []),
    ...extraRoots,
  ].map(expand);
  const denyRead = [...DEFAULT_DENY_READ, ...(base.denyReadExtra ?? [])];
  const denyWrite = [expand(`${override?.dir ?? base.root}/.git`), ...(base.protectedPaths ?? []).map(expand)];
  const isolated = override !== undefined;
  if (base.networkOff === true) return { writable, denyRead, denyWrite, allowedDomains: [], unfenced: false, isolated };
  if (unrestricted) return { writable, denyRead, denyWrite, allowedDomains: ["*"], unfenced: true, isolated };
  return { writable, denyRead, denyWrite, allowedDomains: base.allowedDomains ?? [], unfenced: false, isolated };
}
