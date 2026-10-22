# Session

Session提供有序持久历史、有效对话、原子批次提交、幂等回执、分页和分支。它是core外部的领域插件，不包含Agent循环、模型SDK、工具执行、压缩算法或业务插件状态。

Session 依赖 sessionStorage 服务。使用时同时安装会话插件和存储插件：默认选择 session-sqlite，多节点共享数据库选择 session-postgres；本机追加日志可选择 [session-jsonl](../session-jsonl/README.md)。Session 自身不导入数据库驱动或平台模块。session/contracts 和 session/storage 是公开契约入口，源码与构建产物共享同一个服务 token。

```ts
import { createHost } from "@x-harness/core";
import type { Result } from "@x-harness/core";
import { createSessionPlugin, session } from "@x-harness/session";
import { createSqliteSessionPlugin } from "@x-harness/session-sqlite";

function configured<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Application configuration failed");
  return result.value;
}

const host = configured(createHost());
const plugin = configured(
  createSessionPlugin({
    namespace: "workspace-a",
  }),
);
const storage = configured(createSqliteSessionPlugin({ path: "./data/sessions.sqlite" }));
configured(await host.install([storage, plugin]));
const sessions = configured(host.use(session));
const created = await sessions.create({ id: "conversation-42" });
const result = created.ok
  ? await sessions.append({
      id: created.value.id,
      expectedRevision: created.value.revision,
      commitId: "input-42",
      entries: [
        {
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: "分析项目" }] },
        },
      ],
    })
  : created;
const catalog = await sessions.list({ limit: 20 });
const history = await sessions.history({ id: "conversation-42" });
const conversation = await sessions.conversation({ id: "conversation-42" });
configured(await host.close());
export { result, catalog, history, conversation };
```

插件消费者在requires中声明session，处理函数通过call.deps调用。服务方法返回Promise<Result>，失败位于error；error.source区分session与core。初始化配置错误通过createSessionPlugin的Result报告，数据库打开及配置冲突在install时报告。

## 记录及有效对话

Entry有两类：event为业务type/data，不进入对话；message包含role/content，可附replace:{startSeq,endSeq}。消息支持text、image引用、assistant的tool-call/reasoning；tool消息必须带callId。metadata可保留用量、结束原因或调用方的中立元数据。图像source是字符串引用或编码内容，session不下载或执行它。具体模型格式及推理回传规则由LLM适配器决定。

replace在当前有效对话中按端点位置替换连续节点，不能按seq数值排序。例如[seq5,seq3]可被startSeq=5/endSeq=3一起替换。历史只追加替换记录，原文保留。投影索引只保存position/seq，正文仍来自历史。分支重放与逐条更新得到相同有效对话，不重做工具或模型请求。

输入复制为规范化JSON快照，按遍历实时累计UTF-8序列化预算；getter不执行，循环、稀疏数组、非普通对象、非有限数及负零拒绝。读取结果深冻结。未知业务event可保存，未知消息块和对话操作明确拒绝。

## 写入与查证

记录time采用提交请求所在节点的壁钟，不能用来确定跨节点顺序。revision就是最后一条记录的seq，空会话为0。append要求非空entries、expectedRevision及commitId；在同一事务提交历史、视图、head和回执。相同commitId及规范化请求返回原回执，不同请求返回commit-conflict。对象字段顺序不影响请求身份；expectedRevision是身份的一部分。revision-conflict要求调用方重新判断业务，不自动重试外部副作用。

取消、超时或断线可能出现在提交之后。使用同一个commitId重试，或getCommit查证。not-found只表示这次读取没看到已提交回执，不能证明另一个在途操作永远不会提交，也不能据此更换commitId。

create要求调用方指定稳定id；相同创建参数幂等，不同参数already-exists。fork指定目标id、sourceId和throughRevision，允许截在源批次中间；原时间/seq保留，父子后续写入独立。未指定metadata时继承来源metadata，显式null清空。父commit回执不复制，子会话使用独立commitId命名空间。分支失败不残留目标或占用配额。

