# yi-agent 项目导航

> **Evidence-grounded Evolution Runtime**：面向 self-evolving AI agents、可验证行为、确定性 Replay 和受控因果归因的实验运行时。

这页用于帮助 GitHub 访客从项目入口快速找到不同深度的材料。项目名和仓库地址保持为 `yi-agent`。

## 按阅读目标查找

### 我想先运行项目

1. 从 [README 快速开始](../README.md#快速开始) 安装 Node.js 22+ 依赖。
2. 使用 `--kernel-only` 运行不依赖模型的内置实验。
3. 用 `inspect` 查看已固化状态，用 `replay --chain` 检查跨 Run 连续性。

### 我想理解架构

- [设计契约](../design.md)：Kernel、WorldPort、Runtime、Application 和模型提议层的边界。
- [CLI 功能规格](../spec.md)：命令、退出码、JSON 契约和核心接口。
- [README 闭环说明](../README.md#我们设计的最小闭环)：用一条执行路径理解系统。
- [架构图](figures/fig1-architecture.svg)：分层结构和信任边界。

### 我想看证据和研究结论

- [研究论文与实验结果](../PAPER.md)：方法、实验、结果、限制和开放问题。
- [项目现状、风险与下一步](../vision.md)：对当前能力上限和技术风险的审慎判断。
- [任务与反证记录](../tasks.md)：功能演化、验收条件和反例驱动过程。
- [README 实现清单](../README.md#当前已经实现什么)：当前实现能力的长版索引。

## 核心术语

| 术语 | 在项目中的含义 |
| --- | --- |
| `Kernel` | 领域中立的纯闭环：预测、授权、选择、验证和学习。 |
| `WorldPort` | 把一个受约束世界接入共同 Kernel 的边界；领域语义不进入 Kernel。 |
| `verify → learn` | 只有可归因、可验证的执行证据才能改变记忆。 |
| `Replay` | 从不可变起点和账本重建决策，不重新调用模型或执行现实副作用。 |
| `Challenge` | 预注册、可反证的实验判据；`FALSIFIED` 与 `INCONCLUSIVE` 有明确区分。 |
| `ModelAdvisor` | 可替换、不可信的候选提出者；不能直接执行动作或写入状态。 |

## 诚实边界

这些材料描述的是可复现的工程实验和受控模拟证据。它们不等于通用智能、现实世界因果真值、可信硬件证明或任意生产系统的安全自动化保证。完整边界请先阅读 [PAPER.md](../PAPER.md) 和 [vision.md](../vision.md)。
