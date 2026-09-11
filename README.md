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

- 纯 Kernel：数值观测、ValueSpec、不透明 Action Token、确定性随机状态；新运行默认使用带权绝对距离和 `tolerance` 可接受目标带，也可由 WorldPort 显式选择公共的 `signed-v1` 效用方向；值模式会进入 STEP 边界并按原语义重放；
- `WorldPort`：五个内置世界覆盖连续控制、受保护对象、多资源库存、离散网格和排队系统；
- WorldPort 身份绑定：新实验把 `worldVersion` 与 `worldImplementationDigest` 写入不可变 manifest；继续运行、重启恢复和 Replay 都校验当前实现仍对应同一世界语义；没有这些字段的历史实验仅按 legacy 兼容路径读取，不宣称具备这项保证；内置摘要绑定具体 WorldPort 源码、共享 `world-port-base` 和定义元数据，不把无关世界的注册表变更误算成当前世界漂移；实现材料发生变化时必须更新摘要，摘要是发布边界的身份锚点，不是对任意不诚实注册表的数学证明；
- 可插拔外部世界：通过受控 JSONL 子进程协议接入；传输层只接受与请求 ID、协议版本严格匹配的单条响应，半帧、重复帧、stdout 污染和错误响应都会在写入 STEP 前 fail-closed；stderr 诊断和 Windows CRLF 不改变协议结果；
- 外部版本不透明：`stateVersion`/`intervalId` 只作为 WorldPort 提供的边界标识，宿主不再强制它们包含 world id 或采用某种字符串格式；连续性仍由 revision、nonce 窗口和前后状态绑定校验；
- 可审计运行时：事件账本、快照、锁、恢复和哈希链；
- 证据闭环：行动前预期、行动回执、复观、验证、学习；
- 延迟反馈归因：对已接受但尚未完成归因窗口的动作，按 executionNonce 持久保存有界 pending credit；后续 WorldPort 可返回匹配反馈，Kernel 只在证据闭合后学习，混杂反馈不会污染动作模型；该机制已用跨独立 CLI 进程、跨 Run 和 Replay 的外部 WorldPort 回归验证；
- 反馈投递幂等：在有界已结算收据窗口内，完全相同的重复 feedback 可跨 Run/进程安全忽略；同 nonce 的不同内容仍会 fail-closed，避免把消息重放或篡改变成新的学习样本；
- 显式动作链信用（`kernelLearningVersion: 29`）：WorldPort 可在单条 clean feedback 上声明 `creditChain:{schemaVersion:1,members:[{executionNonce,share}]}`，Kernel 要求链以反馈 nonce 为锚、成员按 pending 顺序排列、全部仍在 pending、份额闭合为 1 且不与同批反馈重叠；它把锚点动作前到反馈快照的净变化按份额分配给整条动作链，输出 `ACTION_CHAIN` 并随 Replay 重建。缺成员、重复/乱序、份额不闭合、混杂或共享观测边界均 fail-closed/不学习；这只是 WorldPort 的结构化因果声明，不是 Kernel 对真实因果的自证，旧 feedback 仍按 v28 及更早语义运行；
- 受控加性因果证据（`kernelLearningVersion: 30`）：`creditChain` 可选择 `basis:"counterfactual-additive-v1"`，每个成员提供孤立干预的 `delta` 向量；Kernel 只在所有成员 delta 之和与锚点到反馈的实际变化严格闭合时学习，缺失/维度错误/不闭合时消费反馈但全部标记 `AMBIGUOUS`，不把无法解释的交互项分摊给动作。它校验的是可审计的加性证据边界，不是对外部 WorldPort 真实性的自证；v29 的 share 链和更早账本保持原语义；
- 描述符绑定的因果证据（`kernelLearningVersion: 31`）：`creditChain` 可选择 `basis:"counterfactual-attested-v1"`，由当前 WorldPort 描述符中的 Ed25519 公钥验签完整反馈快照、成员 delta 和摘要；篡改、跨描述符搬运或快照错配均在外部边界 fail-closed，合法签名才进入 v30 的加性闭合结算。签名证明的是 adapter 对“声明了什么”的来源绑定，不是现实干预或因果真值；v30/v29 历史语义保持兼容；
- 独立因果见证（`kernelLearningVersion: 32`）：`creditChain` 可选择 `basis:"counterfactual-independent-v1"`，主 WorldPort 先以自身 Ed25519 公钥绑定反馈与成员 delta，宿主再通过配置中独立启动的 witness adapter 请求只含反馈元数据和成员 nonce 的见证；见证以不同 Ed25519 公钥签名，宿主比较完整成员 delta 后才把 `independentAttestation` 注入账链，Kernel 再复用 v30 的逐维闭合。见证不一致、缺失或验签失败均 fail-closed；这建立的是可部署的第二证据来源，不等于现实因果真值，仍不能抵御共谋或同一物理来源；v31/v30/v29 历史语义保持兼容；
- 反馈顺序规范化：同一批合法的 nonce-bound feedback 无论由不同 WorldPort 按何种传输顺序返回，Kernel 都按 pending credit 的持久顺序结算，保持 `settled`、已结算收据和信念样本跨进程/Replay 一致；这不等于允许多个动作同时生效，无法归属的重叠变化仍必须由 WorldPort 标记为混杂；
- 隐藏状态系统反例：`test/fixtures/hidden-state-world-adapter.mjs` 只向 Kernel 暴露一维 `value`，把 `hiddenMode` 和阶段机留在 WorldPort 内部；同一可见目标关系下，`advance` 实际产生 `-1/+1` 两种结果。跨两个独立 CLI Run 后，`beliefModels` 保留两种后验、外部效果不重复，两个 Run 均可 Replay 为 `CONSISTENT`。这证明的是当前信念记忆在该变化轴上没有把未知分支压成单一事实，不是隐藏状态识别或通用智能证明；
- 隐藏状态可辨识性边界：当两个隐藏动力学的公开输入完全相同时，Kernel 必须先做同一选择；只有收到不同的可验证结果后，经验模型和后续策略才允许分化。该不变量由 `test/kernel/belief-memory.test.mjs` 固化，防止把隐藏字段、模型猜测或领域标签冒充为事实；
- 跨进程反馈适应：`test/e2e/latent-choice-world.test.mjs` 将同一个隐藏 WorldPort 的 5 步拆成两个独立 CLI Run；前两步在两个隐藏动力学中保持同一选择，第一轮 verified feedback 持久化后，第二个进程的第三步才分化，两个 Run 均可独立 Replay。该证据支持“共同 Kernel Memory 已能形成有限策略改变”，因此没有另造一套候选策略学习器；它仍不证明隐藏状态完全辨识或长期自主性；
- 有界周期再验证：新 Lab 在 `Memory.lastVerifiedSteps` 保存每个不透明 Token 最近一次已验证的逻辑序号；已知安全动作超过 8 个已验证动作未复核时，Kernel 在没有未尝试动作的前提下优先重新取证，并在 `Expectation.verificationAge` 中留下可审计年龄。它能在受控动力学漂移中重新发现旧模型失效，但不等于感知隐藏变化、变化点检测或现实因果证明；v15 以前的 Replay 保持旧选择语义；
- 漂移后的再组织：`test/e2e/drifting-choice-world.test.mjs` 进一步确认再验证发现旧动作从 `+4` 变为 `-2` 后，下一步会切换到另一安全 Token 并恢复 `+1`，且整个过程跨 CLI Run、外部效果与 Replay 保持一致。这个“反证旧模型→重新选择”仍是固定窗口的有限适应，不是变化点检测或开放世界预测；
- 不确定反馈的保守边界：跨独立 CLI/WorldPort 进程以相反顺序返回同一共享观测边界的多个 feedback 时，Memory 与监督器状态保持一致；反馈被结算为 `AMBIGUOUS`，不生成 action model，也不伪造 `confirmed/improved`。连续停滞仍可触发显式有界 `REPLAN`，但重规划事件不等于反馈已证实；
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
- 恢复要求持久化：以 `agent loop --require-recovery` 启动的 continuation 会把要求写入每个 Run 的 immutable start 和 loop contract；后续 `--resume` 即使省略参数，也会在第一个恢复 Run 前重新检查外部 adapter，避免恢复策略因换进程或漏传参数而降级；旧 continuation 没有该字段时保持兼容，不自动补写；
- `forever` 长运行边界：新 Run 在唯一 writer lock 内从 verified current 指向的最近 terminal Run 重建 continuation，不重复扫描全部历史；显式恢复和审计仍保留全量扫描，1000 个单步 Run 的连续运行回归已覆盖该边界；
- 当前 loop 恢复的流式边界：`--resume` 读取 current 指向的 Run 时也逐事件校验，只保留 immutable start、terminal 和规划模式摘要；现代 continuation 不再为恢复物化完整事件数组，旧 continuation 仍在需要历史推断时扫描全部轻量摘要，兼容 `end.json` 终态一致性检查；
- 未决外部事务索引有界化：恢复扫描先完整校验并收集未决 terminal，只有确实存在带恢复证据的未决项时，第二遍才匹配相关 STEP 身份；正常历史不再为每个已提交 STEP 建立永久增长的 commitment 集合，非幂等恢复与后续同 nonce 提交的判断保持不变；
- 候选历史外部排序：候选恢复按固定大小排序块写入临时目录，再归并为时间有序输入并增量生成历史注释，最终只保留请求的尾部窗口；长账本不再同时驻留全部候选载荷，流式路径还只保留尾部所涉及的 attempt、supersedes 和 paired comparison 索引；
- 显式自动恢复：`agent loop --resume --auto-recover` 只在 current 明确处于 `RUNNING` 且既有 writer owner 已被系统 liveness probe 判定死亡时执行恢复；活跃 owner 仍返回 `LIVE_OWNER`，READY/HALTED 或无法证明死亡的状态不会被自动接管，保留人工 recover 作为安全路径；两个独立 CLI 同时竞争同一未决非幂等 loop 时，恢复 writer lock、对账结果和后续 Run 仍保持单次提交与 Replay 一致；
- 进程级恢复回归：E2E 真实启动 CLI 子进程，在第二个模型请求挂起期间强制终止进程，显式回收死亡 owner 后继续下一 Run，验证 current 和 execution 链不回退；
- 多 WorldPort 耐久矩阵：`test/e2e/durability-matrix-cli.test.mjs` 用 `temperature`、`inventory`、`queue` 验证 kernel-only 连续多 Run、独立进程 inspect 和逐 Run Replay；用外部 `durable-counter` 验证效果已提交但响应丢失后的 recover、跨进程 resume、幂等效果计数和 Replay 不触发副作用；同一外部 loop 还连续经历四次独立 CLI 强杀、recover、resume，最终仍只提交四个效果；
- 跨 WorldPort 同构回归：独立外部 adapter 在坐标、状态表示和启动身份都不同的情况下，仍通过相同的应用闭环跨进程继续，并让两段 Run 的状态、记忆、监督器和 Replay 保持等价；另有文件持久化 adapter 覆盖多 Run 外部效果在响应丢失后的同 nonce 重试，验证外部效果只提交一次且 Replay 不触发副作用；
- 证据驱动策略变化：停滞不会只写一条日志，而会把领域无关的 `BALANCED/EXPLORATORY` 策略、版本、探索覆盖策略和原因持久化；新的 `coverage-v1` 在单步选择和有界规划的首步都先覆盖样本更少的安全候选，再在同样本数内按不确定度排序，避免高残差动作垄断探索；旧策略缺少该字段时仍按历史 `uncertainty-v1` 回放；
- 模型提议层：通过 OpenAI-compatible API 提出候选 Token；
- 模型证据不自证：`policyEvidence.observationDigest` 由 Application 按真实本步观测重新计算，模型自报的摘要不会成为事实；模型仍只提供候选 Token、回答摘要和可选 proposal；
- 规划证据不自证：`goalActivation/goalReplan.planEvidence.observationDigest` 同样由 Application 按 Planner 实际收到的有界观测上下文重新计算；非法计划或 Planner 故障不会获得伪造的观测来源；
- 模型输入隔离：传给 Planner/Advisor 的观测、Memory、ValueSpec、能力和 manifest 都是闭环内部状态的副本；模型回调即使原地改写输入，也不能改变 Kernel 选择、权限或账本连续性；
- 模型回调截止时间：Application 对 Planner/Advisor 统一施加有界等待，默认 60 秒；CLI 沿用 `YI_AGENT_API_TIMEOUT_MS`，超时分别记录 `MODEL_TIMEOUT`/`PLANNER_TIMEOUT` 并回退到可验证 Kernel 路径，连续 Runner 不会因一个永不返回的模型永久占住 Run；该截止时间只停止宿主等待，不等于能取消任意进程内回调，真正不可信插件仍需进程级隔离；
- 合作式模型取消：截止时间会通过回调第二参数传递 `AbortSignal`，内置 Advisor/Planner 继续把它交给 OpenAI-compatible HTTP 请求；因此可合作的模型调用会主动释放网络等待，忽略信号的任意进程内回调仍受前一条“只停止宿主等待”的边界约束；
- 取消来源可审计：HTTP client 将调用方主动取消报告为 `API_CANCELLED`，将自身请求截止报告为 `API_ERROR`；两者都不会把模型回答伪装成成功，Application 自身的模型截止仍记录为 `MODEL_TIMEOUT`/`PLANNER_TIMEOUT`；
- 首次中止来源锁定：同一请求若内部截止先发生、底层稍后才拒绝且调用方又迟到取消，仍保持最先发生的 `API_ERROR` 归因，不让后续信号改写历史事实；
- Provider 错误脱敏：非 2xx 响应中的错误文本在进入 `ApiClientError` 前会替换当前配置的 API Key，保留有限诊断信息但不把凭据带入上层错误消息；这不替代宿主日志系统、代理和第三方服务的独立脱敏策略；
- 模型进程边界：`agent run|loop --model-adapter CONFIG` 可把 Advisor/Planner 放到固定可执行文件的一次一进程 JSONL 边界；请求、回包、stdout/stderr、模型内容和等待时间均有界，宿主在取消或截止时终止子进程，再由既有 Application fallback 和 Replay 规则收束；配置只按显式环境变量名向子进程传递凭据，不把宿主完整环境默认泄露给模型；
- 模型进程竞态收束：模型请求在 `spawn()` 交接窗口被取消时，宿主会对刚返回的 child 做二次终止检查，不留下脱离闭环的运行进程；
- 有界感知上下文：WorldPort 的结构化 observation evidence 只经过大小/深度/数据类型边界后提供给 Advisor/Planner；Kernel 仍只接收数值观测，账本只保存上下文摘要，不把原始证据当作事实或执行权限；
- 模型故障隔离：Advisor 不可用、返回非法能力 Token 或破坏输出契约时，应用边界回退到 Kernel 的确定性选择，并把故障证据写入 STEP；不会因为模型暂时不可用而扩大权限，也不会让模型成为连续运行的单点故障；
- 安全边界：模型不能绕过 Kernel 直接执行动作；
- 确定性 Replay：回放使用已记录的模型提议摘要，不重新请求模型；
- Effect Broker：对明确声明的副作用提供计划、确认、执行、对账和补偿流程；
- EffectJournal：跨进程 append 使用原子 writer lock，并在锁内重读账本；stale-lock 回收另有固定 reclaim reservation，避免并发回收者互删或误删新 owner；副作用执行/对账/补偿期间持有可恢复的 nonce 级操作锁；Broker 还以全局日志头摘要做 CAS，陈旧状态不会重复提交语义转换；CLI 重启或并发调用不会各自基于陈旧 sequence 写入；
- 有界探索回合：变化监督器进入 `EXPLORATORY` 不再是单向闩锁——`acknowledgeReplan` 会记录进入周期、进入时最优距离与已验证步数；确认进展突破进入时最优距离（`exploration-improved`）或固定 12 个已验证步预算耗尽（`exploration-budget-exhausted`）即恢复 `BALANCED` 价值选择。周期-3 隐藏相位世界的反证显示，旧语义下一次早期停滞就会让 coverage 踏步与轨道耦合，60 步 20 次重规划后仍锁定 1/3 赢家率且 bestDistance 无改善；该反证同时证明旧账本监督器状态（无 exploration 记录）保持原语义；
- 多尺度上下文与键规范化：`kernelLearningVersion: 25`（`multiScaleContext`）新增窗口-1 的 `h0:` 上下文键（读取链 h2→h1→h0→关系→总体，写入按版本门控，旧账本读取天然无差异），并新增 Memory `contextKeyScale` 把上下文键中的实际变化量化到固定十进制精度——`actualDelta = expectedDelta + error` 的浮点重构残差（如 -5.55e-17）不再把语义相同的历史分裂成不同键；内核探针同时证明 h2 累加器键因位置权重按构造永不复现，「长期上下文可读」的原始声明不再成立，h2 写入仅作为审计保留；
- 上下文反事实探测：当价值最优选择依赖本上下文证据而另一安全候选在本上下文零样本时，Kernel 按固定间隔有界地探一次该候选并在 `choice.contextProbe` 留痕，使「全局证据被早期混合样本毒化（如某候选关系均值 -0.78）且上下文证据从未取得」的候选仍能被本上下文检验；周期-3 反证的两 seed 在真实 CLI 跨进程 60 步后收尾窗口均达到预注册相位锁定阈值且全部 Run 重放一致；
- 长窗口上下文：`kernelLearningVersion: 26`（`longContextWindow`）把 h2 键的基底由按构造永不复现的位置权重累加器改为最近 8 条已验证变化的窗口摘要（累加器字段仍按原样维护作审计），读取链变为 h2（窗口-8）→ h1（窗口-2）→ h0（窗口-1）→关系→总体，`recentHistory` 容量扩至 8 且写入按版本门控（v25 及更早 Replay 的记忆形状不变）；周期-7 碰撞世界（赢家调度 A,B,A,C,B,A,D，窗口-1/2 均存在相位碰撞，窗口-2 条件策略理论上限 ≈78.6%）的反证显示 v25 停留在盲选水平（28.6%），v26 在 ~150 步内收敛到 6/7 平台，双 seed 真实 CLI 跨进程 360 步的成熟窗口赢家率 87/120 与 ≥90/120，全部 Run 重放一致；
- 周期再验证信念门控：`kernelLearningVersion: 26` 起，token 级强制重验只针对「信念上仍不劣于任何安全候选」的过期行动（隐藏漂移只能靠真实重验发现，这类候选仍会被强制重访）；全局证据已判劣的冷门候选改由上下文反事实探测层取证，freshness 不再为它们打破已收敛的上下文轨道；v25 及更早语义按学习版本原样保留，漂移 E2E（含 `--stagnation-limit 100000` 的纯新鲜度契约）原样通过；
- 目标驻留（F-118 度量更正）：长跑中「6/7 平台在数百步后赢家率瓦解」经值曲线插桩证实为度量伪影——~650 步时值精确到达目标 400 并转入驻留（|v-400| ≤ 0.2 持续 500+ 步），越过目标后调度赢家不再是价值最优动作，调度赢家率失效。周期-7 碰撞世界的完整证据链：~150 步收敛到相位条件策略 → 值以接近理论上限的增速逼近目标 → 精确到达并无限期驻留（距离 0.0），全程重放一致；F-40 重验信念门控保留（v27 `revalidationBeliefGate`，动机更正为证据治理），同轮检验并回退了「饥饿上下文探测」假设（与既定学习契约 E2E 冲突）；
- Windows PowerShell CLI：所有核心实验可以脚本化运行。

