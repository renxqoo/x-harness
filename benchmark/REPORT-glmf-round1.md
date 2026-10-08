# 评测报告：x-harness agent 首轮全量基准（mcp-gateway-registry-v2）

> 日期：2026-09-27 · 执行：x-harness CLI（`-p --mode json`，无监督 headless）
> 模型：glm-5.3-flash（GLM 官方 anthropic 端点 https://open.bigmodel.cn/api/anthropic）
> 数据集：mcp-gateway-registry-v2（21 任务：5 trivial / 5 low / 6 medium / 5 high）
> 评审：claude-judge（claude -p + glm-5.3，同一 rubric prompt / schema / 校验链）
> 全部原始数据：`benchmarks/swe-benchmark-data/glm-5.3-flash/x-harness/swe3/mcp-gateway-registry-v2/`

## 1. 结果总览

| 指标 | 数值 |
|---|---|
| **task_score 均分** | **84.06**（21/21 全评，0 失败）|
| 任务完成 | **21/21，全部 6/6 工件**，执行 0 错误 |
| 分档均分 | trivial 87.32 / low 84.36 / medium 82.50 / high 82.36 |
| 总 tokens | 输入 130.0M（含缓存）· 输出 1.33M |
| **缓存命中** | **125.4M / 130.0M = 96.4%** |
| 成本（按 glm-5.3 公开价折算）| **$19.47 总 / $0.93 每任务** |
| 单任务时长 | 中位 20 分钟，最长 80 分钟 |
| 每任务 LLM 请求轮 / 工具调用 | 77 / 86 |

## 2. 与官方榜单对比（同数据集 · 6 工件 rubric · 单次运行）

官方 19 模型全部用 **claude-code harness**（数据源 `vend/swe-router/models.json`）。

| | 分数 | $/任务 | 21 任务总成本 |
|---|---|---|---|
| **x-harness + glm-5.3-flash** | **84.06** | $0.93¹ | **$19.47¹** |
| claude-opus-5（榜首）| 82.83 | $11.95 | $251.04 |
| glm-5.3（官方，同家族）| 80.11 | $7.04 | $147.83 |
| kimi-k3 | 79.17 | $4.33 | $90.95 |
| gemma-4-31b（性价比锚）| 59.74 | $0.87 | $18.29 |
| qwen3.6-35b（最低价锚）| 59.24 | $0.26 | $5.45 |

¹ 折算口径：input ¥4/M · 缓存命中 ¥0.8/M · output ¥16/M，÷7.2 → USD。**非账单**（flash 实际免费），是「同 token 量按 5.3 计价」的可比估算；单价如有出入可重算。

**结论**：分数第一（超榜首 1.2 分）+ 成本为同家族官方 harness 的 **1/7.6**。官方任何模型都未同时达到「80+ 分」与「<$1/任务」。

### ⚠ judge 偏移口径（对比结论的边界，必须随报告一起读）

- 官方榜单的 judge 模型与配置**未公开**；我们用 claude-judge（glm-5.3，同一 rubric 文本与 pydantic 校验链）。不同 judge 存在系统性宽严偏移（量级经验上 ±1~3 分）。
- 因此「84.06 > 82.83」不能直接宣读为超越 opus-5；**稳妥结论**是「x-harness 与官方头部 harness 处于同一质量档，且成本结构显著更优（1/7.6）」。
- 严格同尺复核路径：对同批工件用官方同款 judge 重判（若官方公开 judge 配置），或双 judge 交叉取均值。
- 本轮 judge 本身是 GLM 评 GLM（judge 模型与被测模型同家族），家族内自评偏置未排除——这是上述偏移的主要嫌疑方向（可能偏高）。

## 3. x-harness 优化分析（执行效率 · 下轮改进依据）

数据源：21 份事件流（全量工具调用与结果、逐 token 流）+ metrics。

### 3.1 输入量与质量负相关——多跑不加分

