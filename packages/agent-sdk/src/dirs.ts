import { join } from "node:path";
import { userSkillsDirOf } from "@x-harness/skill";

export { userSkillsDirOf };

export function projectSkillsDirOf(cwd: string): string {
  return join(cwd, ".x-harness", "skills");
}

export function derivedMailboxRoot(agentDir: string): string {
  return join(agentDir, "mailbox");
}

export function derivedWorkflowRoot(agentDir: string): string {
  return join(agentDir, "workflow");
}

export function mailboxRootOf(options: { explicit?: string; agentDir: string }): string {
  if (options.explicit !== undefined && options.explicit !== "") return options.explicit;
  return derivedMailboxRoot(options.agentDir);
}

export function workflowRootOf(options: { explicit?: string; agentDir: string }): string {
  if (options.explicit !== undefined && options.explicit !== "") return options.explicit;
  return derivedWorkflowRoot(options.agentDir);
}