模型进程适配器是可选的可靠性边界，不是权限沙箱。配置格式为 `{ "executable": "绝对路径", "args": [], "model": "名称", "timeoutMs": 5000, "env": ["显式允许传递的环境变量名"] }`；适配器从 stdin 读取一条 `yi-model-cli` JSONL 请求，并返回一条 `{protocol,version,id,ok,result:{model,content}}` 回包。它解决的是“不合作的模型回调不能永久占住 CLI”这一 liveness 问题，不证明模型安全、不会访问网络，也不撤销已经发生的副作用。

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

接入新 WorldPort 时，可以先做不落盘的预检：

```powershell
yi-agent adapter test --adapter $adapterConfig --json

# 连续运行前强制要求 adapter 声明自动恢复契约
yi-agent adapter test --adapter $adapterConfig --require-recovery --json
```

这个命令会读取配置并探测主 adapter 及其已声明的 witness、execution authority、execution observer 和 reconciliation observer，输出世界描述、能力、场景、状态依赖动作、幂等 transition、对账支持、`recoveryMode`、descriptor digest 和角色摘要。`recoveryMode` 为 `idempotent` 时优先按同一 nonce 恢复，`reconciliation` 时依赖 adapter 的 `reconcile`，`blocked` 时未知 transition 只能停下等待人工处理。加入 `--require-recovery` 后，`blocked` adapter 会在预检阶段以 `CONFLICT` 拒绝，不创建 Lab。它不会创建 Lab、锁或事件账本；预检成功只说明协议边界可建立，不代表外部世界已经可执行或可信。真正运行仍需经过 `init --adapter`、`run`、`inspect` 和 `replay`。

