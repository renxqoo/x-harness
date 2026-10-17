# LLM 行为审计

状态：设计盘点，未核销。现有源码用于发现能力与事故经验，不构成必须复制的实现规格。每项实施后补实际测试文件/场景，不以本表代替测试结果。

| 现有来源与行为 | 裁决及归属 |
| --- | --- |
| runtime：注册、重名、注销身份保护、hasAdapter独立于contextWindow | 保留能力；提供者用core服务token和依赖装配，登记事实由core管理，能力未知不等于未安装 |
| runtime：单provider猜默认、多provider歧义 | 改为显式defaultProvider或请求指定，缺失/错误明确Result，不依赖Map数量隐式选择 |
| runtime：provider/model上下文窗口查表与回落 | 保留显式配置优先级；describe返回已知信息，删除200000等无来源兜底 |
| runtime：同步/异步错误归一、abort裸throw | 统一Result；core取消保持原协议，领域网络错误分类不丢原始状态，取消不用业务throw |
| runtime：中间件包装AsyncIterable、break委托return | 保留扩展与早退；整条流在受管请求内执行，辅助迭代器发取消并维持背压 |
| adapter：真实OpenAI Chat及Anthropic，fetch注入/认证/协议头 | 保留并增加Responses；传输与协议分层，密钥仅配置，拒绝认证重定向，真实HTTP替身验证 |
| adapter：maxRetries=0、maxTokens请求>模型配置>档案配置、temperature | 保留单次尝试与显式优先级；Anthropic必需参数缺失明确错误，不猜上限 |
| adapter：thinking等级固定budget、默认模型input=text、developer角色关掉 | 改为显式模型能力/协议策略；不全局猜等级，不将图片或developer静默丢弃 |
| adapter：Retry-After秒/日期/毫秒 | 保留有界解析、确定时钟及错误提示；重试编排归策略插件 |
| pi-events：text/thinking首字重复事故、可变partial引用、末尾补齐 | 保留不重复与快照不变性；基于原生有序增量与明确完整尾值，不猜首尾重叠 |
| pi-events：工具参数在toolcall_end单帧吐出、截断工具缺失end补偿 | 改为真实参数增量+明确块终态；不完整参数保留raw，不合成可执行对象 |
| pi-events：思考签名、跨模型来源、redacted占位文本 | 保留签名与来源；opaque原文独立保留，不生成用户可见占位来冒充模型内容 |
| pi-context：tool-use JSON parse失败变{}、ensureToolPairing删除孤儿调用/结果 | 不保留静默修补；请求非法配对返回invalid-input，模型非法输入标不可执行，修复业务由agent-loop/tool-orch决定 |
| pi-context：拼接system、转换图片与工具schema/结果 | 保留语义；独立请求角色与图片source联合，协议不支持时显式拒绝，不依赖Session类型 |
| pi-events：usage输入加cache、全0不发、cost默认0 | 统一累计总量及明细，0与未知分开，缺失不捏造；计价归独立用量插件 |
| pi-events：tool-use折stop、unknown reason折network、length零output猜overflow | 分离tool-calls/length/context/pause/refusal/filter/other，原始结束词保留，不靠输出量猜语义 |
| pi-events：流内错误、状态码、overflow文案、EOF无finish | 保留异常可观察性；结构化码/状态优先，未知EOF为协议中断，429不会因tokens文案被当作上下文溢出 |
| pi-wire/scene-server：真实HTTP、认证头、参数、usage尾帧、错误、retry头 | 保留可观察行为，重写本包装置并扩三协议/分片/取消/真实关闭；不复制旧测试的私有依赖 |
| Session消息与工具runtime作为LLM编译依赖 | 不保留耦合；llm拥有模型调用契约，agent-loop负责领域映射，tool-orch负责校验/执行 |
| 外部llm-retry / replay-guard / repetition-guard / compaction | 职责仍独立；请求扩展链提供接入面，不在基础LLM默认重试、回放、修改上下文或压缩 |

盘点入口：packages/llm/src/{runtime,pi-adapter,pi-events,pi-context,types}.ts及同目录__test__全部七个测试文件。已核对外部llm-retry的agentRequestError/Session依赖、replay/repetition的llmStream包装，以及token-meter/token-analytics的会话用量和上下文窗口消费；这些调用关系不能偷放回基础LLM。新规格增加Responses、完整块身份、规范终态、背压与预算，详见[设计](DESIGN.md)和[验证](VERIFICATION.md)。
