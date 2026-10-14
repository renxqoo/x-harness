# 外部插件组合示例

## 1. 示例边界

这些接口示例说明外部插件如何使用 core。它们不构成 core 的生产模块，不导入任何业务实现。所有代码块通过 core/src/index.ts 的真实公开入口进行类型检查。业务提供者由示例参数注入，应用行为须由对应插件自己的用例验证。

普通插件优先使用领域服务。只有需要改变执行过程的插件才使用调用链。业务服务自己的写入、投影和恢复逻辑不得进入 core。

## 2. 外部对话契约

下面的契约属于外部对话插件。core 不定义 MessageRole、ContextMaterial 或 ConversationService。

```ts
type MessageRole = "system" | "user" | "assistant";

interface ContextMaterial {
  readonly key: string;
  readonly role: MessageRole;
  readonly content: string;
}

interface MessageInput {
  readonly role: MessageRole;
  readonly content: string;
}

interface ContextReplacement {
  readonly expectedPosition: number;
  readonly range: {
    readonly from: string;
    readonly through: string;
  };
  readonly role: MessageRole;
  readonly content: string;
}

interface ConversationService {
  registerContext(input: ContextMaterial): Promise<Result<Disposer>>;
  append(input: MessageInput): Promise<Result<{ readonly messageId: string }>>;
  replace(input: ContextReplacement): Promise<Result<void>>;
}

function defineConversationContract(): Result<ServiceToken<ConversationService>> {
  return defineService<ConversationService>({
    name: "conversation",
    methods: {
      registerContext: {},
      append: {},
      replace: {},
    },
  });
}
```

定义模块在应用装配阶段处理声明 Result，公开有效 token。插件作者导入该 token，不需要在每个插件里重新定义对话契约。

对话提供者登记材料时使用 Invocation.effect 归属消费方。材料身份包含消费方作用域、插件身份与 key，避免两个插件使用同名 key 相互覆盖。Disposer 撤销材料登记。

材料 role 是模型角色，来源由对话提供者根据 core 的 Invocation.origin 记录。插件不能靠 role 冒充实际用户。

## 3. 系统提示词

```ts
function createSystemPromptPlugin(
  conversation: ServiceToken<ConversationService>,
  prompt: string,
): Plugin {
  return {
    name: "system-prompt",
    requires: [conversation],
    apply(ctx) {
      const service = ctx.use(conversation);
      if (!service.ok) return service;

      return service.value.registerContext({
        key: "instruction",
        role: "system",
        content: prompt,
      });
    },
  };
}
```

插件只表达内容与角色，不展开 request，不拼 edits，不处理 next。对话插件负责将登记材料接入其上下文准备流程，登记函数返回的 disposer 归本插件生命周期。

## 4. user 纠正消息

```ts
async function appendCorrection(
  ctx: DependencyContext,
  conversation: ServiceToken<ConversationService>,
  text: string,
): Promise<Result<{ readonly messageId: string }>> {
  const service = ctx.use(conversation);
  if (!service.ok) return service;

  return await service.value.append({
    role: "user",
    content: text,
  });
}
```

调用发生在错误处理插件自己的业务时机。它不是实际用户输入。对话提供者保留调用来源并提交消息记录。

这里的依赖门面由运行期调用通过 call.bind(ctx) 取得，继承原请求取消和截止时间。

## 5. skill 列表

```ts
function createSkillListPlugin(
  conversation: ServiceToken<ConversationService>,
  loadList: (call: Invocation) => Promise<Result<string>>,
): Plugin {
  return {
    name: "skill-list",
    requires: [conversation],
    async apply(ctx, call) {
      const service = ctx.use(conversation);
      if (!service.ok) return service;

      const list = await loadList(call);
      if (!list.ok) return list;

      return await service.value.registerContext({
        key: "available-skills",
        role: "user",
        content: list.value,
      });
    },
  };
}
```

扫描、解析、过滤、排序和渲染完全由 loadList 所属技能插件实现。列表为空也生成明确的空目录材料，不能保留失效的可用列表。

此示例登记一次已加载材料。动态目录插件可以在自己的任务中重新计算并通过对话插件公开的更新契约更新材料；更新是对话与技能领域协议，不为 core 增加 skillCatalog 或 collect API。

## 6. 压缩上下文

```ts
async function applySummary(
  ctx: DependencyContext,
  conversation: ServiceToken<ConversationService>,
  replacement: ContextReplacement,
): Promise<Result<void>> {
  const service = ctx.use(conversation);
  if (!service.ok) return service;

  return await service.value.replace(replacement);
}
```

压缩插件自己读取上下文、选择范围并调用摘要能力。对话插件按 expectedPosition 检查并发冲突，检查工具调用与结果边界，提交范围替换。原始业务记录如何保留由会话插件负责。

core 不解析 summary，不判断消息范围，不将摘要伪造为实际用户输入，也不负责会话投影。

## 7. 顺序恢复调用

