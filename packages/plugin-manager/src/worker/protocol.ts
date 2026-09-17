// worker 桥协议（docs/PLUGIN-MANAGER.md §4）：main ⇄ worker 双向消息。
// 全部载荷结构化克隆安全（无函数/token 对象跨线程——token 以名字引用，双侧各自解析）。
// 三段式装载（审查 #1/#7/#16 修复）：boot → ready（模块已载、名字已知、apply 未跑）→
// proceed（main 完成同名锁与 replace 卸载后才放行）→ apply-done/apply-error。

export interface BootMessage {
  readonly t: "boot";
  readonly pluginPath: string; // 绝对路径（roots 校验后）
  readonly kernelApiVersion: number;
}

export interface ProceedMessage {
  readonly t: "proceed"; // main → worker：放行 apply
}

export interface CallMessage {
  readonly t: "call"; // main → worker：调用 worker 插件提供的服务方法
  readonly id: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface EmitInMessage {
  readonly t: "emit"; // main → worker：向 worker 插件的监听器投递事件
  readonly token: string;
  readonly payload: unknown;
}

export interface ShutdownMessage {
  readonly t: "shutdown";
}

export interface ServiceCallMessage {
  readonly t: "svc-call"; // worker → main：插件使用平台服务（反向 RPC）
  readonly id: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface ServiceWaitMessage {
  readonly t: "svc-wait"; // worker → main：停靠等待平台服务出现（waitFor 桥，审查 #10）
  readonly id: number;
  readonly service: string;
}

export interface ServiceResultMessage {
  readonly t: "svc-result"; // main → worker：svc-call/svc-wait 的应答
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export type MainToWorker =
  | BootMessage
  | ProceedMessage
  | CallMessage
  | EmitInMessage
  | ShutdownMessage
  | ServiceResultMessage;

export type WorkerToMain =
  | ServiceCallMessage
  | ServiceWaitMessage
  | { readonly t: "ready"; readonly pluginName: string; readonly apiVersion?: number;
      readonly inject: readonly string[] }
  | { readonly t: "shutdown-ack" }
  | { readonly t: "provided"; readonly service: string }
  | { readonly t: "listening"; readonly token: string; readonly mode: string }
  | {
      readonly t: "call-result";
      readonly id: number;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
    }
  | { readonly t: "heard"; readonly token: string; readonly payload: unknown }
  | { readonly t: "apply-done" }
  | { readonly t: "apply-error"; readonly error: string }
  | { readonly t: "log"; readonly entry: { readonly where: string; readonly message: string } };
