export interface MailboxTiming {
  readonly pollIntervalMs: number;
  readonly heartbeatMs: number;
  readonly graceMs: number;
  readonly staleMs: number;
  readonly now: () => number;
}

export type EnvelopeKind = "message" | "idle-notice" | "idle-expired";

export interface Envelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly ts: number;
  readonly kind: EnvelopeKind;
}

export interface BoxManifest {
  readonly pid: number;
  readonly bootId: string;
  readonly status: "running" | "idle";
  readonly updatedTs: number;
}

export interface LiveBox {
  readonly name: string;
  readonly ref: string;
  readonly status: "running" | "idle";
}

export interface BoxHandle {
  readonly name: string;
  readonly bootId: string;
  readonly ref: string;
  setStatus(status: "running" | "idle"): Promise<void>;
  beat(): Promise<void>;
  startHeartbeat(): () => void;
  close(): Promise<void>;
}

export interface SendResult {
  readonly id?: string;
  readonly reason?: string;
  readonly ok: boolean;
}

export interface MailboxService {
  readonly root: string;
  readonly timing: MailboxTiming;
  open(name: string): Promise<BoxHandle>;
  send(to: string, body: { readonly from: string; readonly message: string; readonly kind: EnvelopeKind }): Promise<SendResult>;
  drain(name: string): Promise<readonly Envelope[]>;
  discover(): Promise<readonly LiveBox[]>;
  reclaim(name: string, hooks?: { readonly afterTombstone?: (tombPath: string) => Promise<void> }): Promise<void>;
  readonly subs: {
    add(targetBox: string, fromBox: string): Promise<void>;
    list(box: string): Promise<readonly string[]>;
    remove(box: string, fromBox: string): Promise<void>;
  };
}

export interface MailboxOptions {
  readonly root: string;
  readonly timing: MailboxTiming;
  readonly onWarn?: (message: string) => void;
}
