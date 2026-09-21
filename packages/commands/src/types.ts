// 命令契约类型（BATCH3-DESIGN §2.1）：注册定义 / 执行调用 / 判别结果 / 目录描述符。
// 命令 = 机器拦截的斜杠动词（区别于 skill 的模型分发面——两者共用 `/` 命名空间，
// 命令目录统一可见性）。

/** 命令执行调用（registry 铸 pairing id 后交 handler） */
export interface CommandInvocation {
  /** 本执行的 `command/run`/`command/done` 配对 id */
  readonly commandId: string;
  /** 目标会话（handler 读写会话的单一入口） */
  readonly session: import("@x-harness/session").Session;
  /** 词后原文逐字（含分隔空白——消费方自行裁剪） */
  readonly rawInput: string;
  /** 调用方持有的取消信号（hub 侧 = inflight 登记面） */
  readonly signal: AbortSignal;
}

/** 命令结果：期望失败走 error 返回值（不抛）；实现 bug 走 throw（registry 落
 *  done{error} 后重抛）。data = 结构化载荷（消费方在进程内——直接携带富载荷，
 *  wire 形状零折平） */
export type CommandResult =
  | { readonly kind: "success"; readonly text?: string; readonly data?: unknown }
  | { readonly kind: "error"; readonly text: string };

/** 一次落定的执行：配对 id + 归一结果 */
export interface CommandExecution {
  readonly commandId: string;
  readonly result: CommandResult;
}

/** 注册定义（name 词形见 lexer；description 非空——目录可见性） */
export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  /** 缺省 true；false = 领域事件自持载荷，command/run 不记 args（反双写） */
  readonly recordInput?: boolean;
  execute(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
}

/** 目录描述符（handler-free——get_commands 消费） */
export interface CommandDescriptor {
  readonly name: string;
  readonly description: string;
}

/** 词法解析产物 */
export interface ParsedCommand {
  readonly name: string;
  readonly rawInput: string;
}
