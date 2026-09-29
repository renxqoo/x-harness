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
    commands.ts       # COMMAND_NAMES 封闭集 + CommandName 联合（as const 词表派生——call() 编译期拼写防护）+ 键控入参映射 InputOf<K>（命令名→入参形状；hub-client CommandArgs 的投影源，随词表同提交——args 镜像由 C7 拦）
    // isKnownCommand 全仓零消费方——迁移时在 host-hub 侧删除，不进契约包
    command-domains.ts # INTERNAL_ID_PREFIX / THREAD_SCOPED·HOST_RELAYED·DRIVING 三集合 / isThreadScoped / isInternalId（OBSERVER 与 HelloFrame 等留 host-hub，§2.5）
    images.ts         # WireImage（commands.ts 依赖，随迁）
    jsonl.ts          # createJsonlSplitter
    line-limit.ts     # CLIENT_LINE_LIMIT = 16MiB + HOST_SHUTDOWN_BUDGET_CEILING = 40_000（host 优雅停机总预算上限契约：host-hub 测试断言 shutdownAll 实际预算 ≤ 它；hub-client kill/close 宽限缺省 = 它 + 5s 余量——跨 app 推导链的机械钉子，改一处两端测试齐红。**前提**：CEILING 对缺省 limits 成立——workerExitTimeoutMs 是 env 可调（HUB_WORKER_EXIT_TIMEOUT_MS），运维调大时须同步评估宽限（README 披露））
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
| 2.4 | `protocol/commands.ts` | `commands.ts` | 移动（WireImage 类型随迁为 commands.ts 内联或独立 images 类型文件——**仅类型**；`shared/images.ts` 的运行时函数 normalizeImages 与其 PROMPT_* 常量依赖**留 host-hub**（消费方 worker-commands.ts:14，limits 依赖闭环在 host 内），不随迁） |
| 2.5 | `protocol/internal.ts` | `command-domains.ts` | **拆分移动**：客户端可见面（THREAD_SCOPED/HOST_RELAYED/DRIVING 三集合 + INTERNAL_ID_PREFIX）迁出；OBSERVER_COMMANDS/HelloFrame/WorkerHeartbeat/WORKER_PROTOCOL_VERSION/WORKER_BACKEND_ID/LIVE_ONLY_COMMANDS/isLiveOnly 留 host-hub（host↔worker 私有语义——OBSERVER 的消费方是 worker.ts:202 idle 重置，与 LIVE_ONLY 同判据）；封闭性测试 C1 对 OBSERVER 的断言改在 host-hub 侧测（hub-protocol 不持它则不断它——两包各自断自己持有的集合） |
| 2.6 | `shared/jsonl.ts` | `jsonl.ts` | 整文件移动（client↔host 双侧同源） |
| 2.7 | `shared/limits.ts` 的 `CLIENT_LINE_LIMIT` | `line-limit.ts` | **拆分**：仅该常量迁出（唯一消费方 host.ts:3；limits.ts 残余无该常量消费方——不产生反向依赖边）；limits.ts 其余（HubLimits/readLimits/clamp 等 host 容量语义）留 host-hub |
| 2.8 | `shared/catalog-types.ts` | `catalog-types.ts` | **不迁**（裁决修正）：纯类型零依赖没错，但其消费方全在 host-hub 内部（catalog.ts/worker-catalog.ts/presets.ts/models-admin.ts），get_models 响应形状（modelShapeOf 输出）与 CatalogEntry 是两回事——留在 host-hub，hub-client 的 get_models 标注在 05 §5 独立定义 |
| 2.9 | gateway `fanout.ts` 的 classifyHostLine + HostFrameKind | （并入 2.2 frame-classify.ts） | **删除镜像**：gateway 改 import hub-protocol（两个翻转点：fanout.ts:6 与 host-ingest.ts:1——后者现从 fanout 转引，镜像删除后改直引 hub-protocol）；fanout.ts/host-attach.ts 其余不动（D6）。

拆分边界原则：**客户端可见的协议事实全部进包**；host 进程内部门派语义（worker 握手、
live-only 路由门、容量旋钮）留 host-hub。LIVE_ONLY_COMMANDS 是否随迁的判据：它只被
host 路由消费（`worker-pool.ts:1`），客户端无需感知——留 host-hub，但命令名本身在
COMMAND_NAMES 词表内（词表完整性不受影响）。

## 3. 增补类型（frames.ts；构建器已有、parse 后类型未有）

