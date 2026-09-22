// srt 会话共享点（docs/SANDBOX.md §3）：@x-harness/sandbox 的 SandboxManager 是模块级单例，
// 而一个进程并行装配多个世界（测试生态/host-hub worker）是常态——多插件实例经此共享唯一
// srt 会话：引用计数生命周期（首个 attach 探测+启动、末个 detach 后 reset），网络白名单
// 取跨实例并集（与跨会话并集同一边界：srt 单代理无连接归属——进程级白名单语义，落档已知边界）。
// 共享点按 runtime 实例键控（WeakMap）：真 runtime 全进程一组，注入假体各组独立。
// 文件面无共享态：每次 wrap 全量 per-exec 传入。基线剖面取最紧空集（fail-closed——真值恒随
// per-exec fence 走）。

import type { SrtFilesystem, SrtRuntime } from "./srt-runtime.ts";
import { mergeAllowlists, sameDomainSet } from "./allowlist.ts";

export interface SrtMember {
  /** 本实例当前网络面有效白名单（off→[]；unrestricted→['*']；否则 base∪会话授权） */
  effectiveAllowlist(): readonly string[];
}

export interface SrtSessionHandle {
  /** 本实例退出共享（收缩白名单；末个退出时 reset srt 会话） */
  detach(): Promise<void>;
  /** 白名单重算热切换（有变才切——srt 每请求读新表，授权即时生效） */
  refreshNetwork(): void;
}

interface SrtSessionShared {
  attach(member: SrtMember): Promise<SrtSessionHandle>;
  activeMembers(): number;
}

const EMPTY_BASELINE: SrtFilesystem = { denyRead: [], allowWrite: [], denyWrite: [] };

function createSrtSessionShared(runtime: SrtRuntime): SrtSessionShared {
  const members = new Set<SrtMember>();
  let lastApplied: readonly string[] | undefined;
  const refresh = (): void => {
    if (members.size === 0) return;
    const next = mergeAllowlists([...members].map((m) => m.effectiveAllowlist()));
    if (lastApplied === undefined || !sameDomainSet(lastApplied, next)) {
      lastApplied = next;
      runtime.syncNetwork(next);
    }
  };
  return {
    attach: async (member) => {
      if (members.size === 0) {
        const errors = await runtime.checkDeps();
        if (errors.length > 0) throw new Error(`sandbox dependencies unavailable: ${errors.join(", ")}`);
        await runtime.start(EMPTY_BASELINE);
        lastApplied = undefined;
      }
      members.add(member);
      return {
        detach: async () => {
          members.delete(member);
          if (members.size === 0) {
            lastApplied = undefined;
            await runtime.reset();
          } else {
            refresh(); // 余量成员并集收缩
          }
        },
        refreshNetwork: refresh,
      };
    },
    activeMembers: () => members.size,
  };
}

const sharedByRuntime = new WeakMap<SrtRuntime, SrtSessionShared>();

/** 同一 runtime 的进程级唯一共享点 */
export function srtSessionOf(runtime: SrtRuntime): SrtSessionShared {
  let shared = sharedByRuntime.get(runtime);
  if (shared === undefined) {
    shared = createSrtSessionShared(runtime);
    sharedByRuntime.set(runtime, shared);
  }
  return shared;
}
