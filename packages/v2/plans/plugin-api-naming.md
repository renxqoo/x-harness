# 插件接口命名与职责

普通作者通过 definePlugin、setup、service、deps、on 和 resource 使用内核。实现与调用者同步迁移，不保留别名。

## 统一接口

宿主入口为 createHost，返回 Host。安装 install、卸载 uninstall、关闭 close、取得服务 use、创建范围 createScope。register 保留显式 token 的高级登记协议，closeScope、wait、inspect、diagnostics 保留。

插件上下文使用 scopeId、scopeState、signal；service 仅批量提供所有已声明服务；handle 提供一个已声明 chain 的终结处理器；on 仅登记事件；middleware 仅登记链中间件；guard 仅登记决策处理器。dispatch、emit、deps、requestClose 保留。上下文清理为 addCleanup，任务为 startTask，范围为 createScope。

use 在宿主、范围与清理上下文中保持一致。Invocation 的 effect 和 spawn 保留，其余受管执行规则不变。资源配对使用 open/close，返回 Result。Result 失败字段为 error；Guard deny 的 reason 保留原含义，业务数据的 reason 字段不重命名。

requires、optional、provides 与 setup 不变。事件和 guard 只需 provides 声明，由装配在该插件 setup 前创建暂存登记；同批发布、失败回滚、配额与发出权限保持，消费者声明不能取得发出权限。缺少服务实现或 chain 终结处理器仍拒绝提交。高级宿主通过 register 显式提供事件与 guard。

## 类型与验证

service 仅接受声明中的服务实现全集；handle 只接受自提供的 chain。on、middleware、guard 分别约束事件、链和决策 token；未声明名称、错误处理器、越权发布均编译和运行拒绝。

保留现有行为测试，按语义迁移，不删除断言、不降低门槛。增加职责错用、声明自动激活及回滚、事件权限、旧字段拒绝、调用 effect/spawn 保留的类型与运行回归。文档示例编译真实入口。

执行工作区 lint、typecheck、build、test，相关真实 HTTP/SQLite 组合与轮换压力；报告实际数量、覆盖率和限制。
