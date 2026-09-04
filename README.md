# 易闭环 Agent CLI

这是一个可在 Windows PowerShell 中运行的、面向通用智能底座实验的 CLI。

它不是另一个“让大模型帮你改代码”的工具，而是尝试回答一个更底层的问题：

> 一个系统要怎样观察世界、提出行动、验证结果、积累经验，并在下一次行动中真正改变自己？

当前最小 API 接口采用 OpenAI-compatible Chat Completions 协议，核心实验能力仍可通过 `init`、`run`、`inspect`、`replay` 等命令使用。

## 不可偏移的根基：易经的一体底层逻辑

`yi-agent` 的原始基因不是“调用一个更强的模型”，而是沿着《易经》的基本思想寻找一套能够贯通万事万物的变化逻辑：世界不是一组互相割裂的领域，领域只是同一变化过程在不同边界、尺度和关系中的投影。

这条原则对项目具有最高优先级：

- 二进制、电平、电压、Token、向量和领域对象，都是不同层次的表达与执行形式，不是彼此独立的智能原理；
- 状态不是静止的名词，而是处在关系、约束、趋势和变化中的位置；
- 观察、行动、反馈、验证、学习和再行动必须属于同一个变化闭环；
- 金融、医疗、组织、设备和软件可以拥有不同的 WorldPort 表面，但不能因此发明互相割裂的 Kernel、记忆或智能判据；
- 新增任何能力，都必须说明它如何回到同一套底层变化逻辑；如果只能靠领域特判、孤立维度或模型提示词才能成立，就视为偏离根基。

这里不是把卦象或数字直接硬编码进程序，也不是把《易经》当作已经被科学证明的结论；而是把“同源、关系、变化、反复验证、因时制宜”作为架构公理，并要求它们能够被 WorldPort 实验和反例持续检验。项目的最终方向，是让智能从跨领域可迁移的变化闭环中产生，而不是从某个领域的表面模仿中产生。

## 为什么要做这个

今天的 Codex CLI、Claude Code 等工具已经非常适合软件工程。它们通常让模型读取项目、选择工具、修改文件、运行命令，再根据结果继续工作；同时通过权限确认、沙箱或允许/禁止工具列表控制风险。

这类产品解决的是“如何让模型完成开发任务”。`yi-agent` 关注的是另一个问题：

> 如果把“编程”换成温度控制、医疗观察、金融决策、IoT 设备或组织管理，底层是否仍然可以使用同一套智能逻辑？

因此，我们不把文件、Shell 和代码编辑写死在内核里，而是把外部世界抽象为 `WorldPort`。一个世界只需要提供：

1. 当前状态如何被观察；
2. 当前允许哪些行动；
3. 行动会如何改变状态；
4. 行动结果如何被验证；
5. 哪些外部因素会干扰归因。

这样，编程只是一个世界，温度实验也是一个世界，未来的医疗、设备和组织系统也可以成为不同的世界实现。

## 与主流 Coding CLI 的区别

