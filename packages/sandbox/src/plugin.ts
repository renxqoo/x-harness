// sandbox 插件（docs/SANDBOX.md §1/§3）：装配即围栏。inject ["permission"]——仅消费 grants
// 数据面（extraRoots/域名授权/unrestricted/rootOverride——用户裁决②：裁决与交互全归 permission，
// 本插件无 broker 无 ask）。提供 execEnv（围栏版）与 fenceFacts（同一 fenceFor 产物——决策与
// spawn 共用单一解析函数）。多实例共享唯一 srt 会话（srt-session 引用计数；网络白名单跨实例
// 并集）。拆卸契约：tornDown 后新 spawn fail-fast → 活句柄两段杀 → await settled（有界 5s）→
// detach 共享会话（末个实例退出才 reset srt）。装配期依赖缺失 fail-closed 拒启。

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
import type { SrtMember } from "./srt-session.ts";
import { createSandboxEnv } from "./env.ts";

const DISPOSE_GRACE_MS = 5_000;

export type SandboxOptions = FenceBase;

const sessionKey = (session: SessionId | undefined): string => session ?? "_anon";

export function createSandboxPlugin(options: SandboxOptions, runtime: SrtRuntime = realSrtRuntime): Plugin {
  return {
    name: "sandbox",
    inject: ["permission"],
    apply: async (ctx): Promise<Disposer> => {
      const grants = ctx.use(permissionGrants);
      const fenceOf = (session: SessionId | undefined) => fenceFor(options, grants, session);

      // 本实例网络面状态：spawn 前登记会话 → 白名单重算（跨实例并集由共享点聚合）
      let tornDown = false;
      const seen = new Set<string>();
      const member: SrtMember = {
        effectiveAllowlist: () => {
          if (options.networkOff === true) return [];
          if (grants.isUnrestricted(undefined)) return ["*"];
          return mergeAllowlists([
            options.allowedDomains ?? [],
            ...[...seen].map((k) => grants.allowedDomainsOf(k === "_anon" ? undefined : (k as SessionId))),
          ]);
        },
      };
      const session = srtSessionOf(runtime);
      const handle = await session.attach(member); // 依赖缺失在此 fail-closed throw

      const syncAllowlist = (spawnSession: SessionId | undefined): void => {
        seen.add(sessionKey(spawnSession));
        handle.refreshNetwork();
      };

      const sandbox = createSandboxEnv({
        base: createLocalEnv(options.root),
        runtime,
        fenceOf,
        syncAllowlist,
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
        seen.delete(sessionKey(session)); // 会话终结：授权域名随下次重算退出并集
      });

      return async () => {
        tornDown = true; // 新 spawn fail-fast（sandbox_unavailable）
        for (const proc of sandbox.liveHandles()) await proc.kill("term");
        const killTimer = setTimeout(() => {
          for (const proc of sandbox.liveHandles()) void proc.kill("kill");
        }, DISPOSE_GRACE_MS);
        await Promise.allSettled(sandbox.liveHandles().map((proc) => proc.settled));
        clearTimeout(killTimer);
        await handle.detach(); // 末个实例退出才 reset srt；否则白名单收缩
        offEnv();
        offFacts();
        offDisposed();
      };
    },
  };
}
