import type { Disposer } from "@x-harness/core";
import type { SystemPromptService } from "@x-harness/system-prompt";

export function registerAppendSections(prompt: SystemPromptService, appends: readonly string[]): Disposer {
  const offs: Disposer[] = [];
  let anchor: string | undefined;
  for (let index = 0; index < appends.length; index += 1) {
    const name = `cli-user-${index}`;
    offs.push(prompt.section({ name, ...(anchor !== undefined ? { after: anchor } : {}), text: appends[index] ?? "" }));
    anchor = name;
  }
  return () => {
    for (const off of offs) off();
  };
}