默认 adapter 配置仍是一次请求一进程；本地 adapter 需要复用进程时，在配置顶层增加 `"transport": "persistent-jsonl"`，并让 adapter 保持 stdin/stdout 打开的 JSONL 会话。`hello` 仍由一次性探针完成，后续请求才进入持久会话。远程 adapter 也可以使用 `"transport": "persistent-tls-jsonl"`，在一条经过 mTLS 校验的连接上串行发送 `hello` 和后续请求；连接断开后只建立新会话，不自动重放可能产生副作用的请求。两种持久模式的每个请求都有独立超时，adapter 必须逐行返回与请求 `id` 匹配的 envelope。它们只减少进程或 TLS 握手成本，不替代幂等 nonce、对账、EffectBroker 或人工确认。

需要把 WorldPort 放在另一台主机或独立网络服务时，可使用 `"transport": "tls-jsonl"`；需要在一次 CLI 操作内复用远程连接时使用 `"transport": "persistent-tls-jsonl"`。这两种配置都不填写 `executable/args`，而是填写 `host`、`port` 和指向客户端证书、私钥、CA、server name 的绝对路径。`tls-jsonl` 每个请求新建一条强制校验服务端证书并要求客户端证书的连接；`persistent-tls-jsonl` 在同一连接上按请求顺序复用会话，连接关闭后重新建立，但不盲目重放原请求。超时、证书错误、协议污染和响应超限都会在外部边界 fail-closed。远程连接只参与 init/run 的实时 WorldPort，Replay/inspect 使用已固化的 manifest 和 STEP 证据，不重新连接远端。这个传输证明的是网络协议和身份校验闭环，不证明远端主机诚实、硬件效果或物理因果。

若 `executionAuthority` 的 descriptor 发布了 `executionPublicKey`，配置中的 `executionAuthority.executionPublicKey` 必须与之相同；`bin/yi-agent-effect-authority.mjs` 可用 `--private-key-der` 指向 PKCS#8 DER 私钥文件，也可以不让 authority 进程接触私钥，改用 `--signer-executable` 与 `--signer-args-json` 调用 `bin/yi-agent-execution-signer.mjs`。两种方式都只接受绝对路径、普通文件、64 KiB 以内的私钥文件，私钥不应提交到仓库或写入共享配置。独立 signer 只把持钥代码移到另一个进程；同一用户仍可能读取私钥，因此它不是低权限隔离、远程密钥托管或可信硬件。公钥 pin 解决的是回执身份错配，不是私钥托管或 authority 诚实问题。

需要把 signer 放到独立服务时，可使用 `--signer-host`、`--signer-port` 和 `--signer-auth-token-file`。signer 服务端用 `bin/yi-agent-execution-signer-server.mjs` 启动，私钥由服务端读取，authority 只读取共享认证 token；错误 token、超时、协议污染或无效签名都会失败关闭。跨机器或非受信网络应同时配置 signer 的 `--tls-cert-file`、`--tls-key-file`、`--tls-client-ca-file`，以及 authority 的 `--signer-tls-cert-file`、`--signer-tls-key-file`、`--signer-tls-ca-file`、`--signer-tls-server-name`。需要主动拒绝已撤销客户端证书时，两端可分别增加 `--tls-crl-file` 与 `--signer-tls-crl-file`；CRL 文件同样受绝对路径、普通文件和 64 KiB 大小限制。证书密钥只负责连接认证，和 execution signing key 不是同一把钥匙；CRL 更新、旧证书审计和吊销发布仍属于部署运维责任。

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
yi-agent replay --lab E:\labs\counter --chain --adapter $adapterConfig --json
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

同一协议也有只使用 Python 标准库的实现：`examples/counter-world/adapter.py`。它与 Node 示例使用不同运行时和不同 WorldPort 身份，但不需要改动 Kernel 或 CLI。在 Windows PowerShell 中可直接验证：

```powershell
$exampleRoot = Join-Path $PWD 'counter-python-run'
powershell -ExecutionPolicy Bypass `
  -File .\examples\counter-world\run-python-example.ps1 `
  -RootPath $exampleRoot
```

脚本会先执行无副作用预检，再完成同一条 `init→run→inspect→replay` 链；配置使用 `persistent-jsonl`，因此运行期请求会复用 Python 进程。当前 Python 示例是无真实副作用、非幂等的演示 adapter；响应丢失后的恢复仍会按协议阻断，不能把跨语言接入误认为现实执行保证。

如果本机安装了 WSL，还可以把同一个 Python adapter 放到 Ubuntu 用户态运行：

```powershell
$exampleRoot = Join-Path $PWD 'counter-wsl-run'
powershell -ExecutionPolicy Bypass `
  -File .\examples\counter-world\run-wsl-example.ps1 `
  -RootPath $exampleRoot `
  -Distribution Ubuntu