Codex CLI 的官方定位是运行在终端中的编码 Agent，可以读取、修改和运行本地代码，并通过不同批准模式控制自动化程度；Claude Code 也提供文件/命令工具、权限模式、最大 Agent 轮数和 MCP 接入。[Codex CLI 文档](https://help.openai.com/en/articles/11096431) · [Claude Code CLI 文档](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

它们和 `yi-agent` 不是同一层产品：

| 维度 | Codex CLI / Claude Code | yi-agent |
| --- | --- | --- |
| 目标 | 完成软件开发任务 | 实验通用的观察—行动—验证—学习闭环 |
| 世界 | 主要是代码仓库、终端和开发工具 | 由 `WorldPort` 接入任意受约束世界 |
| 模型角色 | 模型可以决定下一步使用哪个工具以及如何修改环境 | 模型只能提出候选 Token，不能越过 Kernel 直接行动 |
| 最终裁决 | 权限系统、工具宿主和模型协同裁决 | Kernel 的安全规则和 WorldPort 的执行回执裁决 |
| 状态 | 对话上下文、文件变化、工具调用历史 | 世界状态、观测、预期、回执、验证结果、学习记忆 |
| 学习 | 主要依靠上下文、会话恢复和项目变化 | 只有经过 `verify` 的结果才能进入 `learn` 记忆 |
| 回放 | 重点是继续或恢复会话 | 事件账本可确定性重放，重放不调用模型 |
| 当前取舍 | 面向真实开发，功能丰富，可直接干活 | 面向底层实验，范围较小，但强调可审计和可反证 |

可以把两者理解为：

- Codex / Claude Code：会干活的高级软件工程师；
- `yi-agent`：研究“智能行为如何被约束、验证和积累”的实验操作系统。

我们并不是要重新实现一个更弱的 Coding CLI。以后可以让 Codex、Claude 或其他模型充当 `ModelAdvisor`，帮助提出方案；但它们不应该直接拥有世界状态和最终执行权。

## 我们设计的最小闭环

当前模型参与时，执行路径是：

```text
WorldPort 观察
    ↓
ModelAdvisor 提出候选 Token
    ↓
Kernel 独立计算预期、检查权限和安全性
    ↓
WorldPort 执行动作并返回回执
    ↓
verify 验证是否符合预期、是否存在干扰
    ↓
learn 只吸收有证据的结果
    ↓
JSONL 账本记录完整因果链
```

核心原则是：

1. 无法形成可证伪预期，不行动；
2. 模型输出是不可信提议，不是事实；
3. 不安全或不允许的行动必须 fail-closed 停机；
4. 没有执行回执和验证证据，不能算作成功；
5. 未经验证的结果不能污染学习记忆；
6. 同一初态、种子和事件序列必须可以重放；
7. 系统不能通过自己的演示给自己颁发“已经智能”的证明。

Challenge 的三态也有严格分工：判别器确认系统违反预期时返回 `FALSIFIED`（CLI exit 2）；实验装置、输入或环境未能到达判别边界时才返回 `INCONCLUSIVE`（exit 3）。二者不能再由同一个异常兜底混淆。

这里的“闭环”不是简单的：

```text
Prompt → LLM → 调工具 → 再 Prompt
```

而是：

```text
状态 → 假设 → 行动 → 世界反馈 → 证据判断 → 状态更新
```

Prompt 和模型只是提出假设的组件；真正决定系统是否在现实中变得更好的，是反馈是否真实、验证是否独立、学习是否受到证据约束。

## 当前已经实现什么

- 纯 Kernel：数值观测、ValueSpec、不透明 Action Token、确定性随机状态；新运行使用带权绝对距离和 `tolerance` 可接受目标带，旧账本按兼容语义重放；
- `WorldPort`：五个内置世界覆盖连续控制、受保护对象、多资源库存、离散网格和排队系统；
- WorldPort 身份绑定：新实验把 `worldVersion` 与 `worldImplementationDigest` 写入不可变 manifest；继续运行、重启恢复和 Replay 都校验当前实现仍对应同一世界语义；没有这些字段的历史实验仅按 legacy 兼容路径读取，不宣称具备这项保证；内置摘要绑定具体 WorldPort 源码、共享 `world-port-base` 和定义元数据，不把无关世界的注册表变更误算成当前世界漂移；实现材料发生变化时必须更新摘要，摘要是发布边界的身份锚点，不是对任意不诚实注册表的数学证明；
- 可插拔外部世界：通过受控 JSONL 子进程协议接入；传输层只接受与请求 ID、协议版本严格匹配的单条响应，半帧、重复帧、stdout 污染和错误响应都会在写入 STEP 前 fail-closed；stderr 诊断和 Windows CRLF 不改变协议结果；
- 外部版本不透明：`stateVersion`/`intervalId` 只作为 WorldPort 提供的边界标识，宿主不再强制它们包含 world id 或采用某种字符串格式；连续性仍由 revision、nonce 窗口和前后状态绑定校验；
- 可审计运行时：事件账本、快照、锁、恢复和哈希链；
- 证据闭环：行动前预期、行动回执、复观、验证、学习；
- 延迟反馈归因：对已接受但尚未完成归因窗口的动作，按 executionNonce 持久保存有界 pending credit；后续 WorldPort 可返回匹配反馈，Kernel 只在证据闭合后学习，混杂反馈不会污染动作模型；该机制已用跨独立 CLI 进程、跨 Run 和 Replay 的外部 WorldPort 回归验证；
- 反馈投递幂等：在有界已结算收据窗口内，完全相同的重复 feedback 可跨 Run/进程安全忽略；同 nonce 的不同内容仍会 fail-closed，避免把消息重放或篡改变成新的学习样本；
- 反馈顺序规范化：同一批合法的 nonce-bound feedback 无论由不同 WorldPort 按何种传输顺序返回，Kernel 都按 pending credit 的持久顺序结算，保持 `settled`、已结算收据和信念样本跨进程/Replay 一致；这不等于允许多个动作同时生效，无法归属的重叠变化仍必须由 WorldPort 标记为混杂；
- 隐藏状态系统反例：`test/fixtures/hidden-state-world-adapter.mjs` 只向 Kernel 暴露一维 `value`，把 `hiddenMode` 和阶段机留在 WorldPort 内部；同一可见目标关系下，`advance` 实际产生 `-1/+1` 两种结果。跨两个独立 CLI Run 后，`beliefModels` 保留两种后验、外部效果不重复，两个 Run 均可 Replay 为 `CONSISTENT`。这证明的是当前信念记忆在该变化轴上没有把未知分支压成单一事实，不是隐藏状态识别或通用智能证明；
- 隐藏状态可辨识性边界：当两个隐藏动力学的公开输入完全相同时，Kernel 必须先做同一选择；只有收到不同的可验证结果后，经验模型和后续策略才允许分化。该不变量由 `test/kernel/belief-memory.test.mjs` 固化，防止把隐藏字段、模型猜测或领域标签冒充为事实；
- 跨进程反馈适应：`test/e2e/latent-choice-world.test.mjs` 将同一个隐藏 WorldPort 的 5 步拆成两个独立 CLI Run；前两步在两个隐藏动力学中保持同一选择，第一轮 verified feedback 持久化后，第二个进程的第三步才分化，两个 Run 均可独立 Replay。该证据支持“共同 Kernel Memory 已能形成有限策略改变”，因此没有另造一套候选策略学习器；它仍不证明隐藏状态完全辨识或长期自主性；
- 有界周期再验证：新 Lab 在 `Memory.lastVerifiedSteps` 保存每个不透明 Token 最近一次已验证的逻辑序号；已知安全动作超过 8 个已验证动作未复核时，Kernel 在没有未尝试动作的前提下优先重新取证，并在 `Expectation.verificationAge` 中留下可审计年龄。它能在受控动力学漂移中重新发现旧模型失效，但不等于感知隐藏变化、变化点检测或现实因果证明；v15 以前的 Replay 保持旧选择语义；
- 有界序列规划：`kernelLearningVersion: 17` 的 horizon 规划会把每个假设动作的预测变化写入临时、不可持久化的规划记忆，并在每个后续动作的已验证 belief 结果上继续有界分支，使已验证的历史上下文能影响后续假设动作；真实记忆仍只由 `verify → learn` 更新，v16 及以前的 Replay 显式保持非递归规划语义；
- 有界策略树规划：`kernelLearningVersion: 18` 在递归 belief 分支的每个未来状态内继续评估有界安全动作树，而不是只跟随一个贪心未来动作；v17 的 `recursive-v1` Replay 保持原有贪心未来策略，v18 新 STEP 使用 `tree-v1`，所有推演仍是临时模型计算，不获得额外执行权限；
- 有界历史上下文：在新 Lab 中，Kernel 还保存最近两个已验证的 `Token+actualDelta`，以领域中立的上下文签名条件化动作模型；历史探针结果可在可见状态恢复相同后改变下一步安全动作。上下文只来自已闭合证据，大小固定，旧 Lab 不注入该字段；这证明了有限历史条件化，不等于完整隐藏状态推断或长期规划；
- 历史顺序稳定：`kernelLearningVersion: 10` 的新 Lab 为动作分配单调序号，并在延迟 feedback 晚到时按动作发生顺序重排近期历史；反馈传输顺序不会改变上下文签名。带时钟的 Memory 还会拒绝重复、超前或缺失动作序号，避免不可能的持久状态重新引入顺序歧义。没有新时钟的旧 Lab 保持原有 Memory 形状和 Replay 语义；
- 可压缩长期上下文：`kernelLearningVersion: 11` 的新 Lab 另保存固定大小的顺序敏感 `historyAccumulator`。它按动作序号吸收已验证变化，允许延迟 feedback 补入旧位置而不依赖到达顺序；`recentHistory` 仍只用于可读的最近两条审计轨迹。预测同时尝试 h2 长期指纹和 h1 近期上下文，缺少 h2 样本时回退到 h1；由于 h2 是精确指纹，Kernel 只保留极小的长期模型缓存，避免连续运行把持久化快照膨胀成随历史线性增长。该机制支持有限的长程重复证据，但不等于无限语义记忆，仍受摘要碰撞和缓存容量约束；
- 有界记忆淘汰：`kernelLearningVersion: 19` 对关系模型、信念模型和历史上下文模型按稳定嵌套映射顺序淘汰最早项；连续世界产生无穷新关系或上下文时，Memory 保持固定上限而不会因缓存耗尽伪装成执行成功或改变账本语义。淘汰会降低可复用经验，不等于无限记忆、完美遗忘策略或现实适应能力；同一账本 Replay 按相同证据顺序重现同一淘汰结果；
- 全模型族有界淘汰：`kernelLearningVersion: 20` 也对 `actionModels` 和 `rejectionModels` 的新 Token 按稳定顶层映射顺序淘汰最早项；当连续 WorldPort 不断产生新的能力标识时，所有可增长的经验模型都保持固定上限，且被淘汰 Token 的新鲜度索引同步移除。不同模型族仍各自独立计数，淘汰只发生在纯 Memory 转移中，不改变权限、回执或真实世界状态；
- 模型年龄状态原子性：v21 的 `modelAge/modelAges` 只有在同一 Memory 同时带有 `modelClock` 时才是合法表示；缺少时钟的半版本状态会在 `step`/`learn` 入口 fail-closed，避免同一语义账本在后续容量淘汰中退回依赖 JSON 插入顺序；v20 及更早账本不携带年龄状态，继续使用各自历史语义；
- 证据新鲜度与淘汰一致：当 Token 的总体 `actionModel` 被容量淘汰、但关系/信念/历史上下文模型仍保留时，`lastVerifiedSteps` 继续绑定这些可复用证据；后续选择仍能进入周期再验证，而不是以 `verificationAge:null` 永久绕过变化检测。只有该 Token 已无其它可复用模型证据时，才清理新鲜度索引；
- 新鲜度索引无孤儿：关系、信念或历史上下文模型被单独淘汰后，Memory 克隆会按当前所有可复用模型重新校验 `lastVerifiedSteps`；没有任何可复用证据的 Token 不会留下无效新鲜度记录，避免索引与模型生命周期分叉；
- 共享持久化生存预算：v22 将事件上限（1 MiB）与 Kernel 的 Memory 预算（768 KiB）放进同一份 schema 契约；输出持久化 Memory 前，跨 action/rejection/relation/belief/context 模型按持久年龄统一淘汰，保留 STEP 证据包的序列化余量，并在淘汰后重建紧凑年龄索引。各模型族分别有数量上限并不等于整个 STEP 有界；该预算修复了多族同时增长导致真实 `LabStore` 追加失败的问题，但仍是确定性容量遗忘，不等于重要性学习或无限长期记忆；
- 学习版本兼容：新 STEP 由应用层明确写入 `kernelLearningVersion: 22`，Replay 将该版本传回 Kernel；因此 v22 才启用跨模型族共享持久化预算，v21 及更早账本继续保留原有模型年龄压缩和淘汰语义，避免升级代码重写合法历史状态。Kernel 对未知未来版本 fail-closed，而不是猜测其学习规则；
- 有界 WorldPort 边界标识：`stateVersion` 与 `intervalId` 仍保持不透明，不要求固定格式，但在进入 Kernel 和外部 adapter 归一化层时统一限制为 4096 字符；超过限制的版本不会先进入预测、执行或账本，避免把任意长标识延迟成 STEP 大小错误；
- 证据新鲜度淘汰：v23 将新 STEP 中 `modelAge` 的含义从“创建序号”升级为“最近一次已验证证据触碰序号”；被持续验证的 action/rejection/relation/belief/context 模型会获得新的统一年龄，跨模型族共享预算因此优先保留仍被现实证据使用的模型。v22 及更早 Replay 继续保持创建年龄语义；这仍是领域无关的 recency，不等于价值、因果可信度或重要性学习；
- 统一执行 nonce 边界：公共 schema 将 `executionNonce` 的 256 字符上限同时用于 Kernel feedback/pending/receipt 与外部 WorldPort 的 `usedExecutionNonces`，避免外部状态的 nonce 历史绕过 Kernel 限制后才在 STEP 落盘阶段超限；
- WorldPort 状态预算：公共 schema 将 1 MiB STEP 事件扣除 768 KiB Memory 后的剩余空间再分成两半，给当前 `worldState` 预留 128 KiB；内置 WorldPort 与外部 adapter 在状态入口使用同一上限，避免任意领域字段把失败推迟到 STEP 追加阶段；
- 外部输入证据预算：外部 adapter 的 `externalInputs` 在签名和数量校验后，还要共享 64 KiB 聚合持久化预算；这部分占用剩余 STEP 证据空间的一半，另一半留给回执、观测、验证和策略证据。超限输入在 transition 之前被拒绝，不把一个可验证但不可持久化的输入送进现实副作用边界；
- 外部输入规范化边界：单条 `externalInputs` 的摘要校验、签名校验和聚合计量共享 canonical JSON 异常边界；深度超过规范化器上限的证据统一成为 `WORLD_ADAPTER_PROTOCOL`，不让原始 `TypeError` 穿透为内部错误；
- 大压缩账本读路径：`readRun` 不再把整条已逐事件校验的历史重新拼成一个 canonical JSON 字符串；高度重复、物理压缩后仍在账本预算内的大阶段计划历史可以跨 Run 被 inspect 和恢复读取，不会因一次性克隆触发 `RangeError`；
- 撕裂尾行恢复：显式 recovery 对活动 Run 只接受“完整事件前缀 + 最后一条无换行尾部”的掉电形态，先同步截回最后一个完整换行，再写入唯一的 `CRASH_HALTED`；已终态账本、带换行的畸形 JSON 和超限尾部仍保持 `CORRUPT`；
- 可靠性支配式淘汰：v24 在共享预算压缩前，对同构预测模型按“样本数不少且不确定度不高”建立不可加权的支配关系；被另一模型全面支配的 action/relation/context 证据优先淘汰，剩余不可比较部分再按 v23 新鲜度确定性淘汰。v23 及更早 Replay 保持原语义；这仍不是价值函数、因果可信度或对环境变化的识别；
- 共享观测边界保护：v7 还会识别同一 `stateVersion + intervalId` 承载多个新 feedback 的情况，即使 adapter 把它们标为 clean，也全部记为 `AMBIGUOUS` 且不学习，避免一份无法分解的快照被复制到多个动作；旧 v6 账本按旧归因语义 Replay；
- 监督器证据对齐：`kernelLearningVersion: 9` 的新 STEP 当本步先结算了新的延迟 feedback 时，变化监督器不会把合并观测中的旧动作进步记成当前动作的确认进步；已结算收据仍按 nonce 学习，当前动作和目标监督各自保守处理；旧版本 Replay 保持原监督语义；
- 变化监督器：用同一套目标距离、确认进步、停滞、重规划和停止判定约束不同世界；状态随 STEP、快照、终态和恢复账本连续保存，跨进程 CLI 可继续运行；
- 连续 Runner：`agent loop` 把有限 STEP 批次串成多个已提交 Run；每个边界都可独立 Replay，进程重启后从同一个 current 继续；每个子 Run 的 `loopId/runIndex/scenario/budget/planningBranchingMode` 都写入 immutable start，使用 `--resume` 时从账本重建剩余预算和规划语义，不重复已提交 Run；旧 v17/v16 continuation 缺少该字段时从已提交 STEP 或终态 `externalTransition` 证据推断，无法推断则保守使用 legacy；
- `forever` 长运行边界：新 Run 在唯一 writer lock 内从 verified current 指向的最近 terminal Run 重建 continuation，不重复扫描全部历史；显式恢复和审计仍保留全量扫描，1000 个单步 Run 的连续运行回归已覆盖该边界；
- 显式自动恢复：`agent loop --resume --auto-recover` 只在 current 明确处于 `RUNNING` 且既有 writer owner 已被系统 liveness probe 判定死亡时执行恢复；活跃 owner 仍返回 `LIVE_OWNER`，READY/HALTED 或无法证明死亡的状态不会被自动接管，保留人工 recover 作为安全路径；两个独立 CLI 同时竞争同一未决非幂等 loop 时，恢复 writer lock、对账结果和后续 Run 仍保持单次提交与 Replay 一致；
- 进程级恢复回归：E2E 真实启动 CLI 子进程，在第二个模型请求挂起期间强制终止进程，显式回收死亡 owner 后继续下一 Run，验证 current 和 execution 链不回退；
- 多 WorldPort 耐久矩阵：`test/e2e/durability-matrix-cli.test.mjs` 用 `temperature`、`inventory`、`queue` 验证 kernel-only 连续多 Run、独立进程 inspect 和逐 Run Replay；用外部 `durable-counter` 验证效果已提交但响应丢失后的 recover、跨进程 resume、幂等效果计数和 Replay 不触发副作用；同一外部 loop 还连续经历四次独立 CLI 强杀、recover、resume，最终仍只提交四个效果；
- 跨 WorldPort 同构回归：独立外部 adapter 在坐标、状态表示和启动身份都不同的情况下，仍通过相同的应用闭环跨进程继续，并让两段 Run 的状态、记忆、监督器和 Replay 保持等价；另有文件持久化 adapter 覆盖多 Run 外部效果在响应丢失后的同 nonce 重试，验证外部效果只提交一次且 Replay 不触发副作用；
- 证据驱动策略变化：停滞不会只写一条日志，而会把领域无关的 `BALANCED/EXPLORATORY` 策略、版本、探索覆盖策略和原因持久化；新的 `coverage-v1` 在单步选择和有界规划的首步都先覆盖样本更少的安全候选，再在同样本数内按不确定度排序，避免高残差动作垄断探索；旧策略缺少该字段时仍按历史 `uncertainty-v1` 回放；
- 模型提议层：通过 OpenAI-compatible API 提出候选 Token；
- 有界感知上下文：WorldPort 的结构化 observation evidence 只经过大小/深度/数据类型边界后提供给 Advisor/Planner；Kernel 仍只接收数值观测，账本只保存上下文摘要，不把原始证据当作事实或执行权限；
- 模型故障隔离：Advisor 不可用、返回非法能力 Token 或破坏输出契约时，应用边界回退到 Kernel 的确定性选择，并把故障证据写入 STEP；不会因为模型暂时不可用而扩大权限，也不会让模型成为连续运行的单点故障；
- 安全边界：模型不能绕过 Kernel 直接执行动作；
- 确定性 Replay：回放使用已记录的模型提议摘要，不重新请求模型；
- Effect Broker：对明确声明的副作用提供计划、确认、执行、对账和补偿流程；
- EffectJournal：跨进程 append 使用原子 writer lock，并在锁内重读账本；stale-lock 回收另有固定 reclaim reservation，避免并发回收者互删或误删新 owner；副作用执行/对账/补偿期间持有可恢复的 nonce 级操作锁；Broker 还以全局日志头摘要做 CAS，陈旧状态不会重复提交语义转换；CLI 重启或并发调用不会各自基于陈旧 sequence 写入；
- Windows PowerShell CLI：所有核心实验可以脚本化运行。

### 内置世界的测试面

这些世界不是业务产品，而是用来攻击底座假设的测试面：

| 世界 | 观测向量 | 行动/边界 | 用来检验什么 |
| --- | --- | --- | --- |
| `temperature` | 1 维连续值 | 升温/降温、上下限 | 连续控制、数值预测和安全边界 |
| `virtual-desktop` | 5 维状态投影 | 普通对象/受保护对象 | 结构化状态、保护规则和只读对象 |
| `inventory` | 3 维资源状态 | 两种补货/履约、库存上限 | 多资源耦合、资源消耗和容量拒绝 |
| `grid` | 4 维位置/目标 | 四方向移动/禁止瞬移 | 离散空间、障碍物和动作集合变化 |
| `queue` | 3 维队列状态 | 服务/接入/禁止清空 | 排队动态、容量边界和外部到达 |

共同点不是领域名称，而是它们都只通过同一组 `WorldPort` 方法接入：`initialState`、`observe`、`actions(manifest,state?)`、`transition`。能力投影可以随当前状态变化，运行和 Replay 每一步都会重新获取；每个 STEP 还会保存动作后的 `boundary.afterCapabilities`，因此重启后的历史 `inspect` 不需要重新读取外部世界也能对应最终状态；外部 adapter 只有在 `hello` 显式声明 `supportsStateDependentActions:true` 时才会收到 `state`，旧 v1 adapter 仍收到原来的 payload。如果新增世界必须修改 Kernel 才能工作，就说明底座仍然夹带了领域假设。

## 用一个外部世界验证通用性

仓库提供了一个不依赖 `src/**` 的最小外部世界示例：`examples/counter-world/adapter.mjs`。它只有一个世界状态 `value` 和一个行动 `counter.increment`，通过 `yi-world-cli` JSONL 协议接入。这个例子故意不认识 Kernel 的实现，只负责回答 `hello`、`initialState`、`actions`、`observe`、`externalInputs` 和 `transition` 请求。若 adapter 连接真实副作用，必须额外实现持久 `executionNonce` 幂等记录；没有在 `hello` 声明 `supportsIdempotentTransitions:true` 或可选 `supportsReconciliation:true` 的 adapter 发生响应丢失后会被宿主阻断续跑，等待人工对账。声明对账能力的 adapter 还需回答 `reconcile` 请求：只有明确的 `APPLIED` 结果才可恢复，`ABSENT`/`UNKNOWN` 仍保持阻断。非幂等恢复 marker 还会固化原始 intent、能力投影和完整决策边界（目标/监督器/ValueSpec）；重启时不接受新的目标或规划输入，避免恢复动作与 Replay 边界漂移。恢复边界还会对 ValueSpec、监督器、目标激活计划和 Planner 证据做语义校验；摘要可重算但内容畸形时统一判为 `CORRUPT`。

在 Windows PowerShell 中运行：

```powershell
$exampleRoot = Join-Path $PWD 'counter-run'
powershell -ExecutionPolicy Bypass `
  -File .\examples\counter-world\run-example.ps1 `
  -RootPath $exampleRoot
```

上面的脚本会自动生成 adapter 配置，并真实启动多个 CLI 子进程完成 `init→run→inspect→replay`。如果希望逐条执行，也可以这样做：

```powershell
$adapterConfig = Join-Path $PWD 'counter-adapter.json'
powershell -ExecutionPolicy Bypass `
  -File .\examples\counter-world\make-adapter-config.ps1 `
  -OutputPath $adapterConfig
$adapterConfig = (Resolve-Path $adapterConfig).Path

yi-agent init `
  --lab E:\labs\counter `
  --world counter `
  --seed counter-seed `
  --adapter $adapterConfig `
  --json

yi-agent run `
  --lab E:\labs\counter `
  --steps 3 `
  --scenario steady `
  --adapter $adapterConfig `
  --json

yi-agent inspect --lab E:\labs\counter --adapter $adapterConfig --json
yi-agent replay --lab E:\labs\counter --run <runId> --adapter $adapterConfig --json
```

如果已经配置了 API，还可以把同一个外部世界交给模型提议层：

```powershell
yi-agent agent run `
  --lab E:\labs\counter `
  --steps 3 `
  --goal '让计数器稳定增长' `
  --adapter $adapterConfig `
  --json
```

这段示例的意义不是计数器本身，而是说明领域变化发生在 `WorldPort`，不是发生在 Kernel：换掉 `adapter.mjs` 的状态和行动，只要仍满足协议，CLI、账本、验证、学习和 Replay 可以保持不变。

### MVP-1：把真实仓库接入同一条闭环

`examples/repo-world/adapter.mjs` 是第一个 repo WorldPort 实验。它不修改 `src/**`，只把一个真实本地仓库映射成通用外部世界：观察包含有界文件树摘要，两个能力分别是读取一个配置的相对文件和运行一个配置的 Node 测试文件。它通过绝对子进程、`shell:false` 和路径/符号链接检查限制操作面；这是协议级只读约束，不等同于操作系统沙箱，生产环境仍应在独立低权限账户或容器中运行。

```powershell
$exampleRoot = Join-Path $PWD 'repo-run'
powershell -ExecutionPolicy Bypass `
  -File .\examples\repo-world\run-example.ps1 `
  -RepoPath $PWD `
  -RootPath $exampleRoot
```

该实验真实走 `ModelAdvisor（可选）→ Kernel → repo WorldPort → verify → ledger`，之后 `inspect` 读取已固化证据，`replay` 不重新启动 adapter。它的意义不是把“仓库”做成特殊业务，而是验证新的现实对象只需遵守共同的 `WorldPort` 边界，就能进入同一套观察、行动、验证、持久化和回放链路。当前 E2E 已补上连续 Run 外壳对照，以及第二个 Run 模型边界强制中断后的 `recover→resume→Replay`；仍未覆盖外部 transition 执行到一半崩溃后的非幂等对账，也不等于任意仓库的 OS 级安全隔离。

### 受控写入实验：把“改动被保留”接进闭环

只读 repo WorldPort 证明了“理解和验证”能进入账本，但还没有证明真实文件改动能安全跨过 `transition→verify→ledger→replay`。因此 adapter 另有显式的 writable 模式：在配置中追加补丁策略文件和 nonce 日志路径后，能力集合才增加 `repo.apply-patch`。策略文件只绑定目标相对路径和期望的修改前摘要；模型可以随 Token 一起提出有界 proposal，proposal 必须再次声明同一目标、修改前摘要和完整替换内容。adapter 会先把 `PREPARED` nonce 记录刷盘，再对普通文件做受控原子替换，最后追加 `APPLIED` 记录。修改前摘要不匹配、路径越界、符号链接、不同 nonce 重用或日志损坏都会拒绝。

这个能力只用于隔离实验仓库，不默认打开，也不代表已经获得真实项目写权限；生产写入仍需经过 EffectBroker、权限隔离、人工确认和回滚设计。本节点的 E2E 使用一个故意有 bug 的 `add` 函数：WorldPort 先通过 `repo.read-file` 向模型提供最多 2 KiB 的文件内容，再通过有界 observation evidence 提供目标路径、修改前摘要和 proposal 字段约束，依次选择“读文件→跑失败测试→应用模型 proposal→跑通过测试”，文件修改被保留，响应丢失后恢复只使用同一 nonce 的已提交回执，proposal 不会重复应用，Replay 不调用 adapter。重要的诚实边界是：这些策略 evidence 仍是不可信提示，模型 proposal 仍受实验策略限制，且只覆盖完整文件替换；这证明的是“模型候选修改可以进入共同底座并被独立边界验证”，不是“模型已经能自主生成、审查并安全修改任意真实项目”。

repo 补丁策略默认是 `fixed`：修改前摘要固定，外部文件漂移或下一次修改都会被拒绝。实验性 `beforeDigestMode: current` 必须由 patch spec 显式声明，此时每次 transition 都重新读取当前普通文件的 before 摘要，并保持 adapter descriptor/worldVersion 不变；它只解决“同一受控目标的连续候选修改”这一 WorldPort 状态演化问题，不扩大目标路径或写入权限。

每个模型候选还会由宿主按 `{token, proposal}` 生成稳定的 `candidateDigest`，并写入 policy evidence；账本和 Replay 会校验摘要确实对应候选内容。它只解决“同一个动作下不同候选不能互相混淆”的身份问题，不代表候选已经正确，也不代表 Kernel 已经学会跨候选泛化。

当候选进入 STEP 后，账本还会记录 `candidateOutcome`：候选是否被采用、WorldPort 回执状态，以及验证的误差、归因、置信度和是否可学习。Replay 会重新计算该结果；这为后续的候选历史和修复成本实验提供共同证据，但当前仍不会把它自动写入 Kernel 的动作模型。

`inspect` 会从当前实验空间已提交的终态 Run 中返回最近 32 条 `candidateHistory`，包含候选结果和有界 proposal 预览；模型提示也会接收同样的字段筛选摘要，并保留 `worldId/scenario/worldVersion/tokenMapDigest` 来源。历史投影会按 `{worldVersion,tokenMapDigest,scenario,candidateDigest}` 生成 `candidateScopeDigest`，并标记同一作用域内的 `attempt` 次数：同一候选重复出现是可见的尝试成本，而不同 WorldPort 即使 token/proposal 恰好相同也不会被合并。它还按 `{worldVersion,tokenMapDigest,scenario,observationDigest}` 生成 `decisionContextDigest`，标记同一可观测上下文中的 `contextAttempt`，用于比较不同候选；每条记录还携带连续 `kernelStep`，以及距上一候选的 `stepsSincePreviousCandidate`，这只是时间/工作量证据，不自动构成修复因果。系统同时提供派生的 `quality.errorMagnitude`（验证误差向量的平均绝对值）、`quality.verified`（可归因且可学习）以及 `distance-v2` 下的目标距离/进步字段，这些都是预测和目标几何线索，不是任务成功率。候选历史不跨 lab 空间聚合，避免把不同 WorldPort 的同名动作当成同一种语义；它还保留候选产生时的 `observationDigest`，便于后续判断是否处于同一可观测上下文。单个 proposal 预览最多 8 KiB，历史上下文最多 32 KiB，超出时保留摘要并标记截断。连续 loop 会在多个 Run 间复用这段有界尾部，重启时再从 immutable 账本恢复；这样历史是可读证据而不是隐含进程状态。它目前只辅助观察和模型排序，尚未参与 Kernel 的因果学习。

当前 E2E 还验证了一个最小因果边界：第一次独立 Run 在空历史下选择一个安全动作，第二次重启后的 Run 读取上一条候选结果并选择另一个安全动作；两次 Run 都能独立 Replay。这证明的是“历史可以影响后续提议”，不是“提议因此变得正确”。

F-88 增加了候选谱系的最小显式标记：模型可以返回 `supersedesCandidateDigest`，声明当前候选想修正哪一条历史候选；宿主只在同一 `worldVersion + tokenMapDigest + scenario` 且历史中确实存在该摘要时把引用写入 policy evidence 和 candidate history，跨 WorldPort 或不存在的引用会被丢弃。这个字段是“模型声明 + 宿主存在性确认”，不是因果证明、回滚记录或修复成功判定；真正的修复成本仍需独立对照实验和领域验证。

F-89 在接受谱系引用后派生 `stepsSinceSupersededCandidate`：它是被引用候选与当前候选之间的 `kernelStep` 间隔，只有同一 WorldPort 作用域且历史顺序、步数都有效时才生成。它比“上一候选步距”更接近一次候选修正的可审计工作窗口，但仍不是实际修复成本，也不说明中间步骤属于哪一个候选；该字段只进入历史和模型上下文，不进入 Kernel 学习或安全决策。

F-90 在同一条件成立时继续派生 `goalDistanceDeltaFromSuperseded` 与 `goalImprovedFromSuperseded`：Runtime 用两个候选各自的 `distance-v2` 目标后距离相减，正值表示当前候选在这套统一几何上更接近目标。缺少完整 ValueSpec、源候选或有效顺序时不生成；这是一种可复核的终态几何比较，不是独立领域判别器，也不是因果证明或任务成功率。

F-91 把候选比较推进到同初始状态配对：每条候选历史保留产生该 STEP 前的 `beforeStateDigest`，Runtime 只将同一 `worldVersion + tokenMapDigest + scenario + beforeStateDigest` 下最近的两个不同候选配对；两端必须有 `quality.verified=true`，优先比较统一 `distance-v2` 的 `goalDistanceAfter`，否则比较验证误差 `errorMagnitude`。结果记录 `metric/leftValue/rightValue/delta/verdict` 并进入模型有界上下文。它证明的是“匹配初始状态下的终态结果差异”，不是顺序执行的反事实、领域判别器或真实修复因果；没有同初始摘要或验证质量不足时不生成。

F-92 新增 `challenge --case paired-candidates`：先提交一个已验证父 Run，再把其连续性状态快照分别注入两个隔离 LabStore 分支，让两个分支在相同场景中执行不同候选；父实验不会被分支写入，两个分支各自保留完整账本并独立 Replay。这个挑战第一次把“同状态候选比较”从合成历史提升为真实运行证据，但分支目前属于 challenge 的隔离实验空间，实验结束后清理，不是生产 Lab 的持久分叉或外部副作用复制。

## 当前明确不是什么

当前版本还不是通用自主智能，也不会自动操作真实桌面、任意 Shell 或用户文件。它没有证明“智能已经出现”，只提供一个可以持续做实验、记录证据、制造反例和检查回放一致性的底座。

模型越强，不会自动让这个系统越可靠。模型只是提议器；真正需要继续建设的是：

- 更丰富但仍然可验证的观测和行动契约；
- 更接近现实的外部干扰、延迟和部分可观测环境；当前已能保存有界的后验分支信念，但它只表示可观察结果的不确定性，尚未解决真实隐藏状态的辨识、概率校准和多动作信用分配；
- 反馈缺失的有界闭环：新账本在有限观察机会后将无证据 pending credit 标记为 `UNRESOLVED/FEEDBACK_TIMEOUT`，不把缺失证据误学成因果；
- 让变化监督器从“自动开启下一变化周期”进一步成长为有证据的策略重规划；
- 独立的测试世界和判别器；
- 更严格的归因、信用分配和长期记忆机制；
- 在人工确认后，逐步扩展到真实副作用和桌面端。

## 与 Codex / Claude 的协作方式

这几个工具可以互补：

- 用 Codex 或 Claude 编写新的 `WorldPort`、测试用例和分析脚本；
- 用它们分析 `yi-agent` 生成的事件账本和反例；
- 让它们作为 `ModelAdvisor` 提出候选方案；
- 由 `yi-agent` 的 Kernel、WorldPort、verify 和 learn 决定方案是否真的改变系统状态。

也就是说，Codex / Claude 可以帮助我们建设实验世界，但不替代实验世界本身。

## 安装

需要 Node.js 22 或更高版本。PowerShell 中执行：

```powershell
npm install --global E:\demo\yi-agent
yi-agent --help
```

密钥只放在当前 PowerShell 会话的环境变量中：

```powershell
$env:YI_AGENT_API_KEY = "你的 API Key"
$env:YI_AGENT_API_BASE_URL = "https://api.openai.com/v1"
$env:YI_AGENT_MODEL = "你的模型名"
```

也可以用 `YI_AGENT_API_TIMEOUT_MS` 覆盖超时，范围为 1000–300000 毫秒，默认 60000 毫秒。

如果使用智谱 GLM Coding Plan，使用它的专用 Coding 端点：

```powershell
$env:YI_AGENT_PROVIDER = "zhipu-code"
$env:ZAI_API_KEY = "你的智谱 Coding Plan Key"
$env:YI_AGENT_MODEL = "glm-5.2"
yi-agent api test --json
```

`zhipu-code` 会自动使用 `https://open.bigmodel.cn/api/coding/paas/v4`；若同时设置 `YI_AGENT_API_KEY` 或 `YI_AGENT_API_BASE_URL`，显式设置优先。模型名以智谱账户当前可用模型为准。Coding Plan 的 OpenAI Chat Completion 端点与普通智谱 API 端点不同。

## 调用 API

```powershell
yi-agent api test --json
yi-agent ask --prompt "请用一句话解释什么是闭环" --json
yi-agent agent run --lab E:\labs\temperature --steps 3 --goal "保持系统稳定" --json
yi-agent agent loop --lab E:\labs\temperature --steps 10 --runs 100 --goal "保持系统稳定" --json
yi-agent agent run --lab E:\labs\temperature --steps 3 --kernel-only --json
yi-agent agent loop --lab E:\labs\temperature --resume --json
yi-agent agent run --lab E:\labs\temperature --steps 10 --goal-plan E:\plans\stability.json --json
yi-agent agent run --lab E:\labs\temperature --steps 10 --goal "自动维持温度" --auto-plan --json
yi-agent agent run --lab E:\labs\temperature --steps 10 --planning-horizon 3 --kernel-only --json
Get-Content .\prompt.txt -Raw | yi-agent ask --prompt - --json
yi-agent ask --prompt-file E:\path\to\prompt.txt --json
```

`api test` 只报告连通状态和模型数量，不会输出 API Key。`ask` 的成功结果和失败结果都使用单行 JSON envelope，便于 PowerShell 或脚本继续处理。

`agent run` 会在每一步把当前观测和可用能力交给模型提出一个 token，再由 Kernel 独立计算预期、复核安全性、执行、验证和学习。模型不能直接执行动作；每一步只保存结构化提议摘要，`replay` 不会再次调用模型。

如果 Advisor 的 API 超时、断开或返回非法 Token，应用边界会记录 `MODEL_UNAVAILABLE` 或 `INVALID_ADVISOR_RESULT`，然后让 Kernel 在同一状态上选择安全候选继续闭环；该回退也会进入账本，因此重启和 `replay` 不依赖模型再次返回相同结果。

`--kernel-only` 显式关闭 Advisor/Planner，只运行共同的 Kernel—WorldPort—verify—learn 闭环，不需要 API Key；它用于证明模型是可替换工具，而不是 Agent 的启动前提。若需要 `--auto-plan`，仍应提供模型配置，或接受 Planner 不可用并回退为根目标阶段。

`agent loop` 是连续运行的 CLI 入口：`--steps` 表示每个可恢复 Run 的步数，`--runs` 表示最多串联多少个 Run；需要长期守护时使用 `--forever`，它与 `--runs` 互斥。每个 Run 都先完成自己的账本提交，再开始下一个 Run；收到 SIGINT/SIGTERM 时只在当前 Run 提交后停止，返回 `INTERRUPTED`。loop 的 `loopId/runIndex/scenario/budget/planningBranchingMode` 会固化到每个 immutable `start.json`，进程重启并完成恢复卡点后，可以用 `yi-agent agent loop --lab PATH --resume --json` 从 current 指向的已校验终态 Run 重建剩余 Run 和规划语义，不必重新输入也不会重复已提交 Run；旧 continuation 缺少模式字段时，Runtime 从已提交 STEP 或终态 `externalTransition` 证据推断历史模式，不能推断则保守降级为 legacy。同一 lab 中，一条未完成 continuation 对实验空间拥有唯一调度权；新的 loop 或普通 run 会被拒绝，必须先用 `--resume` 接续，已完成或已停止的历史 loop 不阻塞新实验。发生执行拒绝、无安全动作或显式目标达成时，循环会停止并返回原因。`--forever` 的内存结果摘要只保留最近一个 Run，累计 `runs/metrics` 持续统计，完整历史以 lab 账本和独立 Replay 为准，因此不会随运行时间积累结果对象。进程在一个 Run 内被终止或崩溃时，仍须先用 `recover --confirm-lock-owner-dead` 完成明确的恢复卡点，再使用 `--resume` 继续；若未决外部 transition 已保存原始策略证据，恢复进程暂时没有 API 时也能复用该证据并由 Kernel 继续安全选择；`readLoopContinuation()` 仍提供全量 continuation 审计，`test/e2e/crash-restart-cli.test.mjs` 已用真实子进程强制终止覆盖该路径。
如果明确选择自动路径，可使用 `yi-agent agent loop --lab PATH --resume --auto-recover --json`；它只自动处理 current 为 `RUNNING` 且 liveness probe 证明旧 owner 已死亡的本地恢复，不会绕过活跃进程保护，也不把无法确认的锁当作安全可接管。

连续 Runner 默认使用 `checkpoint` 持久化：STEP 仍逐条写入完整证据账本，在每 128 步及终态前执行 data-sync；需要每一步都完成物理同步时，应用层可传 `durability: 'strict'`。CLI 的普通 `run` 保持 strict 语义，`agent loop` 采用 checkpoint 语义。

## 独立晚绑定 Oracle

仓库内的性质测试只能证明候选代码在已知测试装置上没有发现反例。更强的检查应由候选仓库之外的 Tester 完成：它只依赖 Kernel 公共入口，运行在独立 Node 进程中，在执行前生成未知维度、未知不透明 Token、随机有限模型和置换关系，并检查 `step → verify → learn` 是否保持同构。

当前开发环境的 Oracle 位于仓库外的 `E:\demo\yi-agent-oracle\late-bound-oracle.mjs`，可在 PowerShell 中运行：

```powershell
node E:\demo\yi-agent-oracle\late-bound-oracle.mjs `
  --candidate-root E:\demo\yi-agent
```

输出是单行 JSON，包含 `candidateDigest`、`oracleRevision`、`generatedWorldCount`、`caseCount`、`verdict` 和 `failures`。将第一次输出的摘要作为 `--expected-candidate-digest` 再运行，可以确认验证结果绑定到本次候选源码；摘要不匹配时只返回 `INCONCLUSIVE`，不会误报通过。当前本机证据为 48/48 通过。该 Oracle 是本地外部验证工件，不随候选仓库提交；它证明的是本轮公共 Kernel 关系未被这组未知输入证伪，不等于通用智能或独立组织审计。

当监督器检测到达到停滞阈值，它会把 `replanCount`、`strategy.revision`、策略模式和 `replanReason` 写进 STEP 的 `afterState`。`EXPLORATORY` 只改变安全候选的选择顺序，不能改变目标、权限、WorldPort 回执或验证规则；Replay 会重现同一次策略切换。若启用了持久化 Planner 策略，停滞还会把新的有限计划写入同一步的 `boundary.goalReplan`：已完成阶段不可改写，只能修订未完成后缀；Planner 不可用或提议不合法时，保留原计划并记录拒绝证据。

Memory 现在同时保留四类基础模型和多尺度有界历史：`actionModels` 记录 Token 的总体变化，`relationModels` 记录同一 Token 在观测相对当前目标的关系签名（每个维度为接近、相等或远离）下的变化，`rejectionModels` 记录同一 Token 在最近关系位置是否遭到执行拒绝，`beliefModels` 保存同一条件下最近最多 8 个已验证后验变化样本，`contextModels` 同时承载 h1 最近两个已验证 `Token+actualDelta` 的可复用上下文与 h2 顺序累积指纹的精确证据；新 Memory 用 `historyClock` 和动作序号保持延迟反馈下的真实发生顺序。Kernel 按 h2→h1→关系→总体模型回退；信念样本不宣称知道隐藏状态，只在分支离散时提高不确定性惩罚，从而避免把均值误当成唯一现实；拒绝反馈只在同一关系签名下暂时降权，关系改变或所有候选都被拒绝时仍允许重新验证。上下文和关系签名都只由不透明 Token、数值观测、ValueSpec 与已验证变化构成，不读取领域名称；长期指纹缓存和其他窗口均有界，旧账本没有新字段时仍按旧模型 Replay。

当模型族达到容量上限时，`kernelLearningVersion: 21` 在 Memory 中为每个新模型分配单调的 `modelAge`，并用一个共享 `modelClock` 记录创建序列；淘汰按最小年龄、再按规范化身份排序，因此同一 Memory 仅改变 JSON 键顺序也会得到同一结果。完整的路径顺序表曾能表达这个语义，但在 10,000 步连续 ledger 实测中超过固定 32MB 上限，已被舍弃；年龄字段只增加常量级状态。v20 及更早账本继续使用其原有的稳定映射顺序，避免重写历史。这个机制仍是确定性容量遗忘，不是重要性学习或语义压缩。

v24 在共享预算压缩时增加 `pareto-v1` 保留策略：对结构相同的预测模型只比较已存在的 `sampleCount` 与 `uncertainty`，不发明跨金融、医疗或组织管理的权重；若另一条证据样本不少且误差不高，当前模型就是被支配者，会先进入淘汰队列，队列内部仍按规范化身份和年龄保持确定性。拒绝模型和信念样本暂不与预测模型硬比较。这个偏序能保护“高支持、低误差”的非支配模型，但最近的低质量证据可能同样是环境变化的第一信号，非支配候选之间也没有唯一正确的取舍；所以 v24 是可证伪的保留启发，不宣称已经解决重要性、漂移检测或长期记忆。

WorldPort 状态不是“只要是对象就无限容纳”。公共 `MAX_PERSISTED_WORLD_STATE_BYTES` 当前为 128 KiB：它来自 1 MiB STEP 上限减去 768 KiB Memory 预算后的剩余空间，再保留一半给回执、前后观测和其它证据。内置 `createWorldPort` 与外部 adapter 归一化入口都执行该限制，超限状态会在进入账本前明确失败。这个边界保证的是可持久化性，不是对领域状态的语义压缩；需要更大状态时必须设计快照/引用/分片契约，而不能悄悄放宽单个 STEP。

外部 `externalInputs` 也不是“签名合法就可以无限进入 STEP”。公共 `MAX_PERSISTED_EXTERNAL_INPUT_BYTES` 当前为 64 KiB，按规范 JSON 对整个输入数组计量，而不是只限制条目数量或单个字符串。它在 adapter 返回后、`transition` 调用前执行；因此超限输入不会触发外部动作。这个预算仍是当前 STEP 包的容量分配，不是领域数据大小的普适答案；更大的外部事实必须改成快照、引用或分片协议，并重新定义签名、幂等和 Replay 绑定。

外部输入的规范化也是协议边界的一部分：摘要校验、签名校验和最终聚合计量遇到超深或不可表示的 JSON 时，都必须返回带上下文的 `WORLD_ADAPTER_PROTOCOL`，不能把 adapter 提供的畸形证据升级成宿主内部异常。

账本的“每行有界”和“文件有界”并不自动保证读取安全。大阶段计划可以高度重复，写入时经 deflate 后占用很小，但读取时每个 STEP 仍要还原完整计划；旧的 `readRun` 又对整个事件数组执行一次 canonical JSON 克隆，最终在约 1000 个合法 STEP 历史上触发 `RangeError`。现在事件已在 `readLedger` 中逐条解析、校验和解压，`readRun` 直接返回这批新解析的事件，避免额外的全量字符串峰值；回归覆盖跨 Run 的大压缩计划 inspect。该修复只消除不必要的聚合复制，不把账本变成无限历史；未来若要承载更大的历史，仍需分页/流式 Replay 契约。

掉电可能发生在 JSONL 最后一行写了一半、但前面事件已经完整持久化之后。普通 inspect 仍以 current 的固定 watermark 只读前缀；显式 recovery 现在仅对活动、未终态 Run 识别这一种物理尾部形态，并把文件同步截回最后一个换行，再沿同一哈希链追加 `CRASH_HALTED`。这不是对语义损坏的宽松：有换行但 JSON/摘要/序列错误的证据，以及终态之后出现的尾部，仍会进入 `CORRUPT`。该边界保证的是可恢复的写入撕裂，不等于文件系统已经提供跨平台掉电原子性；父目录刷盘和分布式存储仍需单独验证。

目标评价现在也固定在同一底层几何上：新 Run 的 `valueMode=distance-v2` 用每个观测维度到目标的带权绝对距离打分，`tolerance` 把目标从一个点扩展为可接受带；因此越过目标不会被错误奖励，带内状态可被视为满足该维度。`valueMode` 不进入领域逻辑，旧 STEP 缺少它时 Replay 保持 `signed-v1`，避免演化破坏历史连续性。

在已有关系记忆的基础上，Kernel 现在支持有界的多步模型推演：`--planning-horizon N`（1～8，默认 1）会在没有未尝试安全动作时，用当前已验证的 `actionModels`/`relationModels` 预测有限步，并选择终点价值更高的首个动作；`kernelLearningVersion: 14` 还会在某个候选已有最多 8 个已验证 belief samples 时，只对第一步按这些结果分支，并且只有分支后的下一步价值相关预期变化真正不同，才把“下一决策的不确定性下降”计入信息价值，因此安全的探测动作可以在眼前收益较低时仍被选中；v17 将 belief 分支延伸到后续动作，但未来节点仍跟随一个贪心策略；v18 的 `tree-v1` 再在固定预算内评估未来安全动作树，能识别“眼前略差但后续可达目标”的策略反例。没有 samples 时严格退化为对应版本的均值规划，v17 及以前的账本 Replay 保持各自历史策略语义；不会把推演状态当成现实状态，也不会让未来猜测越过当前 WorldPort 的安全边界；每一步仍须重新观测、筛选、执行、验证和学习。为使底座随 WorldPort 数量增长仍可运行，规划使用固定候选窗口和固定分支上限，未来模拟不重复展开全量能力。推演参数写入 STEP boundary、loop continuation 和外部 transition 的恢复标记，因此重启、跨 Run、幂等重试和 Replay 使用同一规则。它仍不是可达性证明、全局规划、概率校准或现实因果模型，后续必须用更多未知 WorldPort 反例校准。

复杂目标可以通过 `--goal-plan PATH` 提供阶段序列。每个阶段只声明不透明的阶段 ID、阶段目标文本和可选 `ValueSpec`；运行时仍用同一套观察向量、加权距离、证据和安全约束推进阶段，阶段完成后才切换到下一个阶段。计划会进入 supervisor/current/STEP，Replay 不会重新询问模型或读取计划文件；已激活的计划不能在同一个 lab 中被静默替换。

需要让模型提出阶段序列时，可使用 `--goal TEXT --auto-plan`。Planner 只能返回阶段目标向量，宿主会继承当前 WorldPort 的维度和权重并进行有限性、边界和阶段顺序校验；非法或不可用提议退回单一根目标阶段，不会改变权限、Token 或执行规则。首次激活时，已校验计划和 `planEvidence` 一起写入 STEP；之后的普通 Run、进程重启和 Replay 都使用账本中的计划，不重复请求 Planner。只有持久化的停滞策略触发未完成计划修订，且修订计划同样进入 STEP 并由 Replay 冻结重演。`--auto-plan` 与 `--goal-plan` 互斥。

当前 CLI 不会替你保存密钥；真实连通性需要你在本机配置上述环境变量后执行 `yi-agent api test`。模型调用只负责提出候选 Token，仍由 WorldPort、Kernel、verify、learn 和 replay 闭环裁决。

运行时锁的所有权检查把文件身份与内容完整性分开：活跃 Run 只依赖稳定的 `dev+ino` 文件身份，并在每次写入前重新验证锁 JSON 的自摘要；因此备份/杀软改变锁时间戳不会误杀活跃 Run，而原地改写锁内容仍会 fail-closed。这个边界减少的是本地锁误报，不解决 Windows PID 复用或分布式文件系统语义。

F-93 将 F-92 的隔离分支挑战提升为可持久化 CLI 实验：父 Lab 完成一个终态 Run 后，可以让两个不同候选从同一父连续性状态分别运行，并把实验元数据写入输出目录的 `pair.start.json`、`pair.end.json`。父 Lab 不被修改；左右分支各自拥有普通的 manifest/current/events 账本，最终同时 Replay 为 `CONSISTENT` 后才会生成 PASS 终态。若进程在左分支完成后中断，输出目录保留不可变 start 证据，重新执行 `experiment pair --resume` 会只补齐缺失分支，不重复已提交 Run。

示例（PowerShell）：

```powershell
yi-agent experiment pair `
  --lab E:\labs\temperature `
  --output E:\labs\temperature-pair-001 `
  --left-token tok_XXXXXXXX `
  --right-token tok_YYYYYYYY `
  --scenario regime-shift `
  --json
yi-agent experiment pair --lab E:\labs\temperature --output E:\labs\temperature-pair-001 --resume --json
```

这是共同底层变化逻辑的实验工具：候选只是不透明 Token，比较必须绑定相同 WorldPort 身份、Token map、scenario 和 before 状态摘要。当前故意只允许内置纯模拟 WorldPort；外部设备、文件、金融或医疗副作用不能通过复制 JSON 被假定为可安全分叉，必须先有幂等、隔离、对账和人工确认契约。该能力验证的是可恢复的反事实实验基础，不是已经实现长期自主智能。

F-94 进一步把完成结果的引用也纳入完整性边界：`pair.end.json` 保存左右分支的 manifest/current 摘要。对已完成实验再次执行 `--resume` 时，CLI 会重新打开两个分支并做只读 Replay；如果分支账本、WorldPort identity、路径或 runId 已经漂移，不会返回旧的 PASS，而是返回 `CORRUPT` 并指出具体分支。旧版缺少分支摘要的 end 仍可读取，但同样必须通过真实 Replay 复核。

F-95 把单步配对推进为有界多步轨迹实验：`experiment trajectory` 接收两个 `candidate-trajectory` JSON 文件，每条包含 1～8 个父 Token。左右分支从同一父连续性状态开始，每一步都是独立持久化 Run（`run-1`…），中断后 `--resume` 只补齐尚未提交的步；最终必须逐 Run Replay 一致，才按同一 `distance-v2`/误差几何比较终态。该轨迹是 open-loop Token 序列，不是运行中根据新观测自适应的策略；它用于测量“连续动作序列是否比另一序列更接近目标”，仍不等于长期自主智能。

轨迹文件格式：

```json
{"schemaVersion":1,"type":"candidate-trajectory","tokens":["tok_XXXXXXXX","tok_XXXXXXXX"]}
```

```powershell
yi-agent experiment trajectory `
  --lab E:\labs\temperature `
  --output E:\labs\temperature-trajectory-001 `
  --left-trajectory E:\labs\left.json `
  --right-trajectory E:\labs\right.json `
  --scenario steady `
  --json
yi-agent experiment trajectory --lab E:\labs\temperature --output E:\labs\temperature-trajectory-001 --resume --json
```

F-96 增加 `experiment policy`，用 `candidate-policy` 文件表达一个受限的闭环策略：默认 Token 加上最多 8 条 `{observationDigest,token}` 规则。每个分支的每一步都会重新观察 WorldPort，再由规则选择 Token；实际选择、策略摘要和终态证据都进入可恢复实验。策略文件只允许引用父 Token map 中的能力，不允许携带代码、领域字段或新的权限。

```json
{"schemaVersion":1,"type":"candidate-policy","version":1,"defaultToken":"tok_XXXXXXXX","rules":[{"observationDigest":"sha256:...","token":"tok_YYYYYYYY"}]}
```

该实验验证的是“同一底层观察边界下，策略能否根据新观测作出可审计、可重放的下一步选择”。它不是模型训练，也不是自动发现规则：规则仍由实验输入给出；如果两策略行为相同，结果仍会记录相同轨迹证据而不宣称能力差异。外部现实 WorldPort 仍禁止直接分叉。
