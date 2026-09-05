# CLI v0.1 功能规格

## 根基公理

`yi-agent` 必须始终沿着易经的一体变化逻辑演化：万事万物不是若干套互不相容的底层系统，而是同一套状态—关系—约束—变化—反馈逻辑在不同世界中的投影。

这不是本版本要直接实现的完整哲学系统，而是所有后续实现的不可偏移约束：

1. 领域不同，不等于底层智能逻辑不同；
2. 领域特征只能进入 WorldPort 的世界边界，不能进入 Kernel 的核心判定；
3. 智能必须体现为跨情境的观察、行动、验证、学习和再组织能力，而不是单次文本生成；
4. 二进制、电平、向量、Token 和语言只是表达或执行介质，不能被误认为智能本体；
5. 任何新增机制都必须给出跨领域复用方式和可证伪实验，否则不能成为底座的一部分。

## 目标

把已验证的单页闭环原型演化为一个可持续运行、可重放、可反证的 Agent CLI 实验室，用同一内核在不同世界中积累有证据的经验。

## 为什么

HTML 原型证明了“预期—行动—验证—修正”能够运行，但状态只在内存里，无法跨进程延续、无法严格重放，也无法系统地制造反例。CLI v0.1 的价值是建立后续演化所依赖的实验基础设施，而不是宣称已产生通用智能。

## 非目标

- 不操作真实电脑桌面、真实设备、网络账户或生产系统。
- API 调用只提供显式的 OpenAI-compatible 对话接缝，不把一次 API 调用冒充为自主智能，也不生成或修改自身代码。
- 不追求通用插件生态、GUI、远程服务、多用户和分布式运行；仅提供受控的外部 WorldPort 协议接缝。
- 不把《易经》概念当作科学结论；八个操作只是当前可反证的工程假设。

## 功能需求

### FR-1 建立实验空间

- 输入：尚不存在的本地目录、内置 world id 或显式外部 adapter 配置；可选随机种子。一个实验空间终身绑定一个 world 和 adapter 身份。
- 输出：可识别版本的实验清单、空认知状态和空事件账本。
- 边界：目标路径已存在且不是兼容实验空间时拒绝；重复 init 的 world/seed 必须完全相同，否则冲突。
- 验收：初始化后可由 inspect 读取；不能在目标目录之外产生文件。初始化中断后，下一次 init 只能清理目标目录内本工具创建且带标记的 staging 文件并重试。

### FR-2 运行自主闭环

