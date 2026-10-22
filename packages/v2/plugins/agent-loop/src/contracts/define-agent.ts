import { defineService, defineChain, defineGuard, defineEvent } from "../../../../core/src/index";
import { validate } from "./validate";
import { createFault } from "../../../../core/src/validation";
import type {
  AgentLoopService,
  AgentContext,
  AgentCheckpoint,
  AgentAccess,
  AgentEvent,
  AgentModelRequest,
  AgentError,
} from "./types";
import { readError } from "../domain/read-error";
import { readRun } from "../domain/read-run";
import { readContext } from "../domain/read-context";
import { readModelRequest } from "../domain/read-model-request";
import { readCheckpoint } from "../domain/read-checkpoint";
import { readAccess } from "../domain/read-access";
import { readEvent } from "../domain/read-event";
const service = defineService<AgentLoopService>({
  name: "agent-loop",
  methods: { run: { output: validate(readRun), failure: validate(readError) } },
});

if (!service.ok) throw new Error("Invalid agent service");

export const agentLoop = service.value;
const context = defineChain<AgentContext, AgentModelRequest, AgentError>({
  name: "agent/context",
  input: validate(readContext),
  output: validate(readModelRequest),
});

if (!context.ok) throw new Error("Invalid agent context");

export const agentContext = context.value;
const checkpoint = defineChain<AgentCheckpoint, void, AgentError>({
  name: "agent/checkpoint",
  input: validate(readCheckpoint),
  output: (raw) =>
    raw === undefined ? { ok: true, value: undefined } : createFault("invalid-result"),
});

if (!checkpoint.ok) throw new Error("Invalid agent checkpoint");

export const agentCheckpoint = checkpoint.value;
const continuation = defineGuard<AgentCheckpoint>({
  name: "agent/continue",
  input: validate(readCheckpoint),
});

if (!continuation.ok) throw new Error("Invalid agent continuation");

export const agentContinue = continuation.value;
const access = defineGuard<AgentAccess>({ name: "agent/access", input: validate(readAccess) });

if (!access.ok) throw new Error("Invalid agent access");

export const agentRunAccess = access.value;
const event = defineEvent<AgentEvent>({ name: "agent/event", payload: validate(readEvent) });

if (!event.ok) throw new Error("Invalid agent event");

export const agentEvent = event.value;
