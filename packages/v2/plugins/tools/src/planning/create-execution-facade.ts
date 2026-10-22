import type { Invocation } from "../../../../core/src/index";
import type {
  ExecutionTarget,
  ExecutionFacade,
  ExecutionService,
} from "../../../execution/src/index";

export function createExecutionFacade(call: Invocation, target: ExecutionTarget) {
  const cell: { current?: { call: Invocation; target: ExecutionTarget }; used: boolean } = {
    current: { call, target },
    used: false,
  };
  const facade: ExecutionFacade = Object.freeze({
    async run() {
      const current = cell.current;

      if (!current)
        return {
          ok: false as const,
          error: { source: "execution" as const, code: "closed" as const, message: "closed" },
        };

      if (cell.used)
        return {
          ok: false as const,
          error: {
            source: "execution" as const,
            code: "access-denied" as const,
            message: "access-denied",
          },
        };

      cell.used = true;
      const provider = current.call.deps.execution as ExecutionService | undefined;

      if (!provider)
        return {
          ok: false as const,
          error: {
            source: "execution" as const,
            code: "backend-unavailable" as const,
            message: "backend-unavailable",
          },
        };

      return provider.run({ target: current.target, signal: current.call.signal });
    },
  });
  return {
    facade,
    close() {
      cell.current = undefined;
    },
  };
}