- 输入：已绑定世界的实验空间、步数、可选兼容场景和可选模型提议器；步数为 1～10000 的整数。CLI 的 `--kernel-only` 模式不要求 API 配置，直接使用共同 Kernel 闭环；新运行的 ValueSpec 使用领域无关的 `distance-v2` 带权绝对距离和 `tolerance` 目标可接受带。
- 输出：每步完整记录界、感、存、预、择、动、验、化，以及最终状态和退出原因。
- 可选推演：`planning.horizon` 为 1～8 的有界模型推演步数，默认 1；仅使用 Kernel 已持久化的经验模型，不把推演状态送入 WorldPort，且必须随 STEP boundary 固化以供 Replay 重建。`kernelLearningVersion: 14` 启用 belief 分支规划：若候选有已验证 belief samples，仅对第一步按最多 8 个样本分支，并且只有分支后的下一步价值相关预期变化真正不同，才以已观测后续决策的不确定性下降计入信息价值；没有样本时严格退化为均值推演。v13 历史 STEP 保留未投影的决策分化规则，v12 保留旧的仅看不确定度规则，12 之前使用 legacy 均值规划。候选与未来模拟能力受固定窗口限制，避免能力面扩大导致平方级展开。
- 延迟反馈：WorldPort 可在后续 observation 的 `feedback[]` 中，按 `executionNonce` 返回此前动作的结果快照；Kernel 对已接受但 `attributionWindowComplete=false` 且无已知混杂的动作暂存有界 pending credit，基线从动作前观测推导；同一步先结算旧 feedback 时，当前新动作的 pending 基线只叠加已明确归属于旧 nonce 的变化，不把当前动作的部分即时变化算进旧 credit。收到匹配反馈后才学习，混杂反馈只结算为 `AMBIGUOUS` 而不学习；若当前动作与旧反馈同一步产生证据，当前动作保守跳过学习。新 Lab 对未匹配反馈按有界观察机会推进 pending credit age，窗口耗尽时标记 `UNRESOLVED/FEEDBACK_TIMEOUT`、移出 pending 且不学习；晚到反馈不再有可归因 credit。`stateVersion` 与 `intervalId` 只是不透明的 WorldPort 边界标识，宿主不得要求固定字符串格式；反馈仍必须经过版本、区间、向量维度、nonce 唯一性和数量上限校验，并随 STEP/Replay 重建；多个合法反馈按 pending credit 的持久顺序规范化结算，不能让 adapter 的传输顺序改变 `settled`、已结算收据或信念样本；若同一批新反馈共享完全相同的 `stateVersion + intervalId`，v7 将其视为同一观测边界，全部按 `AMBIGUOUS` 结算，即使 adapter 声称 `confounderCount=0`，避免把一份快照复制给多个动作学习。
- 监督器对齐：如果本步结算了新的反馈，前后数值观测可能包含旧动作的后验变化；变化监督器不得把该步的 `ACTION && learnable` 回执直接当作当前动作的确认进步，而应将该步记为歧义。已结算 feedback 的 nonce 仍可按 Kernel 规则独立学习。停滞后的 `EXPLORATORY` 新策略使用 `coverage-v1`，在单步选择和有界规划首步都先轮换样本较少的安全候选，再比较不确定度；旧策略缺少该字段时保持 `uncertainty-v1`，不改变历史 Replay。
- 版本边界：带 `kernelLearningVersion: 3` 的 STEP 启用有界已结算反馈收据，带 `kernelLearningVersion: 4` 的 STEP 还启用有界 pending credit 窗口，带 `kernelLearningVersion: 5` 的新 STEP 还启用有界预测信念样本，带 `kernelLearningVersion: 6` 的新 STEP 还启用 feedback 按 pending 顺序规范化，带 `kernelLearningVersion: 7` 的新 STEP 还启用共享观测边界的保守归因，带 `kernelLearningVersion: 8` 的新 STEP 还启用延迟反馈与变化监督器的证据对齐，带 `kernelLearningVersion: 9` 的新 STEP 还启用有界近期变化上下文，带 `kernelLearningVersion: 10` 的新 STEP 还为新上下文历史保存单调动作序号，使延迟反馈结算不改变历史发生顺序，并拒绝重复、超前或缺失动作序号；带 `kernelLearningVersion: 11` 的新 STEP 还以固定大小的顺序敏感累积状态表达超过近期窗口的已验证变化；带 `kernelLearningVersion: 12` 的新 STEP 还启用基于已验证 belief samples 的第一步分支规划；带 `kernelLearningVersion: 13` 的新 STEP 进一步要求分支改变下一步决策/预期变化才计入信息价值；带 `kernelLearningVersion: 14` 的新 STEP 再要求该预期变化落在当前 ValueSpec 的价值几何内。v12 之前的 Replay 保持旧均值规划，v12 保留旧主动信息规则，v13 保留未投影的决策分化规则；旧版本 Replay 移除不属于其版本的字段并保持原有上下文语义；缺少标记或标记为旧版本的历史 STEP 在 Replay 时保持旧 Memory 形状、反馈到达顺序、归因、监督器和上下文语义，不凭空补写新字段。
- 预测信念：新 Lab 可在 `Memory.beliefModels` 中按 `Token×RelationSignature` 保存最近最多 8 个已验证后验变化样本。样本只表达可观察结果的多分支不确定性；Kernel 将其离散度并入不确定性惩罚，并在 `kernelLearningVersion: 14` 的有限规划中按样本估计第一步的信息价值，但不把样本当作隐藏状态事实、权限或执行依据。若后验分支不改变价值相关的下一步预期变化，必须保留多分支但不声称产生信息增益；旧 Lab 不注入该字段，Replay 不补写。
- v15 版本边界：新 STEP 还持久化每个 Token 的验证新鲜度，并在已知安全行动超过固定 8 个已验证动作未复核时进行周期再验证；v15 之前的 Replay 不启用该策略并移除该字段，保持历史选择语义。
- v16 版本边界：horizon 规划还启用临时假设记忆传播，将首步及后续预测动作的变化用于历史上下文条件化；v16 之前的 Replay 强制 `contextMode: legacy-v1`，不改变既有账本的静态上下文规划语义。外部 transition marker 同时绑定该规划模式；缺少模式字段的历史 marker 按 `legacy-v1` 恢复，不静默采用当前版本语义。
- v17 版本边界：horizon 规划还对后续动作的已验证 belief 结果递归分支，并以固定 rollout 预算限制展开规模；v16 及以前的 Replay 强制 `branchingMode: legacy-v1`，保持非递归规划语义。外部 transition marker 同时绑定该分支模式；缺少模式字段的历史 marker 按 `legacy-v1` 恢复，不静默采用当前版本语义。
- v18 版本边界：horizon 规划在递归 belief 分支的每个未来状态内评估有界安全动作树；v17 Replay 强制 `branchingMode: recursive-v1` 保持贪心未来策略，v18 新 STEP 使用 `tree-v1`。外部 transition marker 同时绑定该分支模式；缺少模式字段的历史 marker 按 `legacy-v1` 恢复，不静默采用当前版本语义。
- v25 版本边界：新 Lab 的 STEP 启用多尺度上下文——窗口-1 的 `h0:` 键进入预测回退链（写入按学习版本门控，v24 及以前的 Replay 不产生 h0 键）；带 `contextKeyScale` 的 Memory 把上下文键中的实际变化量化到固定十进制精度，浮点重构残差不参与键身份；同版本的上下文反事实探测允许价值最优选择在本上下文零样本的安全候选上按固定间隔留下 `choice.contextProbe` 探测痕迹，探测只消耗该步选择，不产生额外权限。旧版本 STEP 的 choice 不含该字段，Replay 保持原语义。
- v26 版本边界：新 STEP 的 h2 键基底由位置权重累加器摘要改为最近 8 条已验证变化的窗口摘要（`recentHistory` 容量相应扩至 8，h1 键仍取最近 2 条切片；旧账本 ≤2 条历史时切片数学等价）；v25 及更早的 Replay 继续按累加器基写入 h2 键，记忆形状与历史语义保持不变。v26 的读取始终使用窗口基——旧记忆中的累加器 h2 模型本就永不可读，预测行为不变。同版本以 `kernelLearningVersion: 27`（`revalidationBeliefGate`）把周期再验证（F-40）门控为信念比较：过期行动只有在其预期变化信念不劣于任何安全候选时才被强制重访，全局证据已判劣的冷门候选交由上下文反事实探测层取证；v25 及更早的 Replay（按账本版本传入 `step.learningVersion`）保持无条件重验语义。F-118 更正：长跑中平台「赢家率瓦解」为度量伪影（越过目标后调度赢家不再价值最优，内核正确转入驻留），目标驻留行为由稳定性 E2E 固化。
- 历史上下文：新 Lab 可在 `Memory.recentHistory` 中保存最近最多 2 个已验证的 `{Token,actualDelta}`，并在 `Memory.contextModels` 中按 h1 规范化签名条件化动作模型；`kernelLearningVersion: 11` 另以 `historyAccumulator` 和 h2 精确指纹保存有序长期证据，预测按 h2→h1→关系→总体模型回退。h2 缓存保持极小且有界，以保证连续运行的持久化快照不会随历史线性膨胀。上下文不是领域语义、隐藏状态事实或权限依据；未闭合 feedback、混杂和拒绝不进入历史；旧 Lab 不注入新字段，Replay 不补写。
- 历史顺序：新 Lab 额外保存有界 `historyClock`，并将动作序号写入 pending credit 与近期历史；反馈晚到时按动作序号重排近期历史，而不是按反馈到达顺序重排。旧 Memory 没有时钟则保持原有历史形状和语义，不强行迁移。
- 验证新鲜度：新 Lab 在 `Memory.lastVerifiedSteps` 中按不透明 Token 保存最近一次已验证证据的逻辑序号；当一个仍然安全的已知行动距上次验证达到固定 8 个已验证动作时，Kernel 在没有未尝试行动时优先重新验证最久未验证的行动。该策略只获取新证据，不修改安全/授权边界；`Expectation.verificationAge` 让选择理由可审计。旧 Memory 没有该字段时保持原有选择语义，Replay 以 `kernelLearningVersion: 15` 区分。
- 边界：没有安全行动或模拟 transition 拒绝时记录 HALTED；世界代码异常为内部错误，持久层异常为 I/O 错误，均立即停止且不得记为一次已执行行动。
- 验收：每个已执行动作都能找到先验预测、执行回执、后验观测、误差归因和学习结果；越过目标的动作不能仅因带符号方向而被判定为更优，旧账本仍可按其固化的兼容语义 Replay。