## 会话发现

使用 `sessions.list({})` 枚举当前namespace中已持久化的会话。输入可指定limit和after，返回sessions及可选next；摘要包含id、createdAt、metadata和parent，不含revision/bytes，完整当前状态通过get读取。进程重启后仍可发现会话，无需事先保存全部ID；列表不代表当前活跃Agent对象。

顺序固定为ASCII字节序ID升序，游标视为不透明值并绑定namespace。下一页传回next；after之后并发创建的ID可进入后页，after之前的新ID从首请求重新枚举。每页是一致读取，跨页不提供冻结全目录快照。空结果成功且无next，非终页必须推进。省略limit使用pageSize，上限maxPageSize，总字节数受maxPageBytes限制；后端为信封及字符串编码保留余量，页内条数可能少于limit，首条装不下时record-too-large。结果深冻结。

列表校验摘要及元数据，不检查完整历史正文。JSONL只解析校验头，不重放全部日志；记录正文在history/conversation读取时校验，get读取当前状态。损坏的候选摘要明确失败，不静默丢弃。搜索、业务metadata过滤及活跃运行对象由上层实现。

## 分页

history使用after历史seq和throughRevision固定上界，未来上界拒绝。首请求未给上界时，响应revision可用于后续页。conversation使用位置游标after，其内容同时绑定namespace、会话id和revision；游标视为不透明值。后续写入使旧游标revision-conflict，调用方从首请求重新读取。可另传revision要求当前投影版本。不存在的位置、非法及跨会话游标拒绝。成功非终页返回推进后的next，装不下一条时record-too-large，不返回无限空页。

## 容量与生命周期

默认每记录1MiB，每批4MiB/128条，每会话100000条/512MiB，有效对话10000节点；metadata16KiB，每namespace10000会话。每页默认100条，最多1000条/4MiB，返回信封计入字节预算。id、commitId和event type最多128 UTF-8字节。关键持久配额在namespace中保存，其他节点配置不一致时拒绝安装；条数限制同时限制回执和索引数量，数据字节配额不等于物理数据库文件大小。存储维护、备份及归档保留策略由部署方管理。

limits可在硬上限内配置，页预算至少比单记录预算多4096字节。SQLite同时1个事务，PostgreSQL默认最多8个，每实例最多64个排队等待者；取消等待者不会执行。每事务总预算10秒，在查询及提交前检查；数据库锁等待1秒，PG单语句最多5秒。超额明确失败，不无限排队。没有按会话增长的后台任务或刷新定时器。请求及读取副本的内存随批次/页预算和在途/排队数增长，部署时应同时配置这些上限；UTF-8配额不代表JavaScript堆的精确字节数。

数据库资源属于存储插件生命周期；SQLite I/O运行在独立Worker，数据库锁等待不阻塞宿主事件循环。卸载先停止新调用，再等实际工作排空并关闭连接/Worker。关闭插件不删除或永久封存会话，新实例可以继续读取和提交。没有异步audit落盘路径，通知不参与提交确认。

## 部署保证

SQLite文件启用WAL、foreign_keys、synchronous=FULL，文件权限为0600，新建父目录0700。支持同机多进程协调；不要将WAL文件放到多机共享网络文件系统。显式:memory:用于临时运行，不提供重启持久化。

PostgreSQL 通过 @x-harness/session-postgres 的 createPostgresSessionPlugin({ url }) 配置，与 createSessionPlugin({ namespace }) 一起安装。数据操作使用参数绑定、事务和目标会话锁，读取在一致快照中完成。数据库主库入口、TLS证书校验、同步复制/RPO、选主和备份由部署负责。插件不提供认证或不可信代码隔离；namespace由可信宿主配置，用户授权由上层完成。数据库错误不会透传SQL、连接串或凭据。

