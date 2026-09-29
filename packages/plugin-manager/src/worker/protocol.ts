export interface BootMessage {
  readonly t: "boot";
  readonly pluginPath: string;
  readonly kernelApiVersion: number;
}

export interface ProceedMessage {
  readonly t: "proceed";
}

export interface CallMessage {
  readonly t: "call";
  readonly id: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface EmitInMessage {
  readonly t: "emit";
  readonly token: string;
  readonly payload: unknown;
}

export interface ShutdownMessage {
  readonly t: "shutdown";
}

export interface ServiceCallMessage {
  readonly t: "svc-call";
  readonly id: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface ServiceWaitMessage {
  readonly t: "svc-wait";
  readonly id: number;
  readonly service: string;
}

export interface ServiceResultMessage {
  readonly t: "svc-result";
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
