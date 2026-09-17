// worker 桥协议（docs/PLUGIN-MANAGER.md §4）：main ⇄ worker 双向消息。
// 全部载荷结构化克隆安全（无函数/token 对象跨线程——token 以名字引用，双侧各自解析）。

export interface BootMessage {
  readonly t: "boot";
  readonly pluginPath: string; // 绝对路径（roots 校验后）
  readonly kernelApiVersion: number;
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

export interface ServiceResultMessage {
  readonly t: "svc-result"; // main → worker：svc-call 的应答
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export type MainToWorker = BootMessage | CallMessage | EmitInMessage | ShutdownMessage | ServiceResultMessage;

export type WorkerToMain =
  | ServiceCallMessage
  | { readonly t: "ready"; readonly pluginName: string; readonly apiVersion?: number }
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
  | { readonly t: "log"; readonly entry: unknown };
