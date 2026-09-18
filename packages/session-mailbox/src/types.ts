// 本机跨进程邮箱契约类型（docs/AGENT-DELEGATION.md §5.3）：文件协议、判活、订阅。

/** 时间与钟全部可注入——liveness/回收/心跳用例不真 sleep（方案 §2.2/§11.2） */
export interface MailboxTiming {
  /** 收方 drain 轮询间隔（消费者读） */
  readonly pollIntervalMs: number;
  /** manifest 心跳间隔 */
  readonly heartbeatMs: number;
  /** 判活宽限：updatedTs 距今超过该值且 pid 死 → 不活 */
  readonly graceMs: number;
  /** 陈尸阈值：判回收的最低年龄 */
  readonly staleMs: number;
  readonly now: () => number;
}

export type EnvelopeKind = "message" | "idle-notice" | "idle-expired";

/** 跨进程信封（无 summary——不传输，方案 §2.1 裁决） */
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
  /** 12 hex 随机；[ref] = 尾 6 hex */
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
  /** agentStatus 边沿即时重写（不等心跳） */
  setStatus(status: "running" | "idle"): Promise<void>;
  /** 心跳单拍：touch updatedTs（保留 status） */
  beat(): Promise<void>;
  /** 周期心跳（unref 定时器）；返回停止函数 */
  startHeartbeat(): () => void;
  /** 关箱：删本 box 目录（subs 结算是消费者职责，先于 close——方案 §5.3 dispose 序列） */
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
  /** 开箱：EEXIST → 死箱认领（清 inbox/subs 残留）；活箱真重名 throw（装配期 fail-fast） */
  open(name: string): Promise<BoxHandle>;
  /** 投递：tmp→rename 原子发布；目标判活，死 → not-live */
  send(to: string, body: { readonly from: string; readonly message: string; readonly kind: EnvelopeKind }): Promise<SendResult>;
  /** 抢占式排空：rename .proc 单读者保证；坏信封丢弃（onWarn）——at-most-once 语义 */
  drain(name: string): Promise<readonly Envelope[]>;
  /** 活箱发现（陈尸惰性回收在内） */
  discover(): Promise<readonly LiveBox[]>;
  /** 陈尸回收：墓碑两步 + subs 结算 idle-expired（best effort） */
  reclaim(name: string, hooks?: { readonly afterTombstone?: (tombPath: string) => Promise<void> }): Promise<void>;
  readonly subs: {
    /** 订阅者向目标 box 写一次性订阅（原子重写，同 from 覆盖） */
    add(targetBox: string, fromBox: string): Promise<void>;
    /** 目标自查订阅方清单 */
    list(box: string): Promise<readonly string[]>;
    /** 结算后摘除（一次性） */
    remove(box: string, fromBox: string): Promise<void>;
  };
}

export interface MailboxOptions {
  readonly root: string;
  readonly timing: MailboxTiming;
  /** 坏信封丢弃等非致命异常的告警出口（缺省 noop） */
  readonly onWarn?: (message: string) => void;
}