```

该脚本通过 `wsl.exe` 启动 Linux 进程，仍由 Windows CLI 完成预检、初始化、运行、检查和离线 Replay。它验证的是同机不同 OS 用户态的协议边界，不等同于跨机器、不同账户或容器隔离。

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
- F-129/F-130 已证明：`signed-v1` 效用方向可以安全穿过 WorldPort→Kernel→账本→Replay，但仅开放价值模式并不能让跨期套利的 horizon 8 优于 horizon 1；真正未解决的是动作链信用分配；
- F-131 已把动作链信用收窄为一个可审计协议边界并完成跨进程 Replay 验收；F-132 在独立延迟效用 WorldPort 中证明，未声明链的共享边界保持 `AMBIGUOUS` 且不学习，正确声明链才产生两条 `ACTION_CHAIN` 并学习两个动作模型；这证明了协议能带来可观察的学习区分，但仍不证明 adapter 自报份额是真实因果；
- F-133 的反证进一步确认：即使 WorldPort 声明结构合法但给出错误的 `0.99/0.01` 份额，当前 Kernel 仍会照常学习并 Replay 一致；没有独立干预或反事实证据时，底座无法从同一次共同结果中识别错误因果；
- F-134 增加了受控加性证据：只有成员干预 delta 的总和闭合到实际结果才学习，闭合失败则保守为 `AMBIGUOUS`；这挡住了“算术上无法解释结果”的错误证据，但仍不证明 WorldPort 报告的干预确实在现实中发生；
- F-135 已用真实 JSONL adapter 验证闭合失败路径：格式合法但总和不等于实际变化的 witness 被结算为 `AMBIGUOUS`、不生成动作模型，Replay 保持一致；
- F-136 已用真实 JSONL adapter 验证描述符绑定：有效的 `counterfactual-attested-v1` witness 可跨 init→run→Replay 进入 v30 加性结算；篡改签名在外部边界被拒绝，前两步账本保留、第三步不写入，且不产生动作模型。签名只建立来源/快照完整性，不把 adapter 声明升级成现实因果事实；
- F-137 的反证确认签名仍不能识别伪造因果：测试夹具用独立 ground-truth 记录真实归因 `[0,1]`，而 adapter 返回签名且代数闭合的 `[0.75,0.25]`，当前 CLI 仍学习并 Replay 一致。该负结果直接驱动 v32 把证据生产者与独立见证者拆成两个可配置进程；
- F-138 已验证独立见证路径：见证进程只接收反馈元数据和成员 nonce，不接收主 adapter 的 delta 声明；正确见证可跨 init→run→Replay 进入学习，独立签名但 delta 不一致时在第三步前拒绝且不生成模型。F-139 又验证了缺成员同样 fail-closed，但两个不同密钥对同一错误闭合份额共同签名时，v32 仍会学习错误的 `0.9/0.1` 且 Replay 一致；这正式确认来源独立不等于因果真实，下一步必须进入随机化对照、可信执行器或可审计物理观测与长期策略收益对照；
- F-140 固化了长跑账本的规范化序列化缓存：只在单次 append 生命周期内复用已经完成的子树字符串，并由内部闭环边界一次生成 `afterDigest`；持久化格式、摘要算法和公开 `run.append()` 完整性要求不变。NFR 长跑门禁、应用层 47/47、账本/Replay 76/76 定向回归通过；
- F-141 增加了可选的 `host-csprng-v1` 随机化动作边界：CLI/API 从当前安全动作臂中随机分配并把候选臂、抽样位置和实际选择写入 STEP 与外部转换边界，Replay 只复用已记录分配；随机化提供独立干预所需的宿主分配边界，但不等于因果证明，WorldPort 仍可能虚报结果。应用层 49/49、账本/Replay 76/76、随机化 CLI 2/2 定向回归通过，并验证连续 loop 重启后仍保留该配置；
- F-142 将该随机化边界推进到真实 JSONL 外部 WorldPort：延迟经济场景的 3 步安全窗口中，宿主在每一步从显式的两个候选动作臂抽样，实际选择、延迟反馈结算和跨进程 Replay 均保持一致（定向回归 1/1）。若安全投影在某一步只剩一个动作臂，随机化实验会明确拒绝，不静默退化成单臂结果；这仍只证明动作分配的传输与回放，不证明 WorldPort 或现实设备真的执行了所选动作。
- F-143 增加可选的独立 `executionObserver` 边界：主 WorldPort 完成 `transition` 或恢复 `reconcile` 后，宿主向另一个进程只发送 `executionNonce`、`token`、`basedOnVersion` 和前状态摘要；只有观测者返回匹配的前后状态摘要，`OBSERVED` 证据才会写入 STEP，Replay 只校验已持久化证据而不会重新启动观测者。观测不一致在 STEP 前以 `WORLD_ADAPTER_PROTOCOL` fail-closed；主效果可能已经发生，因此仍须按外部未决效果恢复。该边界证明的是可部署的第二进程观测，不是可信硬件、物理事实或抗共谋证明；同一代码、共享数据或共同错误来源仍可一起撒谎。
- F-144 将独立观测推进到真实临时目录的 OS 可见状态：主 adapter 写入独立 marker，observer 不读取主效果记录，只检查 marker 是否存在并据此绑定后状态摘要；marker 缺失时，即使主 transition 返回 `ACCEPTED`，也会在 STEP 前返回 `WORLD_ADAPTER_PROTOCOL`，主效果记录保留为未决。正向与缺失 marker 的 CLI E2E 定向回归 `2/2`，Replay 仍不启动 observer。OS 文件状态仍由同一用户权限和本机进程控制，不等于 OS 远程证明、硬件观测或物理真相。
- F-145 把外部执行进一步拆成三个角色：主 adapter 只声明 `transition`，可选的 `executionAuthority` 独立进程负责产生与 nonce 绑定的 OS effect，`executionObserver` 再独立检查该 effect；宿主先校验 authority 的 `EXECUTED` 回执，再校验 observer 的 `OBSERVED` 回执，任一缺失或不一致都在 STEP 前 fail-closed。authority 的配置、descriptor/launch 摘要、恢复与 Replay 边界都写入 manifest，但 Replay 不重新启动 authority/observer。真实临时目录夹具证明主 adapter 不写 marker 也能由 authority 完成，authority 虚假成功但不产生 marker 会被 observer 拒绝，主机崩溃后同一 nonce 可恢复；这仍是同一用户权限下的本机进程隔离，不是低权限沙箱、远程 attestation、可信硬件或物理真相。
- F-146 把 authority 接入实际的 `EffectBroker`：独立 JSONL 进程恢复 `EffectJournal`，按 nonce 绑定固定 `EffectIntent`，调用受标记根目录约束的 `SandboxFileExecutor`，并在崩溃恢复时通过 `reconcileExecution` 返回 `RECONCILED`，不重复执行。真实 CLI E2E 已验证主 adapter 不写 OS marker、文件效果确实由 Broker 移动、`EFFECT_APPLIED` 进入独立 effect journal、STEP/Replay 保留 authority 证据；高风险计划仍必须经过确认，authority 不得自动越过人工门。该示例仍只覆盖本机同用户权限和预绑定文件计划，不等于低权限隔离、远程执行证明或真实设备控制。
- F-147 收敛长跑和外部进程压力边界：STEP 账本使用 Deflate Raw level 4，在不改变解码格式和证据内容的前提下让 10,000 步 checkpoint NFR 回到 60 秒内且保持 40 MiB 上限；cyclic-collision 夹具把单次外部请求预算提高到 10 秒，长窗口 E2E 不再被 Windows 进程启动抖动误杀。负结果也被记录：level 1/3 会突破 ledger 上限，而一次请求一次进程仍使长外部序列达到分钟级；下一步需要持久 JSONL WorldPort 会话。
- F-148 增加显式 `transport: "persistent-jsonl"` 外部 WorldPort 会话：旧配置继续使用一次请求一进程；持久模式先完成一次 `hello` 探针，再复用一个 JSONL 子进程，按请求串行化并施加 stdout/stderr 上限与单请求超时。超时、协议污染或进程退出会关闭当前会话，不自动重放可能已经产生副作用的请求；后续恢复仍由 execution nonce/idempotency 或 reconciliation 决定。真实 CLI E2E 已验证多步只复用一个运行期会话、会话响应丢失/超时后的同 nonce 恢复不重复效果，Replay 不启动 adapter；现阶段仍不改变默认 transport，也不等于 OS 沙箱或物理事实证明。
- F-149 把同一持久 transport 扩展到独立 witness、executionAuthority 和 executionObserver；这些角色的 transport、launch digest 和身份元数据一起进入 manifest，继续运行与只读 Replay 会校验一致性。witness 证据链改为显式等待异步请求，避免持久会话把 Promise 当成同步结果；真实 E2E 验证了 6 步延迟反馈中的 witness 只复用一个运行期进程，以及 authority/observer 在同 nonce 重试中各复用一个进程且效果只写一次。Replay 仍不启动任何辅助角色。
- F-150 用 authority 和 observer 的响应丢失夹具验证了多角色恢复窗口：角色先完成各自的 nonce 绑定工作，再故意关闭进程；第一次 Run 停在 `WORLD_ADAPTER_PROTOCOL`，下一次独立 CLI 用同一 nonce 复用主 adapter 的幂等结果、authority 的持久结果和 observer 的新观测，主效果与 authority effect 都只出现一次，Replay 仍为 `CONSISTENT`。这验证的是本机进程崩溃后的协议恢复，不是跨机器身份或可信执行证明。
- F-151 把恢复窗口扩展为连续故障：authority 回执丢失后，下一次 Run 让 observer 再丢失回执，第三次才完成；3/3 E2E 验证三类角色仍绑定同一 nonce，主效果和 authority effect 都保持一次。另用真实 `EffectBroker`、`EffectJournal` 和 `SandboxFileExecutor` 验证 authority 已移动文件但回执丢失时，重启后的 Broker 只复用 `EFFECT_APPLIED` 记录，不再次移动文件，Replay 为 `CONSISTENT`。测试仍运行在本机同用户权限下，不等于跨机器身份或真实设备证明。
- F-152 为 execution authority 增加可选 Ed25519 回执签名：authority descriptor 发布 `executionPublicKey`，配置显式 pin 同一公钥；带公钥的 authority 必须为 `EXECUTED/RECONCILED` 回执附上绑定完整回执内容的 `executionAttestation`，宿主、LabStore 和 Replay 都验签。真实 EffectBroker 沙箱 CLI 签名闭环 `1/1`，签名篡改单测 `1/1`；没有公钥的旧 authority 仍保持兼容。签名只证明持钥进程签出了这条内容，不证明持钥进程诚实、私钥未被同用户进程读取，也不证明物理设备已执行。
- F-153 把签名私钥从 EffectBroker authority 进程移到独立的 signer 子进程。authority 通过受限的单请求 JSONL 协议发送待签回执，只接受与 descriptor 公钥匹配的 attestation；超时、协议污染、进程失败和无效签名都会 fail-closed。真实 CLI E2E 已验证 authority 不携带 `--private-key-der` 仍能执行 EffectBroker、恢复并 Replay 为 `CONSISTENT`。这只证明了代码路径和进程持钥角色的分离；两个进程仍在同一用户权限和本机 OS 下，不能当作权限隔离、跨机器身份或物理执行证明。
- F-154 把 signer 再移到受认证的 TCP 服务：authority 只持有受限 token 文件，不持有私钥；服务端用常量时间比较校验 token，签名结果仍由 authority 按 `executionPublicKey` 验证。真实 TCP signer 与完整 EffectBroker CLI 闭环均已通过。当前只绑定本机回环地址，TCP 未加密，认证 token 解决的是未授权请求，不等于 TLS、跨机器身份或可信硬件。
- F-155 为 TCP signer 增加可选双向 TLS：服务端要求客户端证书，authority 校验服务端 CA 和 server name，完成 TLS 握手后仍用 execution 公钥验签。真实证书握手、错误 token、签名和回执链均有测试。未配置 TLS 时服务端仍只监听回环地址；TLS 也不证明 signer 对现实副作用诚实。
- F-156 将 signer 故障放进 EffectBroker 恢复窗口：signer 在签名后、响应前退出，第一次 Run 留下已移动文件和未完成账；服务重启后第二次 CLI 使用新的 run 继续，Journal 只保留一次 `EFFECT_APPLIED`，Replay 为 `CONSISTENT`。这验证的是 signer 服务退出恢复，不是网络分区或远程设备对账。
- F-157 把 mTLS 服务端证书轮换放进连续多角色恢复：第一次 Run 在 signer 签名后丢回执；服务端在同一端口用新证书重启后，第二次 Run 完成 authority 对账但让 observer 丢回执；第三次 Run 完成。共享 CA、execution 公钥、token、EffectJournal 和 nonce 绑定保持不变，文件效果只执行一次，Replay 为 `CONSISTENT`。测试覆盖的是本机同 CA 的身份重建，不是 CA 撤销、网络分区、不同 OS 身份或真实设备证明。
- F-158 进一步同时更换 mTLS 信任根：第一轮使用 CA-1，第二轮把 signer 服务端证书、authority 客户端证书和 signer 的 client CA 换成 CA-2，authority 的信任文件同时保留两根 CA。未决 execution nonce 在 CA 切换后恢复，EffectBroker 效果仍只执行一次，Replay 为 `CONSISTENT`。这验证的是双向 CA 更换，不是撤销列表、旧证书审计或硬件密钥。
- F-159 把证书撤销放进恢复窗口：服务端加载 CRL，第一轮拒绝仍由同一 CA 签发但已撤销的 authority 客户端证书；此前已经产生的沙箱效果保持一次。随后只替换同一证书路径下的客户端证书内容，服务重启后用原 execution nonce 恢复，效果计数仍为 1，Replay 为 `CONSISTENT`。真实 signer、authority、CRL 和 EffectBroker CLI 组合回归为 `9/9`。这证明的是 TLS peer 证书撤销与应用恢复可以衔接，不是私钥硬件保护、OS 权限隔离或真实设备回执。
- F-160 收紧 provider 错误边界：当非 2xx 响应正文回显当前 API Key 时，HTTP client 在构造 `ApiClientError` 前将它替换为 `[REDACTED]`；正常错误状态、HTTP 状态码和取消/超时分类保持不变。API、CLI 相关回归为 `28/28`，上一轮全量门禁为 `515/515`。这只覆盖 client 已知的当前 key，不等于第三方服务、代理或宿主日志系统已经完成全面脱敏。
- F-161 收紧 advisor 错误证据：policy evidence 只保留格式受限的错误码和固定安全摘要，不把任意 adapter/provider 异常文本、context 或异常对象写入账本；带凭据的异常消息回归确认不会进入 Replay 输入。错误码只用于分类，不证明外部错误来源真实。
- F-162 增加 GitHub Actions 持续门禁：Windows Node 22 执行完整测试，Ubuntu Node 22/24 执行跨版本兼容子集；workflow 只有仓库只读权限。它把本地回归变成远端提交证据，但不替代真实供应商、低权限身份、设备回执或人工确认。
- F-163 为 `test-gate` 增加可配置 watchdog：上一轮 Windows 全量任务曾长期停留在 `node:test`，GitHub job 超时也未及时收敛，不能把“仍在运行”当作测试证据。设置 `YI_AGENT_TEST_GATE_TIMEOUT_MS` 后，超时会输出明确诊断、以退出码 124 失败，并在 Windows 终止整个测试进程树，在 POSIX 终止独立进程组；CI 为 Windows 全量设置 80 分钟、Ubuntu 兼容门禁设置 40 分钟。新增悬挂测试回归验证超时行为；它只保证门禁有界退出，不判断哪个领域测试正确，也不替代真实供应商、低权限身份、设备回执或人工确认。
- F-164 收紧 CLI 包边界：新增 `.npmignore`，打包保留 `bin/`、`src/`、`examples/`、README 和许可证，排除测试、研究材料、CI 配置及未跟踪的 `vision.md`。`npm pack --dry-run` 验证包从 175 个文件缩为 63 个文件，运行入口和示例 WorldPort 仍在；这只减少发布面，不改变本地仓库中的开发与测试文件。
- F-165 收敛 CI 并发与 action 运行时：workflow 按分支设置 concurrency，新提交会取消同一分支过时的 run；checkout/setup-node 更新到当前 Node 24 runner 兼容的官方 action 主版本。它只减少重复 runner 和弃用警告，不改变测试范围或运行时语义。
- F-166 收紧持久 JSONL 会话的关闭边界：宿主调用 `registry.close()` 后，已经进入串行队列但尚未出队的请求会被拒绝，不会再启动运行期 adapter 子进程或产生外部请求；新增真实 persistent WorldPort E2E，并保持既有 nonce 恢复、辅助角色和 Replay 语义不变。这只证明本地会话生命周期收敛，不等于跨机器权限隔离或物理效果可信。
- F-167 修复 CI 临时目录污染 repo WorldPort 的边界：GitHub Actions 的 `TEMP/TMP/TMPDIR` 改用 runner 专用临时区，不再把前序测试生成的文件放入被扫描 checkout。首次 Windows 全量 run 的 513/517 结果已定位为该环境耦合；本地 repo WorldPort 与 watchdog 联合回归为 `10/10`，下一次远端全量结果仍需单独确认。
- F-168 收紧 watchdog 的 Windows 清理边界：`taskkill.exe` 最多等待 5 秒，清理命令自身悬挂时 test-gate 仍会返回有界失败结果。这个节点是对潜在清理失控路径的主动收敛，不把尚未证实的 runner 状态当作失败证据；本地 repo WorldPort 与 watchdog 联合回归为 `10/10`，远端完整顺序仍待新 run 证实。
- F-169 修正 watchdog 回归夹具的 Windows 竞态：悬挂测试显式保持事件循环存活，确保用例验证的是 test-gate 的截止处理，而不是 node:test 子进程自行退出。上一轮远端 Windows 全量为 `516/517`，唯一失败是原夹具在 250ms 边界没有留下 timeout 诊断；本地 Windows Node 26.7.0 重复回归为 `3/3`，修复后的 Node 22 远端结果仍待确认。
- F-170 完成一次本机 Windows 全量门禁：当前提交在 Node 26.7.0 上按同一 `npm test` 顺序通过 `517/517`，总耗时约 52 分钟；其中第 210、224、225、358 个长实验分别耗时约 7 分钟、6 分 40 秒、11 分 29 秒和 1 分 40 秒。对应的远端 Windows runner 在启动后约 8 小时仍无更新时间，取消后没有产生终态测试摘要；这两类证据分开记录，Node 26 本机结果也不外推为 Node 22 兼容性证据。
- F-171 闭合 Windows Node 22 在线门禁：提交 `fe9d5fe` 的 GitHub Actions run `34278445810` 在 Windows Node 22 上按完整 `npm test` 顺序通过 `517/517`，`# fail 0`，测试进程耗时 `2355824.3899ms`，作业耗时约 39 分 56 秒；同一 run 的 Ubuntu Node 22/24 兼容门禁也成功。F-170 的本机 Node 26 结果仍单独保留，不能把这次结果外推到任意 runner、低权限身份、真实供应商或物理设备。
- F-172 修正本机缓存进入安装包的问题：`.npmignore` 现在显式排除 `.yi-agent/`，`npm pack --dry-run` 的 63 个文件中不再出现 CI/cache 路径；packaged CLI 回归继续覆盖安装、连续运行、外部效果恢复和 Replay。这个节点只收紧包内容，不改变运行时权限或发布到 npm 的状态。
- F-173 增加公开 GitHub 安装入口：Windows 用户可以直接从 `https://github.com/ZDragon17/yi-agent.git#main` 安装 CLI；当前仍未发布到 npm registry，Git 安装和 `yi-agent --help` 已在临时 npm 前缀中实测通过。
- F-174 收紧 CI 触发范围：只有运行时代码、测试、示例、脚本、包元数据、`.npmignore` 或 workflow 变化时才触发推送/PR 门禁；README、tasks 等文档-only 提交不会再占用长时间 runner。`workflow_dispatch` 仍可手动运行完整门禁。
- F-175 将内置 challenge suite 接入 packaged CLI 回归：公开安装后的 `yi-agent challenge --lab ... --json` 现在必须返回 10 个 case 全部 `PASS`；本机真实命令和安装包回归均通过。挑战只证明当前演示判据未被这些输入证伪，不等于通用智能或现实因果证明。
- F-176 为 `test-gate` 增加有界 liveness 心跳：长测试期间每 60 秒输出一次 `node:test still running`，CI 可区分正常长跑、测试超时和 runner 失联；`YI_AGENT_TEST_GATE_HEARTBEAT_MS` 允许在 1～300000ms 内显式调整。心跳只改善运行证据，不改变测试结果或终止语义。
- F-177 把只读 UI 外壳与真实 repo WorldPort 放进同一组合回归：`11/11` 覆盖仓库观察、受摘要约束的补丁、错误候选拒绝、响应丢失恢复、跨进程重启、历史引导修复，以及 UI 的只读和缺失实验空间 fail-closed。它支持继续研究桌面呈现，但不授权任意文件或生产项目写入。
- F-178 收紧只读 UI 的动态内容边界：汇总值改用 DOM 文本节点渲染，不再把 lab、目标或 WorldPort 状态拼入 `innerHTML`；HTML/JSON 响应增加 CSP、`nosniff`、禁止 iframe 和无 referrer 头。安全回归与 repo WorldPort 组合门禁分别为 `2/2`、`11/11`，依赖审计未发现高危漏洞。这降低本地呈现面的注入风险，不等于 OS 级隔离或生产部署安全。
- F-179 用仓库外 late-bound Oracle 复验当前候选：未知世界、未知不透明 Token 和随机有限模型共 `48/48` 通过，且用当前候选源码摘要绑定后仍为 `PASS`。这支持“UI 修复未改变 Kernel 公共契约”，不把 Oracle 结果扩展成通用智能或现实因果证明。
- F-180 完成一次外部 WorldPort 长跑组合门：经济/对抗课程、延迟和噪声反馈、制度切换、独立 witness、持久 authority/observer 以及会话故障恢复共 `21/21` 通过，耗时约 19 分 46 秒，最长 L4-A 约 9 分 49 秒。结果支持跨 WorldPort 账本与 Replay 一致，但也把长跑性能明确留作后续实验，不宣称已具备现实收益或高吞吐。
- F-181 针对 F-180 的长跑瓶颈做了第一轮实测优化：ESS adapter 支持持久 JSONL 会话，L4-A 复用运行期进程；规划分支改为共享只读模型树的顶层快照，持久化预算只用原生 JSON 计算字节数，账本摘要仍保留 canonical JSON。相同 L4-A 负结果从约 589 秒降到约 324 秒，内核契约 `54/54`、规划/历史/UI 门禁 `15/15`、Level 5 `2/2` 通过。优化只证明当前 Windows 合成 WorldPort 的局部收益，尚未证明任意 adapter、跨主机或真实设备场景的吞吐。
- F-182 把外部对账签名从草案推进为 opt-in 运行时契约：adapter 可在 descriptor 中声明 `reconciliationPublicKey`，宿主要求 `APPLIED/ABSENT/UNKNOWN` 对账结果提供 Ed25519 回执；签名绑定世界、场景、before state、原始请求和结果摘要，恢复证据写入 STEP boundary，Replay 在不重新调用 adapter 的情况下复验。有效签名、篡改签名和缺失签名回归 `3/3`，完整 reconciliation 回归 `10/10`。签名只证明持钥 adapter 声明过这段内容，不证明现实效果真实发生。
- F-183 把非幂等对账的第二观察边界接入恢复路径：配置可声明独立 `reconciliationObserver`，宿主把 observer 对同一 `executionNonce`、before/after 状态的 `OBSERVED` 结果与主 adapter 的 `APPLIED` 声明逐项比较，再把观察证据写入 STEP；Replay 只复核已提交证据，不重新调用 observer。有效观察与矛盾观察回归 `2/2`，矛盾结果不会追加 STEP。该 observer 仍是本机进程和配置级独立，不是低权限、远程或物理可信根。
- F-184 收紧 F-183 的配置边界：主 WorldPort 与 `reconciliationObserver` 不能复用完全相同的可执行文件、参数和 transport；宿主在第一次 `hello` 前直接拒绝这种“只换身份名”的配置，等价路径和指向同一底层文件的硬链接也会被拒绝。对账 E2E 回归 `13/13`，与账本/Replay 组合门禁 `93/93`；该约束仍只排除配置层面的假分离，不等于 OS 权限、跨机器身份或现实效果证明。
- F-185 为 F-184 取得线上三矩阵门禁：提交 `a8b233e` 在 GitHub Actions 的 Ubuntu Node 22、Ubuntu Node 24 和 Windows Node 22 全部通过；三个 job 时长分别为 283 秒、237 秒和 1733 秒。该结果只覆盖当前测试套件和本次 runner，不延伸为真实权限、远程主机或现实效果证据。
- F-186 把外部 WorldPort 的网络边界推进为异步 `tls-jsonl` transport：主 WorldPort 和 `reconciliationObserver` 都可使用双向 TLS 的远程 JSONL endpoint，证书、CA、server name、endpoint 和启动摘要进入 manifest 约束；错误 CA 在 `hello` 前拒绝，远端服务停止后 Replay 仍离线保持 `CONSISTENT`。远程 WorldPort 与远程 observer E2E 为 `2/2`；提交 `b20e1e7` 的 GitHub Actions 三矩阵门禁全部通过，Ubuntu Node 22 用时 272 秒、Ubuntu Node 24 用时 233 秒、Windows Node 22 用时 2149 秒。这只是可验证的传输/身份边界，不等于远端主机、可信硬件或现实效果真实。
- F-187 把远程边界放进恢复路径：主 WorldPort 首次产生非幂等效果后丢失回执，服务端重启，再由同一 endpoint 的 `reconcile` 和独立远程 observer 恢复；效果计数保持 1，两个服务停止后 Replay 仍为 `CONSISTENT`。本机远程恢复 E2E 为 `3/3`，它验证的是 nonce、重启和离线账本的一致性，不是远程主机诚实或物理效果证明。
- F-188 修正 `tls-jsonl` 的响应收尾：客户端不再在第一行合法 envelope 到达后立即销毁连接，而是等远端结束并检查后续字节；延迟到达的第二个 envelope、未结束的响应和超时都会失败关闭。新增协议污染回归后，远程 WorldPort E2E 为 `4/4`。
- F-189 在远程恢复路径加入同一 CA 下的服务端证书轮换：primary 重启时更换服务端密钥和证书，旧 manifest、同一 nonce、独立 observer 与离线 Replay 仍保持一致。该场景包含在远程 E2E `4/4` 中；它不等于 CA 轮换、撤销审计或远程主机可信。
- F-190 为远程 WorldPort 的 `crlFile` 增加负向回归：客户端在 `hello` 前拒绝已被 CRL 撤销的服务端证书。远程 E2E 全组提升为 `5/5`；CRL 只覆盖 TLS 层撤销，不代表部署系统已经完成证书发布、吊销传播或人工审计。
- F-191 验证远程 WorldPort 的 CA 轮换窗口：初始化时把旧 CA 与预授权的新 CA 放入固定 trust bundle，服务端在同一 endpoint 上从旧根切换到新根后，原 Lab、连续 Run 和 Replay 仍保持一致；改用未列入 bundle 的第三根 CA 时，客户端在 `hello` 前拒绝且不产生新效果。该方案要求轮换根在初始化前明确进入信任边界，不把“任意替换 caFile”当作安全轮换。
- F-192 把 mTLS 撤销回归补到远程 WorldPort 服务端：测试服务加载由同一 CA 签发的客户端 CRL，已撤销的 client certificate 在 `hello` 前被拒绝，CLI 不创建有效 manifest。远程 E2E 全组提升为 `7/7`；这只证明服务端按已提供 CRL 执行 peer 拒绝，不证明 CRL 发布、分发时效、私钥保护或远程主机可信。
- F-193 把两个远程 WorldPort 的恢复放进同一条实验：primary 首次非幂等效果已产生但丢失回执，primary 与 reconciliation observer 随后分别重启并轮换服务端叶子证书；原 Lab、execution nonce 和客户端身份不变，第二次 Run 只通过对账完成，效果计数仍为 1，停止两个服务后的 Replay 为 `CONSISTENT`。远程 E2E 全组提升为 `8/8`；这仍只覆盖同一 CA、本机测试服务和配置级的跨端点一致性。
- F-194 验证远程角色可以拥有不同的服务端信任根：primary 使用自己的 CA，observer 使用另一套 CA，并让 observer 的客户端 trust bundle 预授权下一根 CA；客户端证书由独立的 client CA 签发。两个服务同时重启后，observer 换根、primary 换叶子证书，原 nonce 仍能完成对账且效果不重复，Replay 为 `CONSISTENT`。远程 E2E 全组提升为 `9/9`；这仍不等于跨机器权限或真实执行来源。
- F-195 验证 observer 失联不会被当成恢复完成：primary 已产生效果但丢失回执后，observer 暂时不可达，恢复请求失败且不追加 STEP；observer 在原端口恢复后，同一未决链继续完成，效果计数仍为 1，离线 Replay 为 `CONSISTENT`。远程 E2E 全组提升为 `10/10`；这仍只覆盖受控测试服务，不代表真实网络分区已有自动处置能力。
- F-196 增加远程 `persistent-tls-jsonl` transport：同一次 CLI 操作中的 `hello`、状态读取和后续请求复用一条 mTLS JSONL 会话，按请求串行化；连接身份、TLS 材料摘要、endpoint 和 transport 仍进入 manifest 的 launch digest，连接断开时关闭当前会话，不自动重放请求。远程 E2E 验证了初始化和运行各自只建立一条连接，账本与 Replay 的 transport 校验继续通过。它减少的是 TLS 握手开销，不解决网络分区、非幂等请求的自动重试或远程效果真实性。
- F-197 修复持久 TLS 会话在对端返回响应后立即发送 FIN 时的重连竞态：下一请求不会复用半关闭 socket，而会建立新 mTLS 会话；已发出的请求仍不自动重放。远程 E2E `12/12` 验证逐响应关闭时 init→run 可完成、非幂等效果只执行一次，Replay 为 `CONSISTENT`。这只覆盖正常连接收尾，不覆盖网络分区或远程效果真实性。
- F-198 将 `persistent-tls-jsonl` 放入远程非幂等恢复链：主端点产生效果后丢失回执并重启，下一次 CLI 通过同一 nonce 的 `reconcile` 和独立 observer 闭合未决链；效果只执行一次，Replay 为 `CONSISTENT`。本机远程 E2E `13/13` 通过。这只说明持久 transport 沿用既有恢复边界，不说明网络分区或远程效果真实。
- F-199 把服务端叶子证书轮换放进持久 TLS 恢复：primary 与 reconciliation observer 在非幂等效果回执丢失后同时重启，并在原端口使用同一 CA 签发的新证书；客户端配置、trust bundle、nonce 和 Lab manifest 不变，恢复仍只执行一次且 Replay 为 `CONSISTENT`。本机远程 E2E `14/14` 通过。这只验证 mTLS 会话重建与既有恢复契约相容，不等于 CA 发布、密钥保护、跨机器身份或真实效果证明。
- F-200 把持久 TLS 的请求超时放进非幂等恢复窗口：远端已写入效果但延迟发送 `transition` 回执，客户端在固定超时后关闭会话并返回 `WORLD_ADAPTER_PROTOCOL`；下一次 CLI 通过同一 nonce 的对账和 observer 完成恢复，效果计数仍为 1，Replay 为 `CONSISTENT`。本机远程 E2E `15/15` 通过。这只证明受控延迟下的未知回执不会触发盲重放，不等于网络分区检测、重试时限或远程效果真实性。
- F-201 把持久 TLS 的响应黑洞放进恢复窗口：primary 在写入非幂等效果后保持 endpoint 在线，却永远不发送这次 `transition` 回执；客户端超时并销毁当前会话，下一次 CLI 通过新会话和 observer 完成同一 nonce 的对账，效果计数仍为 1，Replay 为 `CONSISTENT`。本机远程 E2E `16/16` 通过。这比迟到响应更接近连接黑洞，但仍不等于真实网络设备、路由状态或跨机器故障证据。
- F-202 把并发恢复接入远程持久会话：两个 CLI 同时争抢同一个未决 `run-2`，单 writer 锁只允许一个恢复路径完成；primary 与 observer 仍经 `persistent-tls-jsonl` 对账，效果计数为 1、STEP 只有 1 条，Replay 为 `CONSISTENT`。本机远程 E2E `17/17` 通过。这只证明同一实验空间的并发排他，不证明分布式锁、跨机器时钟或真实设备的原子执行。
- F-203 把“效果已产生但连接被立即重置”与应用层响应黑洞分开验证：primary 在执行 `transition` 后直接销毁当前 TLS socket，服务进程继续监听；CLI 收到连接级协议错误后不重放原请求，下一次 Run 经同一 nonce、reconcile 和 observer 完成恢复，效果计数仍为 1，Replay 为 `CONSISTENT`。本机远程 E2E `18/18` 通过。这比应用层黑洞更接近 TCP/TLS 连接故障，但仍不是路由分区、跨机器锁或真实设备效果证据。
- F-204 增加只转发加密字节的 TCP 故障代理：代理在观察到主 WorldPort 已写入效果后切断当前上下游连接，但不解析或修改 TLS 内容，随后放行新连接。primary 和代理进程都保持在线，CLI 通过同一 nonce 的对账恢复，效果计数仍为 1，Replay 为 `CONSISTENT`。本机远程 E2E `19/19` 通过。这把“中间网络切断”与服务端主动 reset 分开，但仍不等于真实路由分区、跨机器锁或设备效果证明。
- F-205 让透明 TCP 代理保持连接，只吞掉效果产生后的回程数据：客户端按固定超时关闭本地会话，primary 与代理继续在线，下一次新连接经同一 nonce 对账完成恢复，效果计数仍为 1，Replay 为 `CONSISTENT`。本机远程 E2E `20/20` 通过。这把网络层超时与网络层断连分开，但故障时机仍由测试控制文件驱动。
- F-206 把四个远程角色放入同一条 `persistent-tls-jsonl` 恢复链：primary、executionAuthority、executionObserver 和 reconciliationObserver 都通过独立的 mTLS endpoint 工作；第一次 Run 中 executionObserver 在返回观察前退出，primary effect 与 authority effect 各只产生一次但 Run 保持未决，第二次 CLI 为四个角色分别重建会话并沿同一 execution nonce 完成恢复。新增回归与完整远程 WorldPort 组为 `21/21`，停止所有远端服务后的 Replay 仍为 `CONSISTENT`。这证明的是同一实验主机、同一客户端证书和受控文件效果中的跨角色协议闭合，不证明跨机器锁、OS 权限隔离、远程代码诚实或真实设备效果。
- F-207 增加 `adapter test` 作为外部 WorldPort 的无副作用预检：配置、主 adapter 和已声明辅助角色会在不创建 Lab、锁或账本的情况下完成 `hello` 探针，并返回不含凭据的世界描述、能力、场景、摘要和角色身份。它把接入前的协议诊断从实验空间初始化中分离出来，但不改变真正执行仍需经过 `init→run→inspect→replay` 的边界。
- F-208 把主 adapter 的状态依赖动作、幂等 transition 和对账支持能力加入预检结果，并用带 execution observer 的配置回归验证。这样恢复前可以先看到影响 nonce 恢复安全性的声明；这些仍是 adapter 的协议声明，不是现实效果或远程代码诚实的证明。
- F-209 增加只使用 Python 标准库的外部 WorldPort 示例，并用 Windows PowerShell 真实跑通预检与 `init→run→inspect→replay`。这验证协议不绑定 Node 运行时；示例仍是无真实副作用、非幂等 adapter，不扩大恢复或现实执行保证。
- F-210 将 Python WorldPort 放入 WSL Ubuntu 用户态，通过 Windows `wsl.exe` 启动并用 `persistent-jsonl` 完成同一条闭环；本机结果为 `COMPLETED`、3 步、Replay `CONSISTENT`。这验证同机跨 OS 用户态的协议互操作，不等同于跨机器、不同账户或容器隔离。
- F-211 让 `adapter test` 根据主 descriptor 直接给出 `recoveryMode`：幂等优先为 `idempotent`，仅支持对账为 `reconciliation`，两者都没有则为 `blocked`；正反配置回归均通过。它把未知回执的处理边界变成可读结果，但不把 adapter 声明变成现实效果证明。
- F-212 增加 `adapter test --require-recovery`，在创建 Lab 前拒绝 `recoveryMode=blocked` 的 adapter；无恢复契约返回 `CONFLICT`，仅支持对账的配置可以通过。它把连续运行的安全前置条件变成显式命令选项，不改变默认兼容行为。
- 在人工确认后，逐步扩展到真实副作用和桌面端。
- F-213 把 `--require-recovery` 接入 `agent loop`：连续 Runner 在启动第一个 Run 前复用同一恢复姿态检查，`blocked` 外部 adapter 直接返回 `CONFLICT`，仅对账 adapter 可以继续；普通 `agent run` 使用该选项会返回参数错误，避免语义含混。
- F-214 将连续 Runner 的恢复要求写进 continuation contract。新 loop 在启用 `--require-recovery` 时把布尔值固化到每个 Run 的 immutable start；后续 `--resume` 从已验证账本读取该要求，即使调用方没有再次传参，也会在第一个恢复 Run 前检查 adapter。旧账本没有该字段时仍按历史语义运行；定向回归与完整 CLI 门禁为 `70/70`。该字段防止策略降级，不会把 adapter 的能力声明变成幂等性或现实效果证明。

