# 会话级 Worktree 工作流——架构图解

> 配套文档：SESSION-WORKTREE-WORKFLOW.md（v5.0 定稿）。本文件用图回答三个问题：**给用户添了什么、两仓各改了什么、数据怎么安全地流动**。

## 1. 总架构：两仓五层全景

```mermaid
flowchart TB
    subgraph USER["👤 用户"]
        UI1["新建任务页<br/>开关「在独立 worktree 开始」"]
        UI2["会话分支面板<br/>「在此树开始新任务」/「前往」<br/>「合并回主仓」/「清理」"]
        UI3["worktree 会话呈现<br/>[wt] 徽标 · 派生树 chip · 侧栏归并主仓组"]
    end

    subgraph APP["agent-app（Electron 客户端）"]
        subgraph RENDER["渲染层（阶段 3 改动）"]
            SW["开关状态机"]
            PANEL["分支面板三动作 + detached 行"]
            CONFIRM["清理确认框（两级呈现）"]
        end
        subgraph MAIN["主进程（阶段 2 改动）"]
            VERBS["🆕 git/worktree/* verbs ×4<br/>create / list / remove / merge"]
            REG["🆕 登记面（持久 JSON 三张表）<br/>白名单 · threadId→树 · 树→repoTop"]
            NOTIFY_CALL["建树成功 → 通告投递调用"]
        end
        CONTRACTS["🆕 contracts 镜像<br/>verb schema ×4 + thread/notify 命令"]
    end

    subgraph HUB["x-harness（宿主）"]
        ROUTE["🆕 host 路由：live-only 谓词<br/>parked/dead/retiring/spawning → 拒<br/>不入 wake / 不入 requeue"]
        LOOP["🆕 agent-loop：空闲免费投递<br/>notify 扩 target 参数<br/>前导 origin 同批领取"]
        SESSION["会话（system prompt 不变）<br/>通告 = agent/message{content}"]
    end

    subgraph FS["💾 磁盘 / git"]
        MAINREPO["主仓<br/>/work/myproj (main)"]
        WTTREE["🆕 用户树（独立区）<br/>.x-harness-user-worktrees/<br/>myproj-feat-login"]
        AGTREE["子代理树（既有，零改动）<br/>.x-harness-worktrees/<br/>myproj-agent-8hex"]
    end

    USER --> RENDER --> MAIN
    VERBS -->|"worktree add / remove<br/>merge --no-ff / CAS"| WTTREE
    VERBS -->|"跨进程 repo 锁<br/>（与子代理树操作互斥）"| AGTREE
    MAINREPO -.->|"merge-back 收编"| WTTREE
    NOTIFY_CALL --> ROUTE --> LOOP --> SESSION
    CONTRACTS -.->|"同批同步"| ROUTE
```

**读图要点**：蓝框 🆕 是本方案新增；子代理树区（agent-delegation 包）**产品代码零改动**——本方案与既有委派机制完全正交，只共享 git 层的跨进程锁。

## 2. 用户旅程：三个入口 + 完整生命周期

```mermaid
flowchart LR
    subgraph ENTRY["三个入口"]
        A["① 新建页开关<br/>会话出生就在树里"]
        B["② 会话内建树<br/>会话留主仓，工作去树里"]
        C["③ 前往<br/>人进树开新上下文"]
    end

    CREATE["create（七步预检链）"] --> WORK["在树里干活<br/>agent 读写全在树<br/>主仓分毫不动"]
    WORK --> MERGE["merge-back 合回主仓<br/>merge --no-ff<br/>（受切换锁保护）"]
    MERGE --> CLEAN["清理（四道安全门）<br/>占用门 → CAS →<br/>收编门 → 干净门"]
    CLEAN --> DONE["干净收场<br/>树 + 分支双清"]

    A --> CREATE
    B --> CREATE
    C --> CREATE

    style A fill:#e1f5fe
    style B fill:#e1f5fe
    style C fill:#e1f5fe
    style MERGE fill:#fff3e0
    style CLEAN fill:#fce4ec
```

**生命周期间 = 出生 → 收编 → 销毁**，全程 GUI 内闭环。没有 merge-back 的话，清理门要求"已收编"而用户无路可走——树越有价值越删不掉（二轮产品审查判阻断后补上的关键一环）。

## 3. 核心新能力：空闲会话的免费通告（为什么动 agent-loop）

```mermaid
sequenceDiagram
    participant U as 用户
    participant APP as agent-app 主进程
    participant HUB as hub (thread/notify)
    participant W as worker 分派
    participant D as driver (agent-loop)
    participant LLM as LLM

    Note over U,D: 场景②：空闲会话里点「在此树开始新任务」
    U->>APP: 输入分支名 feat-login
    APP->>APP: create verb（预检 + 建树）
    APP->>HUB: thread/notify(git-worktree, content, 文本)
    HUB->>W: live-only 路由（retiring/spawning 拒）
    W->>D: 读 status() 判定投递形态

    alt 会话 busy（正在跑）
        D->>D: notify → next-step + 唤醒
        Note over D: 追上在飞轮，步边界材料化<br/>零额外 LLM 调用
    else 会话 idle（空闲）
        D->>D: notify → next-turn 排队，不唤醒 ✨
        Note over D,LLM: 此刻零调用、零花钱
        U->>D: 下一条消息「开始修复登录页」
        D->>LLM: 同批领取：[通告 + 用户消息] 一个 dial
        LLM-->>U: 一次调用同时知道树在哪 + 要干什么
    end

    Note over D: 通告材料化为 agent/message{content}<br/>UI 类型级隐藏 · 压缩摘要保留（长会话不失忆）
```