```ts
function createRetryPlugin<I, O, E>(
  chain: ChainToken<I, O, E>,
  shouldRetry: (reason: E | CoreFault) => boolean,
): Plugin {
  return {
    name: "request-recovery",
    requires: [chain],
    apply(ctx) {
      return ctx.on(chain, async (input, next, call) => {
        let result = await next(input);

        for (let attempt = 1; attempt < 3; attempt += 1) {
          if (result.ok || call.signal.aborted) return result;
          if (!shouldRetry(result.reason)) return result;
          result = await next(input);
        }

        return result;
      });
    },
  };
}
```

这是高级插件使用调用链的场景。shouldRetry 判断属于调用领域；可以进一步修正输入，但必须经过被包装路径的校验、授权和执行宿主选择。

chain 提供者负责公开一个始终经过授权的执行路径。恢复处理器应包装该路径，而不是在授权后重试裸执行函数。具有外部副作用的未知结果不能因为普通异常而直接重试。

core 提供 next 身份、顺序、预算和取消，不提供 retry 错误清单或自动退避策略。

## 8. 决策插件

```ts
function createPolicyPlugin<I>(
  guard: GuardToken<I>,
  decide: GuardHandler<I>,
): Plugin {
  return {
    name: "access-policy",
    requires: [guard],
    apply(ctx) {
      return ctx.on(guard, decide);
    },
  };
}
```

访问规则、资源判定和等待审批由 decide 实现。guard 的提供者先通过 provide 登记扩展点。实际执行服务必须明确调用 guard 并阻断失败，core 不知道路径、工具名或用户权限。

## 9. 提供者的写法

```ts
function createConversationProvider(
  conversation: ServiceToken<ConversationService>,
  create: (ctx: Context) => ServiceImplementation<ConversationService>,
): Plugin {
  return {
    name: "conversation",
    provides: [conversation],
    apply(ctx) {
      return ctx.provide(conversation, create(ctx));
    },
  };
}

async function assembleExample(
  conversation: ServiceToken<ConversationService>,
  create: (ctx: Context) => ServiceImplementation<ConversationService>,
): Promise<Result<LoadReport>> {
  const root = createContext();
  if (!root.ok) return root;

  const loaded = await root.value.load([
    createConversationProvider(conversation, create),
    createSystemPromptPlugin(conversation, "按用户目标完成任务。"),
  ]);

  if (!loaded.ok) {
    await root.value.dispose();
    return loaded;
  }

  const closed = await root.value.dispose();
  if (!closed.ok) return closed;
  return loaded;
}
```

create 的可变实例状态在 apply 内初始化。复用同一个 Plugin 定义对象创建多个宿主，不能共享材料表、会话或连接。

例子的装配函数演示从创建到关闭的完整资源生命周期；实际应用由宿主保留 RootContext 并在应用退出时关闭。

## 10. 运行期间的嵌套调用

apply 中登记静态提示词可以直接 use。服务方法或处理器内的依赖调用通过 call.bind(ctx) 关联父调用，才能继承本次取消与截止时间。

```ts
async function appendWithinCall(
  ctx: Context,
  call: Invocation,
  conversation: ServiceToken<ConversationService>,
  message: MessageInput,
): Promise<Result<{ readonly messageId: string }>> {
  const bound = call.bind(ctx);
  if (!bound.ok) return bound;
  const service = bound.value.use(conversation);
  if (!service.ok) return service;
  return service.value.append(message);
}
```

## 11. sandbox 与多 Agent 房间

这些场景采用插件组合，不向 core 增加业务 API。

| 场景 | 外部插件契约 | core 使用点 |
| --- | --- | --- |
| 受限执行环境 | 环境服务、执行路由、资源与取消协议 | provide/use、chain、guard、scope/effect |
| 房间成员管理 | 房间状态与成员服务 | 服务及作用域 |
| 房间可靠投递 | 消息记录、目标投递身份、确认与去重 | 服务、任务、内存通知 |
| 独立 Agent 实例 | 会话、运行、输入队列服务 | 子作用域、服务、任务 |
| 回应策略 | 提及、轮次、主持、停止条件 | 外部定义的 chain/guard |
| 进程重启恢复 | 状态快照、记录重放、未决投递处理 | 重装插件，业务服务恢复 |

每个房间参与实例有独立会话和可变状态。房间日志决定消息顺序，接收队列使用稳定投递身份去重。core 的 Event 只通知有新工作；实际业务消息留在外部持久记录中。

仅需不同业务状态的实例使用外部领域工厂。每个实例需要独立插件集合时，使用宿主提供的受限实例管理服务：插件提交获准配置身份和参数，服务登记调用者拥有的创建请求，宿主创建子作用域并调用 root.load。实例服务返回不透明身份与受理回执，随后提供状态查询，不交出 RootContext。安装失败关闭子作用域，调用者停止取消未完成创建并关闭已经创建的实例。

activation/cleanup 阶段不等待新的装配；激活中申请的需求由宿主在当前提交后处理。停止请求先返回受理，宿主再等待关闭，避免实例在自身服务调用中等待自己。配置许可、成员规则、实例名称和请求记录全部属于外部服务。

安装这些应用夹具不能修改 core 生产代码。如果缺少通用机制，先说明机制为什么适用于其他应用，再调整规范，不添加以房间或 Bot 命名的核心接口。