- 输入 tokens × 分数相关系数 **−0.24**：花钱多的任务反而略低分。
- 输入最少的 10 个任务均分 **86.36**（> 全体 84.06）；输入最大的 3 个（30.4M / 16.1M / 14.0M）分数 80.6 / 84.8 / 86.2——最贵的一个是全场最低分之一。
- 含义：**长尾的高输入任务是探索失控，不是必要深度**。压缩输入长尾不损质量，直接降成本与时延。

### 3.2 与官方 claude-code 的步数差距（量化）

- 按官方 glm-5.3 $7.04/任务 × 公开价倒推：官方约 **2.2M 输入/任务**；我们 6.2M/任务（中位 4.4M）——**输入量约 2.8 倍**。
- 每任务 77 次 LLM 轮 / 86 次工具调用。96% 缓存命中已把成本差打折到 1/7.6，但**时延差没有折扣**（中位 20 分钟/任务）。
- 工具结果体量实测：1,814 个结果合计 3.7M 字符（bash 1.6M / read 1.3M），9% 的结果 > 5K 字符。
  注：工具结果首次回灌只占每任务首轮输入，之后靠缓存（96%）——膨胀主因是**回灌后的多轮重算请求体**与长任务的高轮次乘积（77 轮 × 全历史输入），截断/摘要在源头收敛收益最大。
- 优化空间排序（按投入产出）：
  1. **轮次收敛（时延与输入的双重杠杆）**：77 轮/任务 × 全历史输入重发是膨胀主因——鼓励单轮多工具并行调用、在系统提示词层引导“先规划后执行”，减少确认型往返；预期轮次 77 → ~50，输入与时长同比例下降。
  2. **工具结果截断/摘要**：bash 长输出（>5K 字符的 9%，共 1.6M 字符）全量回灌并参与后续全部轮次——上游截断或分页，长尾任务收益最大。
  3. **探索收敛**：read/grep 优先于 bash 管道串行探查（首轮 GLM 评测发现的模式仍在）。
- 预期收益：输入 6.2M → ~3M/任务，时延 20 → ~12 分钟/任务，成本 $0.93 → ~$0.55。

### 3.3 已修复项（本轮评测过程中同步完成）

| 问题 | 修复 | 仓库 |
|---|---|---|
| print 模式 usage 事件丢缓存明细（B1）| token-meter 事实层扩展（cacheRead/cacheWrite 三路累计 + 尾值三件套）+ analytics 消费 meter + pi-events 恒透传，双轮对抗审查，commit `3ad7610` | x-harness |
| benchmark adapter 无缓存/成本映射 | xharness normalizer 补 modelUsage + usage cache 字段 | benchmark |
| GitHub 网络抖动烧评测时长 | 本地镜像缓存（每 repo@ref 一次网络）+ git 代理 | benchmark |
| deepseek judge 输出不合 schema（20/21 失败）| claude-judge（claude -p + GLM anthropic 端点，同 rubric/校验链）+ JSON 提取器修复 | benchmark |

## 4. 复现

```bash
# 评测（21 任务，launchd 托管版见 ~/Library/LaunchAgents/com.xharness.bench.plist）
XHARNESS_REPO=/Users/wrr/work/x-harness uv run scripts/run-swe-headless.py \
  --config /tmp/runner-glmf.yaml --model glm-5.3-flash \
  --dataset dataset/mcp-gateway-registry-v2.yaml --max-retries 2 --timeout 1500

# 评审（claude-judge；已评自动跳过）
uv run python scripts/claude_judge.py --recursive \
  --folder swe-benchmark-data/glm-5.3-flash/x-harness/swe3/mcp-gateway-registry-v2

# 实时面板（进度/分数/成本/事件流/工件预览）
open http://localhost:8899   # dashboard: ~/work/benchmark/dashboard/server.mjs
```

## 5. 下一步（待排期）

1. §3.2 三项优化进 x-harness（工具结果截断优先）→ 重跑本数据集验证「输入减半、分数不降」
2. judge 偏移复核：抽样 5 任务用第二 judge 交叉判分，量化 §2 的偏移幅度
3. glm-5.3 全量档（非 flash）跑一轮 x-harness，与官方 80.11 同模型直比，消除模型变量
