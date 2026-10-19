# 普通插件扩展契约

状态：实现完成，验收记录见[ACCEPTANCE.md](./ACCEPTANCE.md)。级别：中，feature-dev-v2。用户裁决：扩展入口是公开契约，普通插件可完整实现权限及同类扩展；不保留历史兼容路径。

## 问题域与审计

修复tools权限与工具贡献。权限工厂当前独占私有许可登记，工具工厂独占目录品牌和派发票据解释。两者必须可由普通definePlugin配合ctx.guard/ctx.middleware实现。LLM、session storage、execution已能通过公开service契约提供实现，不做无关重写；补普通插件示例或验证。PreparedTool、ToolCommit、Capacity、ExecutionTarget属于运行时能力句柄，保留防伪。

core仅承担通用机制，不增加权限/工具业务。审批界面、用户认证、规则语言、文件编辑和远程持久审批不在本次实现，由宿主与对应插件实现。普通插件属于受信任应用代码，公开声明不能隔离任意宿主JavaScript。

## 权限契约

公开toolExecutionAccess仍为core guard，输入改为ToolAuthorization：不可变plan和allow(grant)。ToolGrant必须提供signal（通常ctx.signal），可提供revocation与isValid；allow校验、登记本次许可并返回标准GuardDecision。普通插件通过ctx.guard注册，异步调用宿主/依赖服务询问后返回authorization.allow({signal:ctx.signal})。拒绝仍使用标准deny。只返回裸allow是放弃否决，不授予受控许可。

allow仅检查期间有效，结束后关闭回调持有的cell；迟到allow返回拒绝，不能补签，也不持有plan/runtime。tools检查全部登记许可；任何guard拒绝或失败都阻止执行。许可所有者取消、额外revocation取消、isValid失败均撤销；执行中撤销只请求取消，实际工作退出前保留锁与容量。最多128份授权grant，防止无限登记。

access默认required：基础toolAccess与完整计划toolExecutionAccess均需配置，无应答或无grant拒绝。access:allow为宿主显式全部允许，登记tools自身存活期的默认grant；它不能覆盖其他guard拒绝、异常或撤销的grant。受控应用必须使用required；卸载唯一授予许可的插件后新请求拒绝。

createToolPolicyPlugin保留可选便利封装，但只能调用公开allow，不能访问私有许可表；调用方提供的可选signal映射为revocation，ctx.signal绑定所有者寿命。原ToolPolicyOptions/ToolPermission业务回调保留其实际含义，不提供旧guard输入别名。

## 工具贡献契约

公开toolCatalog、toolPreparation、toolDispatch和对应输入类型。目录项为结构化{signal:ctx.signal,tool,limits?}；普通插件通过catalog middleware贡献。安装路由由(ctx.signal,tool.name)确定，不要求作者生成或注册身份；tools按(signal,name)固定一个内部UUID用于计划元数据，不按贡献对象引用生成身份。同一生命周期内的同名声明必须具有一致的描述与limits；新的等值对象复用安装，冲突描述拒绝。描述签名按严格码元顺序排列对象键，Unicode不同键不因本地化排序等价而误判。每signal最多128个不同名称，signal撤销清空索引。tools验证原生signal、描述/schema/limits并快照，自行计算字节，不信任作者bytes。规范化结果按不可变贡献对象WeakMap缓存，重复发现不重新编译schema。重名拒绝；目录预算、core可见范围及安装身份准入快照不变。

准备请求公开ownerSignal/name/callId/input/caller；处理器按ownerSignal===ctx.signal与name共同路由；执行请求公开这些字段及plan/progress/execution。两类请求仍由tools颁发、冻结，validator只接受本次有效原对象；不能复制后调用next以更换已批准输入。关闭后失效。普通middleware直接读公开字段，不需要私有ticketData。

tools统一承担输入schema校验、准备结果校验、执行期限、每工具容量、progress锁存与结束、输出/schema校验、取消与真实退出等待。工厂仅规范化作者参数和把公开请求映射到作者回调，不再拥有专属正确性路径。普通作者依赖仍由core调用中的call.deps提供，不把初始化服务门面捕获为执行接口。

## 预算与生命周期

沿用目录32/上限128、目录字节预算、每工具并发1默认、输入64KiB、输出1MiB、progress16KiB单条和累计1MiB/10000条、期限60秒、准备计划256与最大128资源。无新无界队列或后台计时器。目录缓存不强持有卸载贡献。保存已关闭的授权、progress或派发函数不保留请求状态。取消回执不代表执行实际结束。

## 实施顺序与测试口径

1. 权限公开协议：普通guard授予/拒绝/无grant、丢失或卸载策略、revocation/isValid、迟到allow、异常/垃圾输入、128上界、GC；便利工厂经过同一路径。
2. 工具公开协议与集中执行边界：普通middleware贡献真实工具，强制输入/输出schema、progress违规、容量/取消、同名/安装id冲突、伪造/复制请求、卸载与替换、目录缓存及GC。
3. 审计其他扩展点：保留现有公开service方式，补公开入口的作者类型与运行旅程；源码/构建混用的权限与普通工具旅程复用既有跨进程装置。
4. 文档描述当前契约；旧内部token路径/私有旁路删除，所有作者示例经类型检查。
5. 四门、独立对抗审查、故意破坏许可登记/集中校验/生命周期的反向验证，最后SHA核对后仅合入本轮路径。

## 验收

- [x] 普通权限插件具备完整授予与撤销语义
- [x] 受控缺策略/无grant拒绝，显式全部允许不覆盖否决
- [x] 普通工具贡献具备相同执行边界与安装生命周期
- [x] 其他插件扩展审计、公开作者示例及类型测试
- [x] 原断言保留、相关源码/构建旅程
- [x] 四门、覆盖率数字、独立审查与反向验证