## F-215 恢复声明的不可自证边界

测试 adapter 在 `hello` 中声明支持幂等 transition，`adapter test --require-recovery` 会通过，但它在同一 execution nonce 的恢复请求上故意再次产生外部效果。宿主仍能得到结构合法的 STEP，离线 Replay 也为 `CONSISTENT`，而受控效果计数从 1 变成 2。由此确认 `recoveryMode` 是协议前置条件，不是现实幂等性的证明；要缩小这条边界仍需要独立执行观测、可信执行器或人工可审计的外部证据。

## F-216 CLI 启动路径的恢复要求落盘

修正 CLI 到应用服务的参数传递遗漏：`agent loop --require-recovery` 现在会把要求传给 `runContinuous`，真实 CLI 创建的 continuation 也会在每个 Run start 中保存该字段。此前只有直接调用应用服务的测试覆盖到了这条语义，新增 E2E 已补齐 CLI 启动边界。

## F-217 不允许给 legacy loop 临时加恢复要求

发现 `agent loop --resume --require-recovery` 可以检查本次调用，却无法修改此前已经写入的 immutable Run start；如果继续执行，下一次不带参数的恢复仍可能回到旧策略。现在 active continuation 缺少该字段时直接返回 `CONFLICT`，不启动新的 Run；已有 `requireRecovery:true` 的 loop 和新建 loop 的行为不变。这样要求要么从 loop 创建时落盘，要么明确失败，不把一次性检查说成持久化升级。