```ts
export type HostResponse =
  | { type: "response"; id?: string | null; command: string; success: true; data?: unknown }
  | { type: "response"; id?: string | null; command: string; success: false; error: HubErrorShape };
// id 口径：wire 上无 id 帧恒写 "id":null（frame-classify.ts:31）——parse 后 null 非 undefined

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

- C1 词表封闭：COMMAND_NAMES 无重复；THREAD_SCOPED/HOST_RELAYED/DRIVING ⊆ 词表；驱动 ⊂ 线程域；转发白名单 ∩ 线程域 = ∅（迁移 contracts-frames.test.ts:30-46；
  OBSERVER 相关断言不迁——承接指定：host-hub contracts-frames 保留
  「OBSERVER ⊆ THREAD_SCOPED ∪ HOST_RELAYED」断言（import hub-protocol
  两集合，跨包测试 import 可行——真实先例：skills-install/coverage-final/contracts-queue 的 @x-harness/* import））；
- C2 词表数字：断言**唯一锚点**迁入本包（host-hub 侧 smoke.test.ts:85 与
  contracts-frames.test.ts:41 的数字断言随之删除——同一事实一处断言）；
- C3 错误码表：26 项无重复；isHubErrorShape 对全部码真、对垃圾假；
- C4 key 序对拍：classifyResponseHead ↔ responseLine 往返（含 id 转义字符、无 id
  parse-failure 形态）+ 全字面量锚（responseLine 产物与逐字节字符串 toBe 对拍——往返对拍在构建器与正则同提交同漂移时仍绿，全字面量是唯一抓得住的钉子）；非 response 帧头不识别（event/heartbeat →
  undefined，防正则过匹配）；classifyHostLine 对七帧构建器产物全类正确；
  迁移纪律与 gateway 同标：host-hub contracts-frames/jsonl 用例逐用例对照清单+数量核销（本条自持规则，gateway 侧同款住 07 §4）；
- C5 jsonl 边界（九用例全集对齐 jsonl.test.ts）：跨 chunk 多字节、\r 容忍、超限恰报
  一次、空行、flush 残留、U+2028/U+2029 不切行、粘包半行跨 feed 重组、字节真值
  上限按字节计（多字节字符）、flush 超限尾行丢弃；**映射核销**：迁入用例与 jsonl.test.ts 现存九用例逐一对
  照（现存无「跨 chunk 多字节」向量——新增迁移时标注，非冒充现存；「多行一次
  feed」不缺席）；
- C6 预算钉子：CLIENT_LINE_LIMIT === 16 * 1024 * 1024（改动需过 02 §6-B3 预算）。
- C7 词表类型封闭：CommandName 联合与 COMMAND_NAMES 逐元素等价（as const 派生的
  编译期保证 + 运行时断言双钉）；**hub-client 侧对应门禁**（住 hub-client __test__）：
  CommandResponses/CommandArgs/CommandTimeouts 的键 ⊆ CommandName——标注键与
  词表漂移（host 改名后幽灵标注）编译期即红；
- C8 收编预算钉子：HOST_SHUTDOWN_BUDGET_CEILING ≥ host-hub 侧 shutdownAll
  实际总预算（host-hub 测试断言，用其 limits 计算值对拍——两端常量漂移即红）。

## 6. 契约演进流程（新增命令/错误码/帧的唯一登记处）

host-hub 处理器 → hub-protocol COMMAND_NAMES + 入参形状（同一提交）
              → （按需）hub-client CommandResponses 标注 / CommandTimeouts 缺省 /
                 05 §6 超时映射清单（长耗时命令必进，漏登代价由消费端统一支付）
删除同理反向。**登记面全清单**：命令/错误码/帧/stats 字段（含守恒断言更新）/
log 词表/超时缺省——五面都在此登记，封闭性测试是唯一门禁。
**跨 app 常量联动**：host-hub limits.ts 改 workerExitTimeout/shutdown 预算 →
HOST_SHUTDOWN_BUDGET_CEILING 同步（hub-protocol 测试 + host-hub 测试双端钉住）。
**host-private 命令的逃生门**：COMMAND_NAMES 全量客户端可见是当前事实的固化；
未来 host 内部命令不该发布进 SDK 词表时，路径 = 词表加 host-private 扩展位
（如 HOST_PRIVATE_COMMANDS 集合住 host-hub、路由层先查它）——现在不实现，但
登记为演进方向，防「没有」被固化成「永远不许有」。
**词表↔处理器双向一致性**（封闭性测试管不住的面，host-hub 侧断言承接）：
host handlers ⊆ COMMAND_NAMES（防处理器漏登词表）+ 线程域命令 ⊆ THREAD_SCOPED
（防漏登集合——漏登时 host 回 unknown_command，矩阵回显测试不红；归
audit-fixes 全命令矩阵扩容，阶段一随迁）。**实施前提**：handlers 注册表是
createHostCommands 闭包私有——「handlers ⊆ 词表」方向需 host-hub 阶段一
同批导出注册表键（测试缝），否则该半断言写不出来（08 阶段一清单已含）。
**ScriptStep 同步项**：装置副本随 host 侧 script-adapter 变体演进同提交更新
（08 §2 裁决的代价登记）。

新增帧类型：hub-protocol 构建器 + 类型 + classifyHostLine 分支 + C4 对拍，同一提交。
错误码扩项：errors.ts + C3，并同步消费端按语义分类（[05 §2](05-observability.md) stats 口径）。