### FR-3 跨进程持续学习

- 输入：同一实验空间上的后续 run。
- 输出：在版本兼容且证据完整时复用已有认知；世界实例状态和 Agent 认知分别恢复，未完成的 pending credit 也跨 Run/进程保留。
- 边界：状态损坏、版本不兼容、事件序列断裂时进入 CORRUPT/HALTED，禁止继续行动。
- 验收：从同一已初始化 lab 的相同语义起点/tokenMap 做两个隔离分支：一支跨进程运行 15+15，另一支参考执行 30 步；同外部输入下 `{worldState,memory,rngState,kernelStep}` 规范化投影完全相等。runId、时间、run 边界和摘要链不参与比较。
- 连续配置：`agent loop` 的推演步数和 `planningBranchingMode` 随 continuation 持久化；恢复时不得通过新的 CLI 参数静默改变，旧 continuation 缺少模式时从已提交 STEP 或终态 externalTransition 证据推断，无法推断则保守按 legacy 继续。
- 外部恢复：adapter transition 前的 in-flight marker 必须固化同一推演配置；响应丢失后的幂等重试在未显式指定时恢复 marker 配置，显式冲突必须拒绝。
- 反馈恢复：反馈只能结算同一实验空间内已持久化的 execution nonce；同一 nonce 的完全相同反馈在有界已结算收据窗口内可幂等忽略，未知或相互矛盾的反馈必须 fail-closed，不得追加 STEP 或污染 Memory；超出收据窗口的旧重复反馈视为未知。

