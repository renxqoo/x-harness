# 首切片独立对抗审查

审查者：独立只读会话 llm_slice_review，实现者未代替审查者作结论。审查覆盖统一状态、HTTP/SSE、Chat、辅助迭代器、构建身份。下列问题均以回归或独立微复现闭合。

| 问题 | 处置与证据 |
| --- | --- |
| core 产物的定义 WeakMap 与源码分裂 | build 共享 definition-data 和 revocation-data；公共 contracts/storage 仅转发唯一源码 token。审查者验证 llm/llmRequest/session/sessionStorage 严格同一，src/dist 双向装配成功。fixtures/llm-built.test.ts 保留独立进程三协议旅程 |
| 请求总期限漏掉 describe | runModel 在任何异步准入前建立总控制，向 describe 传入 signal。review-regressions 的 slow describe 用例 |
| 错误 Result 的 hasOutput 与 error 事件不一致 | 所有终态后失败出口使用同一 enrichment。review-regressions 的 JSON/terminal consumer/incomplete-stop 三情形 |
| Chat refusal 被 stop 掩盖，误报 JSON 错误 | 映射 refusal 并保留 raw stop。chat-journey 的 stream/generate 成对回归 |
| 未启动迭代时取消，result 永不结算 | 创建时观察信号，预取消/后续取消均无网络且结算。review-regressions 双向取消 |
| 完成后的流句柄保留输入与服务引用 | 可清空 source cell；stream-retention.gc-case.ts 独立 Bun GC 进程，保留 stream 后验证两个 WeakRef 均释放 |
| 提前 incomplete 绕过正常结束校验 | finishStream 核对所有块状态，stop/tool-calls 不接受 incomplete。review-regressions 的 incomplete-stop |
| 异步 error 回调尚未结束就执行 finally | 失败出口 return await，阶段 timer 与清理归属保持到实际回调结束。review-regressions 的 slow error callback；审查者复测 timeout/consumer/hasOutput:true |

切片原四门：111 文件918例；覆盖语句91.61%、分支88.97%、函数97.54%、行97.87%。这只是首切片当时数字，完整交付数字见 acceptance.md。

审查者最终复核构建身份问题关闭，其余原问题已复核修复。部署边界是 Bun 完整包目录或应用整体打包，不能只复制 dist；不将此方案宣传为独立产物发布。
