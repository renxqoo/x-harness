// sandbox 插件（docs/EXEC-ENV.md §0/§5）：装配即围栏。inject ["permission"]——消费 grants（fence
// 合成/域名单飞）与 broker token（域名 ask 缺席退化 deny 由 grants/代理承担）；提供 execEnv（围栏版）
// 与 fenceFacts（单一合成函数暴露给 permission 界内判定）。拆卸契约：torn-down 后新 spawn fail-fast →
// 活围栏组两段杀 → await settled → 关会话代理池。装配期 probe fail-closed 拒启。

import type { Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { sessionDisposed } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import { createLocalEnv } from "@x-harness/exec-env";
import { permissionBroker, permissionGrants } from "@x-harness/permission";
import { fenceFacts } from "@x-harness/permission";
import { fenceFor } from "./fence.ts";
import type { FenceBase } from "./fence.ts";
import { createSandboxEnv } from "./env.ts";
import type { ProxyTarget } from "./env.ts";
import { createSessionProxy } from "./proxy/server.ts";
import type { ProxyHandle } from "./proxy/server.ts";
import { assertProbes, probeWrappers } from "./probe.ts";

const DISPOSE_GRACE_MS = 5_000;

export type SandboxOptions = FenceBase;

export function createSandboxPlugin(options: SandboxOptions): Plugin {
  return {
    name: "sandbox-local",
    inject: ["permission"],
    apply: (ctx): Disposer => {
      const probe = probeWrappers();
      assertProbes(probe, options.networkOff === true); // 装配期 fail-closed：缺席宿主起不来
      const grants = ctx.use(permissionGrants);
      const fenceOf = (session: SessionId | undefined): ReturnType<typeof fenceFor> => fenceFor(options, grants, session);

      let tornDown = false;
      const proxies = new Map<string, ProxyHandle>();
      const proxyTargetOf = async (session: SessionId | undefined): Promise<ProxyTarget | undefined> => {
        if (tornDown) return undefined;
        if (options.networkOff === true) return undefined; // fence 已 off——不会走到（防御）
        const key = session ?? "_anon";
        const existing = proxies.get(key);
        if (existing !== undefined) return probe.dialect === "darwin" ? { port: existing.port } : { mounted: true };
        const broker = ctx.tryUse(permissionBroker);
        const handle = await createSessionProxy(session, grants, {
          askDomain: async (s, domain) => {
            if (tornDown || broker === undefined) return "deny"; // broker 缺席/拆卸 → ask 退化 deny
            try {
              return await broker.ask({ tool: "network", reason: `connect to ${domain}`, ...(s !== undefined ? { session: s } : {}) });
            } catch {
              return "deny";
            }
          },
        });
        if (tornDown) {
          await handle.close(); // 竞态：拆卸发生在监听建立之间——立即收口
          return undefined;
        }
        proxies.set(key, handle);
        return probe.dialect === "darwin" ? { port: handle.port } : { mounted: true };
      };

      const sandbox = createSandboxEnv({
        base: createLocalEnv(options.root),
        fenceOf,
        dialect: probe.dialect,
        proxyTargetOf,
        isTornDown: () => tornDown,
      });

      const offEnv = ctx.provide(execEnv, sandbox.env);
      const offFacts = ctx.provide(fenceFacts, {
        forSession: (session: SessionId | undefined) => {
          const f = fenceOf(session);
          return {
            writable: f.writable,
            allowedDomains: f.network === "off" ? [] : f.network.allowedDomains,
          };
        },
      });
      const offDisposed = ctx.on(sessionDisposed, async ({ session }) => {
        const key = session ?? "_anon";
        const proxy = proxies.get(key);
        if (proxy !== undefined) {
          proxies.delete(key);
          await proxy.close(); // 在飞 CONNECT 以 socket close 撤 ask → deny 收尾
        }
      });

      return async () => {
        tornDown = true; // 新 spawn fail-fast（sandbox_unavailable）
        for (const handle of sandbox.liveHandles()) await handle.kill("term");
        const killTimer = setTimeout(() => {
          for (const handle of sandbox.liveHandles()) void handle.kill("kill");
        }, DISPOSE_GRACE_MS);
        await Promise.allSettled(sandbox.liveHandles().map((handle) => handle.settled));
        clearTimeout(killTimer);
        for (const proxy of proxies.values()) await proxy.close();
        proxies.clear();
        offEnv();
        offFacts();
        offDisposed();
      };
    },
  };
}