### FR-4 确定性重放

- 输入：一次已完成或中止的 run 标识。
- 输出：从每 Run 不可变起点重新执行纯 World 模拟、Kernel 决策和 RNG，并与账本逐步比较，报告首个不一致位置；另可做账本归约检查，但不能替代决策重执行。
- 边界：重放不得调用真实执行器副作用，不得改写账本和认知。
- 验收：正常 run 决策重放一致；注入非确定决策或篡改一个事件字段后明确失败且定位序号。

### FR-5 反例实验

- 输入：内置 challenge suite 或单个场景。
- 输出：内置挑战给出预测、原始观测指标和演示性三态结论；独立 Tester 通过晚绑定生成世界给出外部反证结论。
- 首批挑战：未知行动探索、规律突变、行动执行失败、行动中外部事件、全部动作不安全、持久化中断、重放篡改、界面/inspect 只读；另以不向 Kernel 暴露隐藏模式的外部 WorldPort 检验同一可见关系下的多分支后验、跨进程记忆和 Replay。
- 验收：suite 以机器可判定结果结束；任何未运行项不得计为通过。内置 PASS 不能被表述为“证明自主”，最终只允许报告“在外部测试集合 X 上未被证伪”。

### FR-6 可解释检查

- 输入：实验空间，可选 runId 或 `runId:sequence` action 引用。
- 输出：当前边界、目标、约束、事实/假设、行动模型、样本数、不确定度、最近归因和停止原因。
- 边界：inspect 严格只读；连续调用不能改变摘要哈希。
- 验收：用户能从输出追溯“为什么选、凭什么学、为什么停”。

### FR-7 双层安全约束

- 输入：候选行动和 WorldPort 执行请求。
- 输出：选择层排除不安全/不允许动作；执行器再次独立校验。
- 边界：全部动作不安全时不得 fallback；未知 action id 必须拒绝。
- 验收：故障注入下执行计数保持 0，事件账本记录 HALTED 和原因。

## 非功能需求

- 可移植设计：仅用跨平台 Node API、无 shell 依赖；v0.1 在当前 Windows 环境做真实 E2E，Linux/macOS 未有 CI 证据前不得宣称已验证。
- 性能：模拟世界 10000 步在当前开发机上 30 秒内完成，且每步证据完整写入；结果记录机型与磁盘环境。
- 可靠性：快照采用临时文件加原子替换；JSONL 事件只追加；单 writer 锁防并发污染。
- 恢复：活动 Run 的账本若只有一个无换行的撕裂尾部，显式 recovery 可在同步截回最后完整事件后生成 `CRASH_HALTED`；带换行的畸形证据或已终态账本尾部仍必须 `CORRUPT`。
- 安全：路径归一化并限制在实验目录；宿主不在进程内动态导入外部代码，外部 adapter 只通过无 shell、有限时限和有限输出的 JSONL 协议调用；外部输入必须由整步摘要绑定并通过 manifest 绑定的 Ed25519 公钥验签；日志无敏感数据。
- 可审计：事件带 schemaVersion、runId、sequence、时间、前后状态摘要和因果字段。

## 术语

| 术语 | 定义 |
|---|---|
| WorldPort | 世界与内核之间的窄接口，负责观测、列行动、执行和安全兜底 |
| Memory | 有证据来源的持久认知，不等同于聊天上下文 |
| Run | 从 READY 到 COMPLETED/HALTED 的一次有界闭环执行 |
| Replay | 不产生世界副作用的事件重建与一致性核验 |
| Challenge | 为证伪某条底座假设而设计的可判定实验 |
| 惊异 | 已有足够经验后，结果显著偏离行动前预测 |
| 经验效应 | 在已观测条件下得到的行动—结果统计关系；没有对照/随机干预时不得称为严格因果 |