真实同步备库测试覆盖主库停止、备库提升、连接入口切换、同一实例重连、原回执查证及后续提交。该测试不等于所有集群部署都达到零数据丢失；异步复制故障切换可能丢失尚未复制的数据。网络分区下实际I/O不收敛时，core保留实际工作与资源，外围进程监督负责最终隔离。

## 验证

在packages/v2执行bun run lint、bun run typecheck、bun run build、bun run test。测试包含真实SQLite文件、真实PostgreSQL、跨进程竞争、SIGKILL恢复、事务故障、位置投影和同步备库提升。默认测试自动启动隔离PostgreSQL集群，需要initdb、pg_ctl、pg_basebackup在PATH；SESSION_TEST_POSTGRES_URL可配置专用测试库，但故障切换旅程仍只操作自己创建的隔离集群。不得指向业务数据库。没有运行时数据库服务时应报失败，不跳过数据库验收。

设计、旧实现裁决和逐项验收位于plans。源码和构建入口均执行真实进程旅程。部署方仍需为自己的数据库存储、复制及故障切换配置运行验收。

## 存储插件契约

session 负责输入校验、请求指纹、对话投影和有界前缀重放。存储插件负责原子持久化、版本检查、幂等回执、一致快照、资源管理及排空关闭。SQLite 和 PostgreSQL 共用 session-storage-sql 中的事务实现；其他后端直接实现存储契约。

SessionOptions 只包含 namespace 和会话配额 limits。SQL存储工厂接收 path 或 url，以及存储 limits：maxQueue、maxConcurrent、lockTimeoutMs、transactionTimeoutMs。JSONL接收path及maxQueue、lockTimeoutMs、operationTimeoutMs。SQLite 默认路径为 ./data/sessions.sqlite。应用在装配时明确选择后端，存储错误直接返回。

自定义后端实现 @x-harness/session/storage 的 SessionStorage，通过普通 core 插件提供 sessionStorage。接口包含 initialize、list、read、create、commit、history、conversation、fork、getCommit 九个操作，不传递 SQL、事务回调或连接句柄。metadata 是有界 JSON，读取会话头时先检查完整性，可复用 readStorageMetadata。记录正文是有界字符串，其规范 JSON 和精确 UTF-8 字节由 session 校验。后端将投影 position/seq 引用与历史、会话头和回执原子保存，对话算法只由 session 实现。

commit 必须先检查提交身份，再检查预期版本；重复请求返回原回执，同一 expectedRevision 的不同并发提交只能有一个成功。fork 接收领域已验证的不可变前缀及投影，必须原子发布目标记录、投影、会话头和命名空间计数。重复分支先返回既有目标，不重新读取来源，不复制父提交回执。

使用 @x-harness/session/testing 的 verifySessionStorage({ first, second, namespace }) 检查自己的后端。first、second 是同一隔离存储的两个客户端，namespace 使用未占用且最多121字符的值。检查器验证25项规则，包括并发版本竞争、重复提交、固定快照、分页推进、原子分支和命名空间隔离；失败时抛出带检查名称的测试错误。客户端和隔离数据由调用者在 finally 中清理。进程崩溃、断电耐久性与多节点切换，还需要各后端在真实环境中验证。

session 声明依赖存储提供方，core 拒绝卸载仍有活跃依赖者的存储插件。先卸载 session，再卸载存储，或关闭整个宿主；在途依赖调用始终受生命周期管理。更换后端需要明确重新装配应用及安排数据位置。

后端作者可从 session/storage 复用 readStorageRequest、readStoragePolicy、readStorageMetadata、readStorageSummary、createStorageListPage 和 createStorageQueue。请求及policy校验保持唯一实现；这些工具不包含平台、SQL或对话算法。请求校验复制并冻结输入，拒绝访问器；队列的容量参数由后端配置校验为正整数，close取消等待者并等待实际执行者退出。