## F-218 陌生 WorldPort 的维度与能力形状回归

新增一个不带业务语义的第三方 WorldPort：状态是 6 维向量，能力是 4 个不透明标识，权重和目标也与五个内置世界不同。它经过 `init → 4 步 run → inspect → replay`，结果为 `COMPLETED`、4 次 accepted，向量维度保持 6，Replay 为 `CONSISTENT`。这说明 Kernel/Application 的共同路径没有依赖温度、桌面、库存、网格或队列的领域名称和固定维度；它仍只是进程内纯模拟证据，不代表真实外部世界已经被统一建模。

## F-219 CLI 外部陌生 WorldPort 回归

把同样的 6 维向量和 4 个不透明能力放进独立 JSONL adapter 子进程，通过公开 CLI 完成 `init → run(4) → inspect → replay`。Windows 本机真实结果为 `COMPLETED`、4 步、终态向量 6 维、Replay `CONSISTENT`。这证明用户不需要修改 Kernel 就能从 CLI 接入不同形状的外部 WorldPort；它仍是受控子进程和模拟状态，不等于真实设备或现实语义已经可信。

## F-220 外部陌生 WorldPort 的连续恢复

先让 6 维外部 WorldPort 完成一个 Run，再关闭 adapter registry，最后用新的 CLI 进程执行 `agent loop --resume` 完成剩余两个 Run。Windows 本机最终 `kernelStep=3`，状态仍为 6 维，三个 Run 均能离线 Replay 为 `CONSISTENT`。这证明维度和能力形状会随 continuation 一起跨进程恢复；恢复链仍依赖 adapter 自身提供的协议状态，不代表现实副作用可自动恢复。

