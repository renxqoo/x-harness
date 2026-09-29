import type { SrtFilesystem, SrtRuntime } from "./srt-runtime.ts";
import { mergeAllowlists, sameDomainSet } from "./allowlist.ts";

export interface SrtMember {
  effectiveAllowlist(): readonly string[];
  localBinding(): boolean;
}

export interface SrtSessionHandle {
  detach(): Promise<void>;
  refreshNetwork(): void;
}

interface SrtSessionShared {
  attach(member: SrtMember): Promise<SrtSessionHandle>;
}

const EMPTY_BASELINE: SrtFilesystem = { denyRead: [], allowWrite: [], denyWrite: [] };

function createSrtSessionShared(runtime: SrtRuntime): SrtSessionShared {
  const members = new Set<SrtMember>();
  let lastApplied: readonly string[] | undefined;
  let localBinding: boolean | undefined;
  let ops: Promise<void> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = ops.then(op, op);
    ops = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const refresh = (): void => {
    if (members.size === 0) return;
    const next = mergeAllowlists([...members].map((m) => m.effectiveAllowlist()));
    if (lastApplied === undefined || !sameDomainSet(lastApplied, next)) {
      runtime.syncNetwork(next);
      lastApplied = next;
    }
  };
  return {
    attach: (member) =>
      enqueue(async () => {
        if (localBinding !== undefined && localBinding !== member.localBinding()) {
          throw new Error(
            `sandbox allowLocalBinding conflict in this process: session started with ${String(localBinding)}, member declares ${String(member.localBinding())} — host policy must be uniform`,
          );
        }
        if (members.size === 0) {
          const errors = await runtime.checkDeps();
          if (errors.length > 0) throw new Error(`sandbox dependencies unavailable: ${errors.join(", ")}`);
          localBinding = member.localBinding();
          await runtime.start(EMPTY_BASELINE, localBinding);
          lastApplied = undefined;
        }
        members.add(member);
        return {
          detach: () =>
            enqueue(async () => {
              members.delete(member);
              if (members.size === 0) {
                lastApplied = undefined;
                localBinding = undefined;
                await runtime.reset();
              } else {
                refresh();
              }
            }),
          refreshNetwork: refresh,
        };
      }),
  };
}

const sharedByRuntime = new WeakMap<SrtRuntime, SrtSessionShared>();

export function srtSessionOf(runtime: SrtRuntime): SrtSessionShared {
  let shared = sharedByRuntime.get(runtime);
  if (shared === undefined) {
    shared = createSrtSessionShared(runtime);
    sharedByRuntime.set(runtime, shared);
  }
  return shared;
}
