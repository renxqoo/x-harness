# 03 · 契约包 `@x-harness/hub-protocol`

> 上级：[../HUB-CLIENT-DESIGN.md](../HUB-CLIENT-DESIGN.md)；架构不变量：[02 §1](02-architecture.md)

## 1. 包形状

```
packages/hub-protocol/
  package.json        # name @x-harness/hub-protocol, exports {".": "./src/index.ts"}, 无 dependencies
  src/
    index.ts          # 出口（全量导出，对齐 remote-protocol 惯例）
    errors.ts         # HUB_ERROR_CODES(26) / HubErrorShape / hubError / isHubErrorShape / CodedError / errorOfCause
    frames.ts         # 七个帧构建器 + SettledEvent/BashExecutionUpdate + parse 后判别联合类型（§3）
    frame-classify.ts # classifyResponseHead / responseLine / classifyHostLine / HostFrameKind
    commands.ts       # COMMAND_NAMES 封闭集 + 入参形状 + isKnownCommand
    command-domains.ts# INTERNAL_ID_PREFIX / 四集合 / isThreadScoped / isInternalId（HelloFrame 等留 host-hub）
    images.ts         # WireImage（commands.ts 依赖，随迁）
    jsonl.ts          # createJsonlSplitter
    line-limit.ts     # CLIENT_LINE_LIMIT = 16MiB
    catalog-types.ts  # CatalogEntry/HubModelMeta/…（get_models 响应类型消费面；随迁理由 §2.10）
    __test__/         # 封闭性 + 边界测试（§5）
```

零 @x-harness 依赖（I1）；测试同目录 `__test__/`（工程惯例）；文件名 kebab-case
（oxlint unicorn/filename-case）。

## 2. 移动清单（移动非复制——host-hub 原件删除、导入翻转）

| # | 现位置（apps/host-hub/src） | 去向（packages/hub-protocol/src） | 动作 |
|---|---|---|---|
| 2.1 | `shared/errors.ts` | `errors.ts` | 整文件移动；host-hub 导入翻转 |
| 2.2 | `shared/frame-classify.ts` | `frame-classify.ts` | 移动 + 增补 classifyHostLine（§4，吸收 gateway fanout 镜像） |
| 2.3 | `protocol/frames.ts` | `frames.ts` | 移动 + 增补 parse 后类型（§3） |
| 2.4 | `protocol/commands.ts` | `commands.ts` | 移动（含 images.ts 依赖随迁） |
| 2.5 | `protocol/internal.ts` | `command-domains.ts` | **拆分移动**：客户端可见面迁出；HelloFrame/WorkerHeartbeat/WORKER_PROTOCOL_VERSION/WORKER_BACKEND_ID/LIVE_ONLY_COMMANDS/isLiveOnly 留 host-hub（host↔worker 私有 + host 路由门私有） |
| 2.6 | `shared/jsonl.ts` | `jsonl.ts` | 整文件移动（client↔host 双侧同源） |
| 2.7 | `shared/limits.ts` 的 `CLIENT_LINE_LIMIT` | `line-limit.ts` | **拆分**：仅该常量迁出；limits.ts 其余（HubLimits/readLimits/clamp 等 host 容量语义）留 host-hub，反向 import hub-protocol |
| 2.8 | `shared/catalog-types.ts` | `catalog-types.ts` | 移动：纯类型、零依赖、被 get_models 响应类型与 hub-client CommandResponses 消费；host-hub 导入翻转 |
| 2.9 | gateway `fanout.ts` 的 classifyHostLine + HostFrameKind | （并入 2.2 frame-classify.ts） | **删除镜像**：gateway 改 import hub-protocol；fanout.ts 其余（Fanout 类）不动（D6） |

拆分边界原则：**客户端可见的协议事实全部进包**；host 进程内部门派语义（worker 握手、
live-only 路由门、容量旋钮）留 host-hub。LIVE_ONLY_COMMANDS 是否随迁的判据：它只被
host 路由消费（`worker-pool.ts:1`），客户端无需感知——留 host-hub，但命令名本身在
COMMAND_NAMES 词表内（词表完整性不受影响）。

## 3. 增补类型（frames.ts；构建器已有、parse 后类型未有）

```ts
export type HostResponse =
  | { type: "response"; id?: string; command: string; success: true; data?: unknown }
  | { type: "response"; id?: string; command: string; success: false; error: HubErrorShape };

export interface HostEvent { type: "event"; threadId: string; name: string; payload: unknown; agentName?: string }
export interface HostUiRequest { type: "ui_request"; requestId: string; threadId: string; method: string; payload: Record<string, unknown> }
export interface HostHeartbeat { type: "heartbeat"; rssBytes: number | null; cpuPercent: number }
export interface HostHubError { type: "hub_error"; message: string; threadId?: string }
export interface HostThreadDied { type: "thread_died"; threadId: string; reason: string }
export interface HostThreadParked { type: "thread_parked"; threadId: string; reason: "idle" | "manual" | "rss" }
```

类型是**标注不是验证**：这些接口描述 parse 成功后的形状；运行时守卫只有
classifyHostLine 的前缀分类（字节级事实），parse 失败按 unknown 降级。

## 4. 增补 classifyHostLine（吸收 gateway 镜像）

```ts
export type HostFrameKind = "response" | "event" | "ui_request" | "heartbeat"
  | "hub_error" | "thread_died" | "thread_parked" | "unknown";

export function classifyHostLine(line: string): HostFrameKind;
```

语义 = gateway fanout.ts:6 现行为（前缀分类，response 双前缀兼容 id-first 与
type-first），**逐字节等价迁移**（先例纪律：机械等价与优化分波——迁移波不加语义）。
与 classifyResponseHead 的分工：classifyHostLine 是粗分类（八值），classifyResponseHead
是 response 头部解析（id/command/success 提取）——两者并存，key 序对拍测试钉住
response 恒 id-first。

## 5. 封闭性门禁（`__test__`，从 host-hub contracts 迁移并扩容）

- C1 词表封闭：COMMAND_NAMES 无重复；四集合 ⊆ 词表；驱动 ⊂ 线程域；观察者 ⊂ 线程域
  ∪ 转发白名单；转发白名单 ∩ 线程域 = ∅（迁移 contracts-frames.test.ts:30-46）；
- C2 词表数字：断言**唯一锚点**迁入本包（host-hub 侧 smoke.test.ts:85 与
  contracts-frames.test.ts:41 的数字断言随之删除——同一事实一处断言）；
- C3 错误码表：26 项无重复；isHubErrorShape 对全部码真、对垃圾假；
- C4 key 序对拍：classifyResponseHead ↔ responseLine 往返（含 id 转义字符、无 id
  parse-failure 形态）；classifyHostLine 对七帧构建器产物全类正确；
- C5 jsonl 边界：跨 chunk 多字节、\r 容忍、超限恰报一次、空行、flush 残留；
- C6 预算钉子：CLIENT_LINE_LIMIT === 16 * 1024 * 1024（改动需过文档 §02-B3）。

## 6. 契约演进流程（新增命令/错误码/帧的唯一登记处）

```
host-hub 处理器 → hub-protocol COMMAND_NAMES + 入参形状（同一提交）
              → （可选）hub-client CommandResponses 标注
删除同理反向。封闭性测试是唯一门禁，无别的登记处。
```

新增帧类型：hub-protocol 构建器 + 类型 + classifyHostLine 分支 + C4 对拍，同一提交。
错误码扩项：errors.ts + C3，并同步消费端按语义分类（[05 §4](05-observability.md)）。
