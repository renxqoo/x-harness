// 帧中继热路径（DESIGN §9）：前缀分派零解析逐字转发（数据类响应按行首正则提取
// id/command——不 parse body）；hello 单调握手（不符 → spawning 失败回收：撤位 +
// pending 补 failure + 无 thread_died）；**控制响应的表更新先于转发**（fork 重键序）；
// settled 事件的 sendId 轻量提取（在飞驱动对账用）。
import { WORKER_BACKEND_ID, WORKER_PROTOCOL_VERSION } from "../protocol/internal.ts";
import { classifyResponseHead } from "../shared/frame-classify.ts";
import { INTERNAL_ID_PREFIX } from "../protocol/internal.ts";
import { isHubErrorShape, type HubErrorShape } from "../shared/errors.ts";

/** 表更新先于转发的控制命令集（响应携带路由事实） */
const CONTROL_COMMANDS = new Set(["thread/start", "thread/resume", "thread/stop", "fork", "clone"]);

const SETTLED_HEAD =
  /^\{"type":"event","threadId":"(?:[^"\\]|\\.)*","name":"settled","payload":\{"sendId":"((?:[^"\\]|\\.)*)"/;

/** 控制响应帧面（onControlResponse 单对象参——携带路由事实） */
export interface ControlFrame {
  command: string;
  id: string | undefined;
  data: unknown;
  error?: HubErrorShape;
}

export interface FrameRelayDeps {
  emitClient: (line: string) => void;
  /** hello 校验失败（版本/backend 不符）——spawning 失败回收路径 */
  onHelloRejected: (reason: string) => void;
  onHeartbeat: (beat: { idleMs: number; streaming: boolean; sessionPath: string | null; rssBytes: number | null }) => void;
  /** 每个响应帧（控制+数据）——池核销 pendingIds（恰一对账的数据源；success =
   *  受理对账判据：被拒驱动无 settled 义务） */
  onResponse: (id: string | undefined, success: boolean) => void;
  /** 控制响应：先改表再转发（返回 false = 不转发——例如内部 resume 应答） */
  onControlResponse: (frame: ControlFrame) => boolean;
  /** settled 事件对账（在飞驱动登记核销） */
  onSettled: (sendId: string) => void;
  onViolation: (reason: string) => void;
}

export interface FrameRelay {
  /** worker 行处理；返回 false = 该 worker 应被拒载（hello 不符） */
  ingest(line: string): boolean;
  helloSeen(): boolean;
}

export function createFrameRelay(deps: FrameRelayDeps): FrameRelay {
  let helloSeen = false;

  /** hello 握手段：首帧必须版本/backend 相符（不外发——内部握手帧） */
  function ingestHello(line: string): boolean {
    if (!line.startsWith('{"type":"hello"')) {
      deps.onViolation("first frame is not hello");
      return false;
    }
    try {
      const hello = JSON.parse(line) as { protocolVersion?: unknown; backendId?: unknown };
      if (hello.protocolVersion !== WORKER_PROTOCOL_VERSION || hello.backendId !== WORKER_BACKEND_ID) {
        deps.onHelloRejected(`hello mismatch: ${String(hello.protocolVersion)}/${String(hello.backendId)}`);
        return false;
      }
    } catch {
      deps.onViolation("hello unparseable");
      return false;
    }
    helloSeen = true;
    return true;
  }

  /** 心跳段：字段防御投影（坏行丢弃——下一拍补） */
  function ingestHeartbeat(line: string): boolean {
    try {
      const beat = JSON.parse(line) as { idleMs?: unknown; streaming?: unknown; sessionPath?: unknown; rssBytes?: unknown };
      deps.onHeartbeat({
        idleMs: typeof beat.idleMs === "number" ? beat.idleMs : 0,
        streaming: beat.streaming === true,
        sessionPath: typeof beat.sessionPath === "string" ? beat.sessionPath : null,
        rssBytes: typeof beat.rssBytes === "number" ? beat.rssBytes : null,
      });
    } catch {
      // 心跳坏行：丢弃（下一拍补）
    }
    return true;
  }

  /** 响应段：id/command 行首提取——控制面先改表再转发，数据面逐字透传 */
  function ingestResponse(line: string): boolean {
    const head = classifyResponseHead(line);
    if (head === undefined) {
      deps.onViolation("response head unclassifiable");
      return true; // 未分类行 parse 兜底（不杀——转发保守面）
    }
    deps.onResponse(head.id, head.success); // pending 核销（数据+控制同面——恰一对账）
    // internal 命名空间应答（host→worker 查询）：恒走控制面按 id 兑现等待者——
    // 数据面透传会把它发给客户端（垃圾帧）且等待表永不收口
    if (CONTROL_COMMANDS.has(head.command) || (head.id !== undefined && head.id.startsWith(INTERNAL_ID_PREFIX))) {
      let data: unknown;
      let error: HubErrorShape | undefined;
      try {
        const parsed = JSON.parse(line) as { data?: unknown; error?: unknown };
        data = parsed.data;
        if (isHubErrorShape(parsed.error)) error = parsed.error;
      } catch {
        data = undefined;
      }
      const forward = deps.onControlResponse({ command: head.command, id: head.id, data, ...(error !== undefined ? { error } : {}) });
      if (!forward) return true;
      deps.emitClient(line);
      return true;
    }
    deps.emitClient(line); // 数据类响应逐字透传（零解析热路径）
    return true;
  }

  /** 事件段：settled sendId 轻量提取（在飞驱动对账）后逐字转发 */
  function ingestEvent(line: string): boolean {
    const settled = SETTLED_HEAD.exec(line);
    if (settled !== null) deps.onSettled(JSON.parse(`"${settled[1]}"`) as string);
    deps.emitClient(line);
    return true;
  }

  return {
    helloSeen: () => helloSeen,
    ingest(line: string): boolean {
      if (!helloSeen) return ingestHello(line);
      if (line.startsWith('{"type":"heartbeat"')) return ingestHeartbeat(line);
      // 帧字面量 key 序契约：response 帧 id 在前（{"id":...,"type":"response"}），
      // 其余帧 type 在前——检测序按前缀分派
      if (line.startsWith('{"id":')) return ingestResponse(line);
      if (line.startsWith('{"type":"event"')) return ingestEvent(line);
      // ui_request / hub_error：逐字转发
      deps.emitClient(line);
      return true;
    },
  };
}
