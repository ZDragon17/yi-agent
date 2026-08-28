# CLI v0.1 技术方案

## 架构

```text
CLI Parser
   -> Application Services (init/run/inspect/replay/challenge/recover)
      -> AgentKernel <-> WorldPort adapters
      -> optional ModelAdvisor -> OpenAI-compatible API
      -> EffectBroker -> dry-run / future real executor
      -> LabStore (manifest/events/snapshot/lock)
      -> Decision Replay Engine + Ledger Reducer
```

Kernel 只处理纯数据和注入接口；Runtime 掌管进程间连续性；CLI 是薄适配层。事件账本是证据源，快照只是加速缓存。

## 技术选型

| 关注点 | 选型 | 理由 | 暂不采用 |
|---|---|---|---|
| 语言 | Node.js ESM JavaScript | 现有核心可迁移；本机 Node 26；零构建 | TypeScript：v0.1 增加工具链噪声 |
| CLI | Node `util.parseArgs` | 标准库、稳定、无依赖 | Commander/Yargs：当前收益不足 |
| 测试 | `node:test` + 子进程 E2E | 标准库，可真跑 CLI | Jest/Vitest：无必要依赖 |
| 持久化 | JSONL 事件 + 原子 JSON 快照 | 可审计、可篡改测试、易重放 | SQLite：过早固化 schema |
| 标识/摘要 | `crypto.randomUUID` + SHA-256 | UUID 只做审计；SHA 仅做损坏检测 | 无密钥哈希不能证明对抗性真实性 |
| 副作用边界 | `EffectIntent -> EffectBroker -> executor` | 先把确认、幂等、对账、补偿从 Kernel 分离 | 真实 OS executor：需 Future-Gate |
| 桌面端 | 暂缓 | 先验证内核和安全模型；当前 CLI 已可驱动标记沙箱 | Electron/Tauri 均不在 v0.1 拍板 |

## 模块

| 模块 | 职责 | 依赖 | FR |
|---|---|---|---|
| `src/kernel` | `step -> verify -> learn` 纯闭环、预测、选择、归因、学习 | 无 I/O | FR-2,3,7 |
| `src/worlds` | 五个不同状态/动作语义的内置模拟 WorldPort 和故障注入；通用适配器遵循同一窄契约 | kernel contract | FR-2,5,7 |
| `src/runtime` | LabStore、锁、事件、快照、恢复、重放 | Node fs/crypto | FR-1,3,4 |
| `src/challenges` | 假设、装置、判别器、结果 | kernel/runtime/worlds | FR-5 |
| `src/application` | 六个用例服务；默认注册五个内置 WorldPort，允许进程内显式注入 registry 及受控 external adapter | 上述模块 | FR-1..7 |
| `src/agent` | 模型提议结构化解析与上下文裁剪；不拥有状态或副作用 | API client、runtime schema | FR-2,6,7 |
| `src/cli.mjs` | 参数、输出、退出码 | application、agent、API client | FR-1..7 |

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 把环境答案藏进实现 | “通用”是假象 | 领域盲 Kernel；lab 间 token/维度置换；独立 Tester 晚绑定生成世界；结构禁依赖；结论只称未被证伪 |
| 真实副作用先于证据 | 崩溃后无法归因 | EffectBroker 先持久化 intent，再以同 nonce 执行；未知结果先对账；真实适配器延期单独设计 |
| JSONL 与快照双写不一致 | 错误学习延续 | 事件先落盘；启动时以账本重建/核对快照 |
| 探索规则在安全边缘停死 | 无法成长 | 安全优先；停机本身是合法结果，由 challenge 衡量感知/动作是否不足 |
| 确定性被时钟/inspect/渲染污染 | 无法复盘 | 随机源显式注入；时间不进决策；只读命令哈希验证 |
| 为了“自主”过早自改代码 | 不可控、无法归因 | v0.1 只学习参数与模型；代码演化由外层实验流程完成 |

## 里程碑

1. M1：纯 Kernel + WorldPort 契约，功能收敛。
2. M2：LabStore + 跨进程恢复 + replay，模块收敛。
3. M3：CLI + challenge suite，真实 E2E 和系统收敛。
4. M4：多维、多行动、资源、空间和队列等不同面向的连续反例实验与显式第三方 WorldPort 闭环，决定下一次底座演化，不直接进入真实桌面写操作。
5. M5：EffectBroker dry-run 契约、durable journal 与标记 sandbox CLI 收敛；只有通过人工 Future-Gate，才可实现真实桌面/设备 executor。
6. M6：将领域中立 ChangeSupervisor 接入 LabStore、Replay 和连续 CLI；用跨 WorldPort 的目标距离、归因、停滞与重规划反例决定下一轮底座演化。
