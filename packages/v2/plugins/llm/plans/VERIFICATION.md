# LLM 测试与验收口径

状态：已核销。测试口径先于实现；实际运行证据记录在 ../reviews/acceptance.md。

## 1. 契约与类型

服务、请求角色、内容、事件、结束原因及错误code采用穷尽判别联合。文档词表与导出词表双向一致。每种事件至少有正常时序和非法时序例子；输入快照后调用方变异不影响网络，返回与已交付事件不被后续共享partial变异。访问器不执行，Proxy trap抛错不使进程崩溃。

正负类型用例覆盖三角色内容限制、tool call/result配对形状、错误工具输入、错误事件字段、unsupported角色/模态、完整处理终态、onEvent返回值、错误服务提供、源码/构建共享token、外部provider作者。README中完整插件及for-await示例通过公开入口真实typecheck。

## 2. 协议表

| 维度               | 必须覆盖                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses          | 多output_item、多content_part、交错块、函数参数delta与done、reasoning summary与opaque完成载荷、completed/incomplete/failed、引用、最终usage                                               |
| Chat Completions   | role空片段、文本、refusal、并行tool index、callId/name/input分片、finish_reason与usage尾帧、DONE/EOF、多个choice明确拒绝、显式reasoning兼容能力                                           |
| Anthropic Messages | message_start/blocks/message_delta/message_stop、初始非空内容、partial JSON、signature delta、redacted推理原文保留、累计usage、ping、流内error、各stop reason                             |
| 请求转换           | system/developer、文本/图片URL/base64、工具对象及结果、思考预算、显式max tokens配置优先级、output schema、原生continuation来源校验、document/search-result启用引用、Responses显式引用工具 |
| 输入错误           | 空/垃圾/越界、循环及深JSON、重复ID、孤儿工具结果、不完整配对、schema不支持关键字/正则/引用/复杂分支、Anthropic引用与json-schema互斥、providerOptions覆盖保留字段                          |

start不能读取可变partial并重发首字；delta/end补全文本必须有明确前缀关系，禁止猜测两段文本的重叠。工具参数逐字节保留，合法JSON只解析一次，截断/数组/原始字符串明确不可执行，不补{}。

结构化输出对相同请求/上游响应成对检查stream与generate：满足schema、合法JSON不满足schema、非法JSON、截断、拒绝；不允许先finish成功再发现invalid-output。引用旅程必须核对真正启用引用的请求与输入来源映射，不能仅让替身凭空发送citation。file_search请求只有vector store ID、无document输入而引用多个文件时，保留提供者/协议/fileId独立身份；缺失sourceId的请求文档引用仍拒绝，不捏造外部文件的本地身份。

同一规范场景在三协议上还原相同规范化语义；厂商差异明确断言，不强制不等价协议得到同一个原生数据形状。

## 3. 状态机与边界

覆盖delta先于start、重复start/end、end后delta、重复callId、跨块注入、sequence倒序、错误delta通道、未知辅助事件和未知语义块、规范化层终态后内容、已解码帧内重复终态/后续内容、协议终止边界后不再读取、EOF缺结束证据。完整tool-call最多一次，不完整参数绝不进入可执行输入。

边界取N-1/N/N+1：输入、行、帧、事件、块、工具参数、continuation、累计输出、JSON节点和事件数量。UTF8多字节、代理对、CR/LF跨chunk、BOM、注释、多行data、空data、含冒号值、非法编码、未完成尾帧、一次网络chunk含大量帧均覆盖。帧大小预算在JSON.parse之前检查，不能用网络chunk大小代替frame大小。

usage缺失/0/缓存读写/推理/累计更新/中途失败完整标记；不能双重累计。token计数与费用分离，不假设零价。明确length与context-overflow、rate-limit、HTTP413之间的边界，不用文案单词或零token进行危险猜测。

## 4. 取消、背压与真实关闭

预取消、等响应头、等待read、onEvent等待、工具input中间、终态边界、消费者break/return/异常、请求deadline、上游idle、sink期限、插件卸载及宿主关闭全部触发。

使用受控Promise阻塞消费者，断言不会继续无限读取或缓存。sink等待不触发上游read-idle；总期限仍有效。signal通知时即触发网络abort，不能等待sink醒来。对外首次取消与actual结束分开断言；sink不合作时core保留实际工作及并发容量，不能假报清理成功。放行后最终排空。

句柄/reader、取消监听、timer、并发槽按请求成功/失败/早退/超时全部核对；不以JS heap短时下降代替资源断言。旧门面不重定向，提供者重装后旧流不复活；无依赖权限的插件不能访问提供者。辅助迭代器首次next前无网络；原始CoreFault和准入前失败无事件时仍通过result原样可见；完整消费后result与服务回执一致；已消费后丢弃依赖总期限有界回收，不承诺GC立刻取消。fake scheduler与wall clock采用不同时间基准，验证没有跨时钟域减deadline。

## 5. 隔离与网络旅程

各测试独占回环服务器与配置；不导入其他包__test__私有装置。共享工具若用于多包则位于明确公开testing入口并被依赖边界允许。真实HTTP替身按协议分片，记录认证/参数/取消/连接结束；用同一生产fetch路径验证，不只注入预制事件。

源码与构建入口各跑：文本+工具完整流、usage尾帧、结构化结果、可触发引用的原生请求、推理回放、流中断、消费者早退及关闭后进程退出。所有子进程有期限、exit code检查、finally终止/等待及临时文件清理。不执行e2e/main.ts。

两提供者并行隔离，一个过载/断流不阻塞另一个；同provider并发边界被准确计数。取消实际未完成请求仍占槽，未知旧release不能释放新请求。重试策略默认一次调用，首个delta后异常不能隐式产生第二个POST。

## 6. 性能与负控制

基准单独记录环境、源码/工具指纹、网络替身、冷/热、并发、全部样本、首事件延迟/总吞吐/峰值有界缓存。固定字节量使用不同chunk大小及工具分片，验证非二次时间增长；至少3档数据量与重复样本，不以单次毫秒值声称最优。模型网络延迟与规范化耗时分别测量。

隔离源码突变至少覆盖：丢取消监听、提前释放并发、不等待sink、无帧字节限额、EOF当stop、参数{}修补、重复累计usage、跨模型回放continuation、终态后二次发布、共享可变partial。突变只写临时副本，必须被明确行为断言检出，导入失败、空套件或超时不算检出。

独立审查覆盖设计及各资源/并发密集切片；实现者不自审。问题逐条修复并有症状命名回归，驳回必须有契约与证据。最后检查无新增skip、断言删除、降低阈值或扩大覆盖排除。

## 7. 最终核销

- [x] 行为矩阵每项有归属与实际用例
- [x] 三协议、图片输入、推理/签名、工具、结构化输出及引用
- [x] 第三方作者检查器及公开示例
- [x] 背压、所有取消入口、过载与实际资源排空
- [x] 源码/构建真实网络进程旅程
- [x] 基准、故障突变及独立审查问题清零
- [x] lint零错误零警告、typecheck、build、test
- [x] 测试用例数与覆盖率数字，阈值90/88/95/96不降
- [x] 真实厂商门已跑/未跑如实记录，部署边界落档

原工作目录本轮四门通过；1097例与覆盖率详见[验收记录](../reviews/acceptance.md)。core GC装置经用户授权改为有界等待；11例专项、64次子进程和保留强引用的负控制已核验，保留全部断言和失败证据。