## F-221 长计划历史的内存优化

长计划连续运行时，内部 STEP 会反复处理同一个未变更的计划对象。现在 `ActiveRun` 只在宿主内部复用该对象的序列化结果，公开追加接口仍保持一次性缓存；Replay 则直接读取 LabStore 已解析和校验的事件，不再对完整事件数组做第二次深拷贝。Windows 本机压力用例的 Replay 子进程观测峰值内存从约 1.84 GiB 降至约 0.99 GiB，耗时从约 265 秒降至约 261 秒，相关回归和三平台 CI 均通过。每个 STEP 仍保存完整证据，更大历史仍需要分页、引用或流式 Replay 设计。

## 与 Codex / Claude 的协作方式

这几个工具可以互补：

- 用 Codex 或 Claude 编写新的 `WorldPort`、测试用例和分析脚本；
- 用它们分析 `yi-agent` 生成的事件账本和反例；
- 让它们作为 `ModelAdvisor` 提出候选方案；
- 由 `yi-agent` 的 Kernel、WorldPort、verify 和 learn 决定方案是否真的改变系统状态。

也就是说，Codex / Claude 可以帮助我们建设实验世界，但不替代实验世界本身。

## 只读检查外壳

内核通过反例实验后，桌面面以只读外壳接入（不打包、不注册系统命令）：

```powershell
yi-agent ui --lab E:\labs	emperature          # http://127.0.0.1:<随机端口>
yi-agent ui --lab E:\labs	emperature --port 7899 --json
```

页面每 2 秒轮询 `/api/state`（与 `inspect --json` 同源的只读信封）；服务仅绑定 127.0.0.1、仅 GET、不创建锁、不改变实验空间。任何写操作仍必须走 CLI 与 EffectBroker 的确认/对账边界。

## 安装

需要 Node.js 22 或更高版本。PowerShell 中执行：

```powershell
npm install --global E:\demo\yi-agent
yi-agent --help
```

从公开 GitHub 仓库安装：

```powershell
npm install --global https://github.com/ZDragon17/yi-agent.git#main
yi-agent --help
```

当前包仍未发布到 npm registry；上面的 Git 安装方式已在 Windows 临时 npm 前缀中实测通过。

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

`inspect` 的 `inspectView.stopReason` 直接读取所选终态 Run 的账本终止原因，例如 `NO_SAFE_ACTION`、`EXECUTION_REJECTED`、`OBJECTIVE_REACHED`、`MAX_CYCLES`、`CRASH_HALTED` 或 `EXTERNAL_TRANSITION_UNKNOWN`；没有终态 Run 时返回 `null`，不靠最后一步的表面状态猜测原因。

如果 Advisor 的 API 超时、断开或返回非法 Token，应用边界会记录 `MODEL_UNAVAILABLE` 或 `INVALID_ADVISOR_RESULT`，然后让 Kernel 在同一状态上选择安全候选继续闭环；该回退也会进入账本，因此重启和 `replay` 不依赖模型再次返回相同结果。

`--kernel-only` 显式关闭 Advisor/Planner，只运行共同的 Kernel—WorldPort—verify—learn 闭环，不需要 API Key；它用于证明模型是可替换工具，而不是 Agent 的启动前提。若需要 `--auto-plan`，仍应提供模型配置，或接受 Planner 不可用并回退为根目标阶段。

