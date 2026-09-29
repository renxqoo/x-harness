import type { Disposer, Plugin } from "@x-harness/core";
import type { SessionId } from "@x-harness/session";
import { sessionDisposed } from "@x-harness/session";
import { execEnv } from "@x-harness/exec-env";
import { createLocalEnv } from "@x-harness/exec-env";
import { permissionGrants } from "@x-harness/permission";
import { fenceFacts } from "@x-harness/permission";
import { fenceFor } from "./fence.ts";
import type { FenceBase } from "./fence.ts";
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

      let tornDown = false;
      const seen = new Set<string>();
      const member: SrtMember = {
        effectiveAllowlist: () => {
          if (options.networkOff === true) return [];
          const unrestrictedActive =
            grants.isUnrestricted(undefined) || [...seen].some((k) => grants.isUnrestricted(sessionOfKey(k)));
          if (unrestrictedActive) return ["*"];
          return options.allowedDomains ?? [];
        },
        localBinding: () => options.allowLocalBinding ?? true,
      };
      const session = srtSessionOf(runtime);
      const handle: SrtSessionHandle = await session.attach(member);

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
        seen.delete(sessionKey(session));
        handle.refreshNetwork();
      });

      return async () => {
        tornDown = true;
        for (const proc of sandbox.liveHandles()) await proc.kill("term");
        const killTimer = setTimeout(() => {
          for (const proc of sandbox.liveHandles()) void proc.kill("kill");
        }, DISPOSE_GRACE_MS);
        await Promise.race([
          Promise.allSettled(sandbox.liveHandles().map((proc) => proc.settled)),
          new Promise<void>((resolve) => {
            setTimeout(resolve, SETTLE_CAP_MS);
          }),
        ]);
        clearTimeout(killTimer);
        let detachError: unknown;
        try {
          await handle.detach();
        } catch (error) {
          detachError = error;
        }
        offEnv();
        offFacts();
        offDisposed();
        if (detachError !== undefined) throw detachError;
      };
    },
  };
}
