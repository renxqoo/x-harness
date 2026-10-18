# 独立方案审查

审查者scheduler_plan_review只读，未参与实现。问题已全部处置：

- 排队期间授权可能撤销：准入及每节点执行前用同一冻结operation/origin/calls复查原始提交者；tools最终仍以scheduler委托身份授权。名称晚绑定是显式契约，不伪造core origin。
- 图元数据可无限重复：完整calls受字节和节点预算，每个dependsOn数量不超过calls.length-1且拒绝重复，callId最多128字符，整图拒绝循环与悬空。
- immediate绕开公平队列：参与同一lane轮转，没在当前可用名额中被选择即busy并撤销，不能插队。

实际退出保留名额、失败只传播后代、tools busy不重试、准备阶段预留容量均核对；未发现其他确定冲突。
