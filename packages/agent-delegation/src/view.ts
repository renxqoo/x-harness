import { defineService } from "@x-harness/core";
import type { ChildView } from "./types.ts";
import type { MessageInput, VerbOutcome } from "./verbs.ts";
import type { SessionId } from "@x-harness/session";
import type { SettlementSink } from "./tokens.ts";
import type { SpawnInput, SpawnOutcome } from "./spawn.ts";
import type { ReviveOutcome } from "./revive.ts";

export interface DelegationView {
  list(caller: SessionId | undefined): Promise<readonly ChildView[]>;
  message(caller: SessionId | undefined, input: MessageInput): Promise<VerbOutcome>;
  stopAll(caller: SessionId | undefined, cause: string): Promise<void>;
  rebindMailbox(next: SessionId): Promise<{ ok: true } | { ok: false; reason: string }>;
  spawnManaged(caller: SessionId, input: Omit<SpawnInput, "description"> & { readonly description: string }): Promise<SpawnOutcome>;
  reviveManaged(caller: SessionId, agentId: string, settlement?: SettlementSink): Promise<ReviveOutcome>;
  settle(agentId: string, cause: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export const delegationView = defineService<DelegationView>("delegation/view");
