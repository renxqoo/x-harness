const COMMAND_CAP = 80;

export function commandHead(command: string): string {
  return [...command].length > COMMAND_CAP ? `${[...command].slice(0, COMMAND_CAP).join("")}…` : command;
}

function exitText(code: number | null): string {
  return code === null ? "null" : String(code);
}

export function stateLine(snap: { readonly id: string; readonly command: string; readonly state: string; readonly exitCode: number | null; readonly bytes: number }): string {
  return `task ${snap.id} (${commandHead(snap.command)}): ${snap.state} exit=${exitText(snap.exitCode)} bytes=${String(snap.bytes)}`;
}
