// bash 任务铸文共享（stop 回执与完成通知同源消费）：commandHead 码点安全截断 +
// 状态行（state/exit/bytes 一段式）。

const COMMAND_CAP = 80;

/** 码点安全截断（UTF-16 slice 会劈开代理对——emoji 命令不产生孤立代理项） */
export function commandHead(command: string): string {
  return [...command].length > COMMAND_CAP ? `${[...command].slice(0, COMMAND_CAP).join("")}…` : command;
}

function exitText(code: number | null): string {
  return code === null ? "null" : String(code);
}

/** 终态行：state/exit/bytes 一段式（stop 回执与 [task-notification] 首行同口径） */
export function stateLine(snap: { readonly id: string; readonly command: string; readonly state: string; readonly exitCode: number | null; readonly bytes: number }): string {
  return `task ${snap.id} (${commandHead(snap.command)}): ${snap.state} exit=${exitText(snap.exitCode)} bytes=${String(snap.bytes)}`;
}
