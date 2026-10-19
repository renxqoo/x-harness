# Agent loop 测试口径

状态：已核销；测试口径在实现前定稿，开发发现已纳入回归。

## 不变量

存量四门不得回退，无私有测试跨包引用，不静音原断言。新契约输出穷举 AgentEvent/stopReason/errorCodes，文档与类型负例双向检查。

## 正常链路

纯文本、空内容与拒绝/长度/暂停/其他结束、原流序列透传及响应保真；工具一次/多次循环、批次并行但结果按输入序回填、图片/structured/业务错误/设施错误、完整 reasoning/provider continuation、累计 usage 每步一份。普通插件 A/B 经共享服务仍可分别授权，运行阶段重新拒绝及策略卸载拒绝；普通插件可替换上下文、持久检查点、拒绝继续，依赖均从 call.deps 使用。工具空白名单与子范围可见性、目录动态变化由最终授权保护。

## 拒绝矩阵

无效 options/request/signal/timeout、循环/原型/getter/undefined/超深/超节点/大字节，边界两侧；有副作用 A 与 schema 错误 B 整批零执行；不完整 JSON、同轮/跨轮/历史重复 callId、未知工具、非 tool-calls 携带调用、不完整块；整批零副作用。工具写成功后异常必须 checkpoint unknown、停止下一次模型，不暗示可安全重试；整批失败明确 toolsMayHaveRun。上下文插件伪造 schema/扩大工具集合/添加未知字段/坏消息配对，检查点失败，恶意服务返回畸形报表和原始秘密异常。

## 并发与故障

同 runId 竞争、全局容量、取消后真实退出前保持 busy、排队/模型/工具/检查点/消费者各阶段取消及超时、卸载与动态替换、迟到回调、消费者失败锁存、无工具在完整验证及 response checkpoint 成功前执行。工具预算整批不足零执行；step limit 返回稳定成对 transcript。上下文预算包含全部历史，不靠截断输出换绿。

## 生命周期与集成

GC 子进程：保存结束的 stream 或 model onEvent 引用不保留输入、服务、宿主回调。惰性流未消费/预取消/迭代 break/并发 next/晚读取 result。既有 child fixture 模式覆盖 source/dist 混合身份；回环 HTTP（不依赖付费凭证）驱动真实模型工具循环，SQLite 检查点落库重开，断言完整 transcript 和 continuation 保真、不自动重放未确认调用。

## 假绿检测

故意移除完整结束原因校验、工具白名单、重复 ID、检查点等待、实际完成容量、进度失败锁存、预算等守卫，测试应由业务断言失败，导入错误/超时不算检出。最后报告全部原始测试/覆盖率与审查处置，不声称跨进程 exactly-once 或分布式高可用。

消费者抛错时使用忽略 signal 的模型及工具验证：回执在释放 gate 之前为 core cancelled，同 runId/满额请求仍 busy；释放后额度恢复。此断言将原 consumer-failed 回执改为 core cancelled，原因是 core 的正常结果必须等待 child.actual，而取消可提前 settle；保留副作用防护、无后续事件与异常文本保密断言。