**对比（若无此能力）**：现状 `notify` 恒唤醒 → 空闲会话被叫醒 → 一轮只有通告的完整 LLM 调用（花钱 + 模型回一句没人要的"知道了"永久留在对话里）。配套改动三处缺一不可：target 选队列、**前导 origin 同批领取**（否则通告独占首轮、用户消息被挤到下一轮）、**仅剩 origin 不链式**（否则收尾后又拉起纯通告轮）。

## 4. 数据安全：清理的四道门 + CAS

```mermaid
flowchart TB
    START(["用户点「清理」"]) --> G1{"① 占用门<br/>live/parked 会话？<br/>运行中子代理树？"}
    G1 -->|是| R1["拒 worktree_in_use<br/>（带占用名单与指引）"]
    G1 -->|否| PIN["锁内 pin 住分支 tip"]
    PIN --> G2{"② 收编门（is-ancestor）<br/>tip 被其他本地分支包含？"}
    G2 -->|"否（squash/cherry-pick/<br/>未合并/C1 冲突解决）"| R2["拒 worktree_dirty<br/>指路「先合并回主仓」"]
    G2 -->|是| G3{"③ 干净门<br/>status --porcelain --ignored"}
    G3 -->|"有内容（含 .env 类<br/>被忽略文件 / untracked）"| R3["拒 worktree_dirty<br/>三类计数 + 指路句"]
    G3 -->|干净| RM["worktree remove（非 force）"]
    RM --> CAS{"④ CAS 删分支<br/>update-ref -d <pinned-tip>"}
    CAS -->|"exit 0"| OK["✅ 干净收场"]
    CAS -->|"非 0 → show-ref 复核：缺席"| IDEM["✅ 幂等成功<br/>（并发已删，不谎报）"]
    CAS -->|"非 0 → show-ref 复核：在场"| DRIFT["⛔ tip 漂移！<br/>锁外有人 commit 过<br/>分支保留可恢复（如实报错）"]

    style R1 fill:#ffebee
    style R2 fill:#ffebee
    style R3 fill:#ffebee
    style DRIFT fill:#ffebee
    style OK fill:#e8f5e9
    style IDEM fill:#e8f5e9
```

**CAS 是全方案数据安全的最后防线**：agent 的 bash commit 完全在跨进程锁之外（锁只互斥树管理操作）——门评估后若有穿插 commit，普通 `branch -D` 会无检查恒删，CAS 因 tip 不匹配必然失败，分支与提交保留可恢复。判别链（exit 两态 + show-ref 复核）不依赖 stderr 文案与版本敏感码值。

## 5. 改动清单速览（给评审/排期）

```mermaid
flowchart LR
    subgraph XH["x-harness（阶段 1）"]
        direction TB
        X1["host-hub 协议四文件<br/>thread/notify + live-only 谓词"]
        X2["agent-loop 六项落点<br/>target 参数 · 领取规则 · 链式判定<br/>reinsertClaimed · claimReinserts · replay"]
        X3["文档两份 + 共享测试向量"]
    end
    subgraph AAP["agent-app（阶段 2–4）"]
        direction TB
        A1["contracts：verb ×4 + 命令镜像"]
        A2["api：git-worktree.ts verbs<br/>+ 占用门冷路径 + 锁复刻"]
        A3["渲染：开关/三动作/确认框/<br/>徽标/chip/i18n 32 key ×2"]
        A4["登记面三张表 + 持久化"]
    end
    E2E["阶段 5：e2e 全旅程<br/>建树→工作→合并→清理<br/>（非零提交树）"]

    XH --> E2E
    AAP --> E2E

    style X2 fill:#fffde7
    style A2 fill:#fffde7
```

**改动边界承诺**：agent-delegation 包产品代码零改动（子代理域与用户域完全正交）；无旧路径删除、无兼容层、无双轨字段；agent-loop 改动全部纯加法（target 参数带缺省，现有消费方零感知）。

## 6. 红线（为什么这样设计）

| 红线 | 对设计的约束 |
| --- | --- |
| KV 缓存前缀不可变 | system prompt 装配期铸死；一切动态事实走 agent/message 追加（通告不碰缓存前缀） |
| 会话 cwd 是出生事实 | 不做会话中途换 cwd；「会话去树里」= 前往开新会话 |
| 用户树永不自动清理 | 与子代理树（会话结束自动评估）物理分区 + 判据分治；清理只能显式过四道门 |
| 零兼容层 | 纯加法；删分支单轨 CAS（branch -D 彻底退役） |