`agent loop` 是连续运行的 CLI 入口：`--steps` 表示每个可恢复 Run 的步数，`--runs` 表示最多串联多少个 Run；需要长期守护时使用 `--forever`，它与 `--runs` 互斥。每个 Run 都先完成自己的账本提交，再开始下一个 Run；收到 SIGINT/SIGTERM 时只在当前 Run 提交后停止，返回 `INTERRUPTED`。loop 的 `loopId/runIndex/scenario/budget/planningBranchingMode` 会固化到每个 immutable `start.json`，进程重启并完成恢复卡点后，可以用 `yi-agent agent loop --lab PATH --resume --json` 从 current 指向的已校验终态 Run 重建剩余 Run 和规划语义，不必重新输入也不会重复已提交 Run；启用 `--require-recovery` 时，恢复要求也会固化到 continuation，后续 `--resume` 不传该参数仍会在新 Run 前检查外部 adapter。旧 continuation 缺少模式字段时，Runtime 从已提交 STEP 或终态 `externalTransition` 证据推断历史模式，不能推断则保守降级为 legacy。同一 lab 中，一条未完成 continuation 对实验空间拥有唯一调度权；新的 loop 或普通 run 会被拒绝，必须先用 `--resume` 接续，已完成或已停止的历史 loop 不阻塞新实验。发生执行拒绝、无安全动作或显式目标达成时，循环会停止并返回原因。`--forever` 的内存结果摘要只保留最近一个 Run，累计 `runs/metrics` 持续统计，完整历史以 lab 账本和独立 Replay 为准，因此不会随运行时间积累结果对象。进程在一个 Run 内被终止或崩溃时，仍须先用 `recover --confirm-lock-owner-dead` 完成明确的恢复卡点，再使用 `--resume` 继续；若未决外部 transition 已保存原始策略证据，恢复进程暂时没有 API 时也能复用该证据并由 Kernel 继续安全选择；`readLoopContinuation()` 仍提供全量 continuation 审计，`test/e2e/crash-restart-cli.test.mjs` 已用真实子进程强制终止覆盖该路径。
对外部 adapter 使用 `--require-recovery`，可以在 loop 第一个 Run 开始前拒绝没有幂等 transition 或对账契约的配置；普通 `agent run` 不接受该选项。

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

目标评价仍固定在同一底层价值投影上：新 Run 默认的 `valueMode=distance-v2` 用每个观测维度到目标的带权绝对距离打分，`tolerance` 把目标从一个点扩展为可接受带，因此越过目标不会被错误奖励；需要累积效用方向的 WorldPort 可显式选择 `signed-v1`，用带符号权重表达“越大越好/越小越好”。两种模式都不读取领域名称，且会进入 STEP 边界供恢复与 Replay 使用；旧 STEP 缺少该字段时 Replay 保持历史 `signed-v1` 语义，避免演化破坏历史连续性。

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

F-222 增加有限的目标 epoch：前一个目标只有在 `COMPLETED` 或 `HALTED` 后，才能由新的 `goal` 或 `goal-plan` 开启下一目标周期。新周期保留 WorldPort 状态、Memory、RNG 和 kernelStep，只重置监督器的目标局部进度；前后连续性摘要写入 immutable run start，首个 STEP 写入新的 `goalActivation`。如果旧目标仍为 `ACTIVE` 或 `REPLAN_REQUIRED`，CLI 会拒绝替换。这样同一 Lab 可以在完成一个目标后继续推进另一个目标，同时不修改已完成 Run 的历史。这个机制只解决目标生命周期和持久化边界，不把目标文本自动变成可验证的现实意图，也不绕过外部 transition 的恢复与人工对账要求。当前本机定向应用回归为 `4/4`，内置 WorldPort 的 PowerShell-facing CLI E2E 与独立 JSONL adapter CLI E2E 各为 `1/1`。

F-223 增加 Lab 级连续账本 Replay。单个 `replay --run` 只重算一个终态 Run；`replay --chain` 会读取 Lab 中全部终态 Run，先逐个完成同样的确定性 Replay，再按初始 `kernelStep` 检查相邻 Run 的 WorldPort 状态、Memory、RNG 和时间步是否连续。遇到目标 epoch 切换时，它还会核对前一终态、前一监督器和后一监督器的摘要及状态，避免只验证单个 Run 而漏掉目标生命周期断点。该命令严格只读，不启动外部 adapter；如果 current 仍处于 `RUNNING`，会先要求完成恢复。它验证的是账本连续性，不是主动攻击防护、自然语言目标真实性或现实世界效果。

F-224 把 `replay --chain` 的检查延伸到 current 水位。全部 Run 重放完成后，命令还会确认 `current.lastRunId`、READY/HALTED 状态、终态事件序号、事件摘要和状态投影都对应链尾 Run。即使有人重算了一个格式正确的 `current.json` 并把它指回旧 Run，也会返回 `CURRENT_CONTINUITY` 差异，而不会把历史回退误报为一致。该检查仍是账本和持久状态的一致性证据，不是签名信任或现实效果证明。

F-225 增加移动水位检测。`replay --chain` 读取全部 Run 后会重新检查 `current.json`；如果读取前后 current 发生变化，或者读取结束时已有 writer 进入 `RUNNING`，命令返回 `BUSY`，要求在写入完成后重试。这样无锁读路径不会把两个时刻的账本拼成一次结果。它仍不是跨文件事务快照或分布式读写锁。

F-226 将连续 Replay 改为按 Run 流式读取。Runtime 先读取各 Run 的 immutable start 头部完成排序，随后 Application 一次只加载一个完整 Run，Replay 完成后释放它，只保留链连续性所需的前一终态和摘要；全部 Run 完成后还会重新检查 current。这样历史 Run 数量增长不会把所有事件同时堆在内存中。单个 Run 内部仍是完整读取，真正超大的单 Run 还需要事件流式处理。

F-227 将事件流式处理推进到单个 Run。`LabStore.readRunStream()` 通过异步生成器逐行读取和验证 `events.jsonl`，`replayRunStream()` 逐事件重演，只保留当前状态、前一摘要和终态；单 Run 与 chain Replay 都使用这条路径，`replayRun()` 仍保留给纯内存数组调用。10,000 步账本在 `--max-old-space-size=128` 的独立 CLI 进程中 Replay 为 `CONSISTENT`。单行大小、完整账本大小、current 移动检测和离线 Replay 约束没有放宽；这一步也不等于无限历史、磁盘分页、跨文件事务快照或现实执行真实性。

F-228 把同一流式边界用于候选历史恢复。`LabStore.readCandidateOutcomes()` 现在逐个消费每个终态 Run 的事件流，只提取候选结果和有限提案摘要，不再先创建完整事件数组；历史排序、候选注释、跨 Run 的 attempt 与 supersedes 关系保持原语义。Runtime 回归覆盖数组 Run 读取不可用时的候选历史读取，真实 CLI 的候选历史场景继续通过。候选摘要仍需按时间排序并完成历史注释，摘要数量和注释算法的长期上界仍是后续实验，不把这一步说成无限记忆或磁盘分页。

F-229 将候选历史注释改为单次前向扫描。`annotateCandidateHistory()` 用增量索引保存每个作用域的最近 supersedes 候选，以及同一初始状态下最近的两个不同候选，保留 attempt、contextAttempt、步骤间隔、supersedes 质量和配对比较的原有结果。8,000 条重复候选的本机测试耗时从旧实现约 3.4 秒降到约 0.16 秒。该优化只降低计算成本，候选摘要仍可能因全局排序和历史引用而全部驻留；它不等于有界长期记忆或外部排序。

F-230 把未决外部事务恢复改为流式扫描。`findUnresolvedExternalTransition()` 逐个消费终态 Run 的事件流，只保留已提交 STEP 的身份键和未决 terminal evidence，不再同时保留完整 Run 与事件数组；跨 Run 的 nonce、Token、版本和 before 摘要匹配仍按原规则执行。Runtime 和 repo WorldPort 恢复回归通过。已提交身份键集合仍会随 STEP 数量增长，因此这一步只消除事件载荷驻留，不等于无限恢复历史或分布式事务。

F-231 将 legacy loop continuation 的历史扫描也改为流式读取。恢复路径完整消费每个 Run 以验证账本，但只为带 continuation 的 Run 保留 start、terminal 和规划模式摘要；规划模式推断、重复 runIndex 检查、恢复状态和 loop contract 比较保持原语义。流式消费完成后还会把 `end.json` 与终态事件重新核对，维持旧数组读取的完整性边界。连续 Runner、进程恢复和 crash continuation 回归通过；该节点没有改变现代 `--resume` 的 current 优先路径。

F-236 将 legacy loop continuation 的摘要归并移到临时排序块。扫描 Run 时只写 continuation、Run 身份、终态原因/状态和规划模式摘要；归并按 `loopId → runIndex → startedAt → runId` 逐条消费，每次只保留当前 loop、当前逻辑索引和最终候选，不再把整个 loop 的 `group.runs` 放在内存中。旧的 contract、规划模式推断、重复索引恢复规则和缺口检查保持不变。129 个 Run 跨过 128 条排序块边界的 Runtime 回归通过，连续 Runner、恢复和不同 WorldPort 的 CLI 回归继续通过。临时排序块是本机读路径的辅助文件，仍不是持久索引、跨文件事务快照或无限历史；排序块路径和文件句柄也受归并过程的实现容量约束。

F-237 把排序块归并改为多轮。候选历史和 loop continuation 在临时块超过 32 个时，先分批归并并删除已消费块，最终读取阶段最多打开 32 个输入；块内排序键、候选注释和 continuation 状态机没有变化。这样限制的是同时打开的临时文件数量，不能把临时磁盘空间、总扫描时间或最终返回全部历史的接口说成有界。

F-238 收紧 chain Replay 的 Run 头部快照。旧路径会先把所有 `{runId,kernelStep}` 放进数组；现在 `replay --chain` 通过异步目录迭代器读取 Run 目录，以固定大小块做外部排序，再逐条交给 Application。旧的链回放输出、初始 `kernelStep` 排序、current 移动检测和链尾校验保持不变；`readChainSnapshot()` 与 `readAllRuns()` 仍保留数组兼容接口。129 个 Run 跨过排序块边界的 Runtime 回归通过。这个节点减少的是 chain Replay 的 Run 头部驻留，不等于持久索引、跨文件事务快照或无限历史。
