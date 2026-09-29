import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";

const NOTES: Readonly<Record<string, string>> = {
  "agent_message":
    "Your agent_message was cut off mid-arguments and NOT delivered (your own view of the arguments renders as {}). Do not re-send it from memory. For long content: send it in shorter messages, or write it to a file and send a short message with the file path.",
  "agent_spawn":
    "The agent_spawn call was cut off and NOT executed. For a long task brief, write it to a file and pass a short prompt that references the file path.",
};

export function delegationRescueNote(): (
  payload: TruncatedToolPayload,
  next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>,
) => Promise<TruncatedToolDecision> {
  return async (payload, next) => {
    const downstream = await next(payload);
    if (downstream !== undefined) return downstream;
    if (payload.signal.aborted) return downstream;
    const note = NOTES[payload.name];
    return note === undefined ? downstream : { note };
  };
}
