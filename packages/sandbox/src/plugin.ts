// sandbox 插件（docs/SANDBOX.md §1/§3）：装配即围栏。inject ["permission"]——仅消费 grants
// 数据面（extraRoots/域名授权/unrestricted/rootOverride——用户裁决②：裁决与交互全归 permission，
// 本插件无 broker 无 ask）。提供 execEnv（围栏版）与 fenceFacts（同一 fenceFor 产物——决策与
// spawn 共用单一解析函数）。多实例共享唯一 srt 会话（srt-session 互斥链引用计数；网络白名单
// 跨实例并集）。拆卸契约：tornDown 后新 spawn fail-fast → 活句柄两段杀 → await settled（独立
// 有界上限——不可杀组长的极端形态不挂死拆卸）→ detach 共享会话（末个实例退出才 reset srt；
// detach 失败不阻断服务下线，错误聚合上抛）。

import type { Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { sessionDisposed } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import { createLocalEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { fenceFacts } from "@x-harness/permission";
import { fenceFor } from "./fence.ts";
import type { FenceBase } from "./fence.ts";
import { mergeAllowlists } from "./allowlist.ts";
import { realSrtRuntime } from "./srt-runtime.ts";
import type { SrtRuntime } from "./srt-runtime.ts";
import { srtSessionOf } from "./srt-session.ts";
import type { SrtMember, SrtSessionHandle } from "./srt-session.ts";
import { createSandboxEnv } from "./env.ts";

const DISPOSE_GRACE_MS = 5_000;
const SETTLE_CAP_MS = 10_000;

export type SandboxOptions = FenceBase;

const sessionKey = (session: SessionId | undefined): string => session ?? "_anon";
const sessionOfKey = (key: string): SessionId | undefined => (key === "_anon" ? undefined : (key as SessionId));

export function createSandboxPlugin(options: SandboxOptions, runtime: SrtRuntime = realSrtRuntime): Plugin {
  return {
    name: "sandbox",
    inject: ["permission"],
    apply: async (ctx): Promise<Disposer> => {
      const grants = ctx.use(permissionGrants);
      const fenceOf = (session: SessionId | undefined) => fenceFor(options, grants, session);

      // 本实例网络面状态：spawn 前登记会话 → 白名单重算（跨实例并集由共享点聚合）。
      // unrestricted 探针 = anon ∪ 已见会话任一为真——单一 anon 键在 anon 被 override 记忆
      // 时与逐会话 fence 判定分叉（full 档网络被拒的旧症状形态），并集口径闭合该分叉。
      let tornDown = false;
      const seen = new Set<string>();
      const member: SrtMember = {
        effectiveAllowlist: () => {
          if (options.networkOff === true) return [];
          const unrestrictedActive =
            grants.isUnrestricted(undefined) || [...seen].some((k) => grants.isUnrestricted(sessionOfKey(k)));
          if (unrestrictedActive) return ["*"];
          return mergeAllowlists([
            options.allowedDomains ?? [],
            ...[...seen].map((k) => grants.allowedDomainsOf(sessionOfKey(k))),
          ]);
        },
        localBinding: () => options.allowLocalBinding ?? true, // 缺省开——用户裁决④
      };
      const session = srtSessionOf(runtime);
      const handle: SrtSessionHandle = await session.attach(member); // 依赖缺失在此 fail-closed throw

      const syncAllowlist = (spawnSession: SessionId | undefined): void => {
        seen.add(sessionKey(spawnSession));
        handle.refreshNetwork();
      };

      const sandbox = createSandboxEnv({
        base: createLocalEnv(options.root),
        runtime,
        fenceOf,
        syncAllowlist,
        trustedCommands: options.trustedCommands ?? [],
        isTornDown: () => tornDown,
      });

      const offEnv = ctx.provide(execEnv, sandbox.env);
      const offFacts = ctx.provide(fenceFacts, {
        forSession: (session: SessionId | undefined) => {
          const f = fenceOf(session);
          return { writable: f.writable, allowedDomains: f.allowedDomains };
        },
      });
      const offDisposed = ctx.on(sessionDisposed, ({ session }) => {
        seen.delete(sessionKey(session));
        handle.refreshNetwork(); // 即时收缩：已逐出会话的授权域名不再等下一次 spawn
      });

      return async () => {
        tornDown = true; // 新 spawn fail-fast（sandbox_unavailable）
        for (const proc of sandbox.liveHandles()) await proc.kill("term");
        const killTimer = setTimeout(() => {
          for (const proc of sandbox.liveHandles()) void proc.kill("kill");
        }, DISPOSE_GRACE_MS);
        // 独立有界上限：不可杀组长（D 态等）不挂死拆卸——残留清场归 base 的 host-exit finalizer
        await Promise.race([
          Promise.allSettled(sandbox.liveHandles().map((proc) => proc.settled)),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SETTLE_CAP_MS);
          }),
        ]);
        clearTimeout(killTimer);
        let detachError: unknown;
        try {
          await handle.detach(); // 末个实例退出才 reset srt；否则白名单收缩
        } catch (error) {
          detachError = error; // reset 失败不阻断服务下线——错误面聚合上抛（拆卸契约：部分失败可观测）
        }
        offEnv();
        offFacts();
        offDisposed();
        if (detachError !== undefined) throw detachError;
      };
    },
  };
}
