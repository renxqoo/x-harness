# LLM-REPETITION-GUARD：模型行内复读截流插件

状态：现行（独立插件，harness llmKit 默认装配，replay-guard 之后注册）
归属：挂 `@x-harness/llm` 的 root 层 `llm/stream` waterfall（replay-guard 下游——复读检测消费重放比对放行后的文本）。

## 1. 问题与方案

模型侧（实证：MiMo v2.6-pro）首 token 采样循环产生**同一小单元原地连抄**——实测形态
`DocsDocsDocsDocs`、`MyMyMyMyMy`、`注意`×16、`Doc`×~2000（100KB 烧穿 token，provider 以
`repetition_truncation` 自停）。与 replay-guard 的「上游断流从头重发」（docs/LLM-REPLAY-GUARD.md）
是两类故障：重放有帧间停顿、整文重发；复读无停顿、局部小单元循环，落在 replay-guard
文档写明的结构性盲区。轻度复读（×2~×6）由模型正常 stop 收尾直接落盘成脏文案；重度
失控复读烧穿 token 且依赖 provider 恰好自报错误（fail-open 归 `network`）才被重试救回——
那是运气不是机制。

检测器（`detect.ts`，纯函数面）：

| 档 | 规则 | 抓什么 |
| --- | --- | --- |
| 主闸 | 真周期 k∈[6,64] 且含字母/CJK，连续 >25 次 | 长语/短语级循环（`研究研究到底`×26） |
| 保险丝 | 真周期 k∈[2,5] 同资格，复读跨度 ≥100 字符 | 只防 token 烧穿（`Doc`×~2000 在 span 100 处截断） |

- **真周期判定**：候选单元内部存在更小重复子串（倍数别名，如 `注意注意注意`=真周期 2）
  时跳过该 k，交由最短周期档裁决——否则短单元高次重复会被 k=6 别名单元绕过保险丝跨度。
- **排除面**：纯标点/空白单元（markdown 分隔线 `---`、宽表 `|---|---|`）、纯数字单元
  （编号/补零填充）不具资格。
- **通道分域**：text / thinking 各自检测器实例——通道边界处 text 复述 thinking 结论是
  合法形态，不产生跨域假阳性。
- **pass-through 零扣留**：帧进帧出同 tick，不暂存不延迟，UI 打字机与流空闲看门狗无感；
  状态恒 ≤ 尾窗 1664 字符（`MAX_UNIT × LONG_UNIT_MIN_REPEATS`——主闸最长游程必在窗内），
  每 delta 一次 O(窗长) 比对。

命中后截流（关死上游迭代器），尾随 `finish{kind:"error", code:"repetition"}`——不发
任何可见文案。`repetition` 在 llm-retry 词表内（apps/cli RETRY_POLICY）：透明重拨，
预算 maxRetries=3，**与网络类共享同一 per-(session, provider, turn, step) 预算**——复读
三振即预算烧尽，step 以 error 终态失败（`assistant/attempt` + `llm/retry` 事件留审计轨迹，
失败 attempt 不进正文）。检测器每流实例（= 每 attempt）新建：strike 不跨 attempt/step/turn
携带，正常生成后预算自然重置。

## 2. 阈值依据（宁可漏不误判）

- k≥6 ×>25：6 字以上单元原地连抄 26 次在专业正文构造不出合法用例（叠词封顶 ×2、引用样例
  通常 ×2~×6 且 k<6）；阈值取 >25（用户裁决——极保守，主闸只拦确凿失控循环）；实测 13 例中
  k≤5 占 13/13——主闸实际是面向长语失控循环的深闸，轻度复读全数交给保险丝跨度制裁决。
- k<6 只看跨度 ≥100：`注意`×16（span 32）这类落盘脏文案**刻意放行**（观感污染，无实质
  伤害）；只拦 `Doc`×2000 级别的烧穿。短单元次数阈值是误杀主向量（`哈哈`×6 合法），跨度制
  把它压到 20~50 次。
- **盲区（结构性放弃，如实记录）**：真周期 >64 的整段循环（provider 截断与看门狗兜底）；
  k<6 且 span<100 的轻度复读（落盘观感问题，可容忍）；流中段起始的复读循环（首 token
  采样循环必在通道起点，中段重复多为合法修辞）。

## 3. 与相邻件的互序

- **replay-guard 上游**：注册序在后 = 链上更靠消费端。replay-guard HOLD 期零宽保活帧
  （`text-delta {text:""}`）到达检测器时空串跳过，不参与游程。
- **llm-retry 下游**：`repetition` code 进 `DEFAULT_RETRYABLE_CODES` 之外的 CLI 显式词表
  （RETRY_POLICY.retryableCodes）——库缺省词表不含 repetition（未装本插件的部署不产生
  该 code，语义自洽）。
- **agent-continuation 无关**：复读的 partial 是垃圾，语义是「丢弃重生成」（retry）而非
  「保留续写」（continuation）——不走 OUTPUT-TOKEN-CONTINUATION 通道。

## 4. 测试口径（`src/__test__/`）

`detect.test.ts`：两档触发全位（主闸阈值位 k=6×26、保险丝交接带 Clean×20=span 100）、
排除面（分隔线/宽表/纯数字/合法长文）、真周期判定（最短周期取真单元、倍数别名收归、
k>64 结构性放弃）、流式边界（跨帧切开仍命中、空 delta 跳过、尾窗裁剪不丢游程、attempt
归零）。`plugin.test.ts`：pass-through 帧序不变、命中截流恰一个 error finish 且后续帧
不漏、通道分域、toolcall/usage 直通、插件全链（waterfall 装配）、disabled 直通。
症状命名：模型行内复读致文案前缀重复/烧穿 token（session 20260924T182924-f0ml9e 实测）。
