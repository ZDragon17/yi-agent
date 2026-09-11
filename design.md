# CLI v0.1 设计契约

## 0. 不可偏移的根基：易经原始基因

本项目的最高层设计公理是：万事万物共享一套底层变化逻辑，具体领域只是这套逻辑在不同边界、尺度、关系和约束下的投影。易经在本项目中不是一个待接入的领域插件，而是决定系统如何理解“状态、关系、变化、行动、反馈和再变化”的原始基因。

工程约束如下：

- 电平高低、二进制、数值向量、不透明 Token 和领域对象属于不同表达层；不能把某一表达层误认为智能本身；
- 所有领域必须通过同一套观察—行动—验证—学习闭环接入；金融、医疗、组织、设备和软件的差异只能由 WorldPort 的状态、观测、能力和约束表达；
- Kernel、Memory、Replay 和智能判据必须保持领域中立；新增领域特判、孤立维度或单独一套底层逻辑，均视为架构偏移；Memory 可以按观测相对 ValueSpec 的关系签名和近期已验证变化上下文条件化，但不能按领域标签条件化；变化模型必须允许有界近期证据修正过时历史，不能把世界假定为永久静态；对部分可观测变化，只能保存有界的后验分支信念，不能把隐藏状态猜测提升为事实；
- 每一项扩展必须回答：它对应哪条共同变化规律、如何被反例检验、如何在另一个领域复用；不能只用模型提示词或演示结果宣称成立；
- 易经思想是架构公理和可证伪的工程方向，不把卦象、数字或哲学判断直接冒充为科学定律。

因此，WorldPort 的职责不是把每个领域封装成一个独立智能，而是把同一底层变化逻辑投影到一个可观察、可行动、可验证的世界边界。任何未来的 Planner、Supervisor、长期记忆、自我改进和真实执行器，都必须服从这条根基。

## 1. 系统边界

- 内核负责：闭环时序、候选预测、安全筛选、探索、执行回执处理、验证归因、学习和停止。它只看到数值向量、ValueSpec 和不透明 action token；学习同时维护 Token 总体变化模型、`Token×RelationSignature` 条件变化模型和可选的有界预测信念样本。ValueSpec 支持两种领域无关的价值投影：`distance-v2` 以带权绝对距离评价目标并允许 `tolerance` 表达目标可接受带，`signed-v1` 以带符号权重表达效用方向；Application 默认选择前者，但显式 WorldPort 的模式必须保留到 STEP、恢复和 Replay。缺少 `valueMode` 的旧输入仍按 `signed-v1` 回放。
- Runtime 负责：实验空间、单 writer 锁、事件追加、快照、恢复和重放。
- WorldPort 负责：领域观测向量、实验空间初始化时随机生成且在该空间内稳定的 action token、纯状态 transition、独立 AuthorityPolicy 安全兜底、场景扰动和可延迟的反馈快照。v0.1 的内置世界没有真实外部副作用。
- Application 通过显式 `WorldRegistry` 注入 `worldDefinition/createManifestParts/createWorld/valueSpec/scenarioExternalInputs`；默认 registry 注册五个内置世界，测试或宿主可在进程内注入第三方适配器，CLI 不开放动态代码发现。
- CLI 负责：参数解析、调用应用服务、结构化/人类可读输出和退出码，不直接修改内核状态。
- API client 负责：读取环境变量、调用 OpenAI-compatible `/models` 与 `/chat/completions`；它是显式工具，不进入 Kernel 的确定性决策链。
- ModelAdvisor 负责：把有限的数值观测、经有界投影的 observation evidence、目标和值域上下文转换为一个不可信的 token 提议；它不能写状态、调用 WorldPort 或更新 Memory。它可读取受限的总体/关系记忆摘要，但 Kernel 不接受其对记忆的改写。Application 将其视为不可靠外部输入：调用失败或输出不符合契约时回退到 Kernel 的确定性选择，并持久化 `MODEL_UNAVAILABLE`/`INVALID_ADVISOR_RESULT` 证据。
- ModelPlanner 负责：把有限的数值观测、同一有界 observation evidence、根目标和值域上下文转换为不可信的阶段目标提议；它只能建议目标向量，不能改权重、权限、Token、WorldPort 状态或 Memory。Application 必须先用当前 ValueSpec 物化并校验计划，才允许激活或修订；失败时首次激活退回单阶段根目标，停滞修订则保留原计划。
- ChangeSupervisor 负责：在不认识领域名称的前提下，根据 `ValueSpec` 计算目标距离，区分确认变化与歧义/拒绝，累计停滞，要求重规划，并在目标达成或预算耗尽时给出停止判定；它不能执行 WorldPort、调用模型或自行改变目标。运行时把目标是否由用户显式激活（`enabled`）与目标文本一并持久化，后续 Run 不传 `--goal` 也延续同一监督意图；记录原因后可开启下一周期，避免跨 Run/进程丢失连续性。
- v0.1 默认含 `temperature`、`virtual-desktop`、`inventory`、`grid` 与 `queue` 五个内置模拟世界；另提供显式外部 WorldPort adapter 协议，但不提供动态发现、任意 in-process import 或真实副作用保证。
- 信任边界：CLI 参数与磁盘数据都按畸形/损坏输入校验；无密钥 SHA-256 链只检测偶然损坏或未重算篡改，不提供对主动攻击者的真实性证明。

依赖方向：`cli -> application -> kernel <- world ports`，`application -> runtime`，`cli -> api client`。Kernel 不依赖文件系统、终端、网络、具体世界或时钟。

## 2. CLI I/O 契约

| 命令 | 输入 | 正常输出 | 错误与退出码 | 幂等/超时 |
|---|---|---|---|---|
| `init --lab PATH --world ID [--seed N] [--adapter CONFIG]` | 不存在的目录、内置或外部世界、32 位种子 | manifest 与空认知快照；exit 0 | 参数 64；冲突 65；I/O 74 | world/seed/adapter 身份相同才幂等 |
| `run --lab PATH --steps N [--scenario ID] [--adapter CONFIG] [--json]` | 已初始化空间、1..10000 | runId、指标、停止原因；exit 0 | HALTED 2；损坏 3；参数 64；内部 70；I/O 74；BUSY 75 | 单 writer；当前 Windows 机型长跑最长 60 秒 |
| `inspect --lab PATH [--run ID|--action RUN:SEQ] [--adapter CONFIG] [--json]` | 实验空间 | 固定 snapshot watermark 的 InspectView | 损坏时部分诊断+3；参数 64；不存在 66；内部 70；I/O 74 | 原子快照只读；不创建锁 |
| `ui --lab PATH [--port N] [--adapter CONFIG] [--json]` | 已初始化实验空间 | stdout 打印一次 listening 信封，长驻至 SIGINT/SIGTERM；页面每 2s 轮询 `/api/state`（inspect 同源只读信封）；非 GET 405 | 参数 64；不存在/路径逃逸 66/70；I/O 74 | 仅绑定 127.0.0.1；只读：不创建锁、不写文件、不消耗随机源；无 CORS 头 |
| `replay --lab PATH --run ID [--adapter CONFIG] [--json]` | 终态 run | 一致或首个差异序号 | 不一致/损坏 3；参数 64；不存在 66；内部 70；I/O 74；未终态 75 | 终态文件不可变；严格只读 |
| `replay --lab PATH --chain [--adapter CONFIG] [--json]` | Lab 内全部终态 Run | 每个 Run 的 Replay 与跨 Run 连续性 | 不一致/损坏 3；参数 64；不存在 66；内部 70；I/O 74；有运行中 Run 75 | 只读；按初始 kernelStep 排序；不启动 adapter |
| `challenge --lab PATH [--suite foundational|--case ID] [--json]` | 主实验空间仅作证据归属 | 每个 case 的 PASS/FALSIFIED/INCONCLUSIVE | 任一 FALSIFIED 2；无证伪但有 INCONCLUSIVE 3 | 每 case 使用隔离子实验空间 |
| `recover --lab PATH --confirm-lock-owner-dead [--json]` | 显式恢复请求 | stale lock 证据、恢复后的 current | 活进程/未确认 75；损坏 3；参数 64；I/O 74 | 唯一允许处理陈旧锁的命令 |
| `effect plan|confirm|execute|reconcile|compensate|reconcile-compensation|inspect --journal PATH [--sandbox-root PATH] [--intent PATH] [--nonce N] [--json]` | EffectIntent、durable journal、显式标记 sandbox | EffectBroker 状态快照或全部 effect 状态 | 参数 64；损坏 3；不存在 66；I/O 74；状态错误 70 | 每次进程从 journal 恢复；execute/compensate 只允许标记 sandbox root |
| `api test [--json]` | 环境变量中的 API 配置 | 连通状态与模型数量 | 参数 64；API 74；协议 70 | 无本地状态副作用 |
| `adapter test --adapter CONFIG [--require-recovery] [--json]` | 外部 WorldPort 配置与其声明角色 | `READY`、世界描述、能力/场景、状态依赖动作/幂等 transition/对账能力、`recoveryMode` 和角色摘要 | 参数/配置 64；协议 70；I/O 74 | 只执行配置归一化与 `hello` 探针，不创建 Lab、锁或账本；`--require-recovery` 在 `blocked` 时返回 `CONFLICT` |
| `ask --prompt TEXT|--prompt-file PATH [--json]` | 环境变量中的 API 配置与用户提示 | 模型、回答、可选 usage | 参数 64；API 74；协议 70 | 单次非流式请求；提示文件只读 |
| `agent run --lab PATH --steps N [--kernel-only] [--scenario ID] [--adapter CONFIG] [--goal TEXT] [--goal-plan PATH|--auto-plan] [--json]` | 已初始化实验空间；默认使用 API，`--kernel-only` 不需要 API 配置 | 闭环 run 摘要 | 参数 64；安全停机 2；API 74；协议 70 | 默认每步一次模型提议；`--kernel-only` 只运行 Kernel；`--auto-plan` 激活持久化 Planner 策略；停滞时只修订未完成计划；replay 不访问 API |
| `agent loop --lab PATH --steps N [--runs N|--forever] [--require-recovery] [--kernel-only] [--scenario ID] [--adapter CONFIG] [--goal TEXT] [--goal-plan PATH|--auto-plan] [--json]` | 已初始化实验空间；默认使用 API，`--kernel-only` 不需要 API 配置；`--runs` 与 `--forever` 互斥；`--require-recovery` 只允许声明幂等或对账的外部 adapter | 多 Run 摘要；长期模式可返回 `INTERRUPTED` | 参数 64；安全停机 2；API 74；协议 70 | Run 串行提交；同一 lab 只允许一条未完成 continuation 持有调度权；安全门在第一个 Run 前执行；SIGINT/SIGTERM 只在 Run 边界停止；loop 身份、预算和 recovery requirement 写入每个 Run start，重启可从 current 继续 |
| `agent loop --lab PATH --resume [--kernel-only] [--adapter CONFIG] [--json]` | 已存在的未完成 loop continuation；默认需要新提议时使用模型，`--kernel-only` 始终离线 | 从账本重建的剩余 Run 摘要 | 参数 64；不存在 66；冲突 65；API 74；协议 70 | 不重新接受 steps/runs/goal 等控制参数；按 immutable Run start 的 loopId/runIndex/scenario/budget/recovery requirement 恢复，已提交 Run 不重复；持久化了 `requireRecovery` 的 continuation 会在恢复前再次检查外部 adapter；恢复模式可在无 API 配置下使用 Kernel 安全选择继续，未决外部 transition 则复用冻结策略证据 |
| `experiment pair --lab PATH --output PATH --left-token TOK --right-token TOK [--scenario ID] [--resume] [--json]` | 已完成的内置 WorldPort 父 Run；两个不同 Token；首次创建或恢复配对实验 | `pair.start.json`、两个隔离分支和 `pair.end.json` | 参数 64；父状态/证据冲突 65；损坏 3；I/O 74 | start/end 只追加一次；父 Lab 只读；分支可在左侧完成后通过 `--resume` 接续；仅支持无真实副作用的内置 WorldPort |

标准错误对象：`{code, message, context?, recoverable}`。`--json` 时成功或失败都只在 stdout 输出一个 JSON envelope，stderr 保持空；仅 CLI 启动前的致命错误可写 stderr。人类模式的错误写 stderr。

JSON envelope 固定为成功 `{schemaVersion:1,ok:true,data:{...}}`，失败 `{schemaVersion:1,ok:false,error:{code,message,context?,recoverable}}`，不得同时出现 data/error。

全局退出码：`0=成功`，`2=安全停机或 challenge FALSIFIED`，`3=完整性失败或 INCONCLUSIVE`，`64=参数`，`65=初始化/版本冲突`，`66=资源不存在`，`70=内部世界/程序错误或 API 协议错误`，`74=文件 I/O 或 API 请求失败`，`75=writer 冲突或 run 未终态`。所有命令使用同一映射。

内置 world/scenario：`temperature` 支持 `steady`、`regime-shift`、`external-during-step`、`execution-rejected`、`all-unsafe`；`virtual-desktop` 支持 `steady`、`new-files`、`external-during-step`、`execution-rejected`、`all-unsafe`；`inventory` 支持 `steady`、`supply-shock`、`external-during-step`、`execution-rejected`、`all-unsafe`；`grid` 支持 `steady`、`blocked-route`、`external-during-step`、`execution-rejected`、`all-unsafe`；`queue` 支持 `steady`、`burst`、`external-during-step`、`execution-rejected`、`all-unsafe`。Foundational case id 固定为：`unknown-action-exploration`、`regime-shift`、`execution-rejected`、`external-during-step`、`all-unsafe`、`snapshot-write-failure`、`replay-tamper`、`inspect-readonly`、`world-diversity`。

| 运行项 | 正确实现的期望语义 | exit | JSON data 必填 |
|---|---|---|---|
| run/steady、run/regime-shift、desktop/new-files | 达到 steps，`stopReason=COMPLETED` | 0 | runId,status,stopReason,steps,metrics,evidence |
| run/external-during-step | 完成；受影响 step 为 `AMBIGUOUS,learnable=false` | 0 | 上述字段+attributionCounts |
| run/execution-rejected | 首个 transition 拒绝后 `HALTED/EXECUTION_REJECTED` | 2 | runId,status,stopReason,evidence |
| run/all-unsafe | act/transition 次数 0，`HALTED/NO_SAFE_ACTION` | 2 | runId,status,stopReason,evidence |
| challenge 任一 foundational case | 正确检测预设现象，case verdict=PASS | 0 | campaignId,cases[{id,verdict,evidence}] |
| challenge 发现实现不满足判别器 | 至少一项 FALSIFIED | 2 | 同上 |
| challenge 装置无效或证据不足 | 无 FALSIFIED 且至少一项 INCONCLUSIVE | 3 | 同上+invalidator |
| inspect | 状态不变，InspectView schema 完整 | 0/损坏时3 | inspectView 或 partial+error |
| replay 终态一致/不一致 | CONSISTENT / 首差异 | 0/3 | runId,verdict,firstDifference? |
| replay --chain 连续/不连续 | CONSISTENT / 首个 Run 或跨 Run 差异 | 0/3 | checkedRuns,checkedSequences,goalEpochs,runs,firstDifference? |
| recover | 仅死 owner 且显式确认后恢复 | 0/75/3 | previousLock,recoveryAction,status,evidence |

退出码可重复装置：64 用非法 steps；65 用不同 seed 重复 init；66 用不存在 run；74 用“父路径是普通文件”的 lab 路径产生 ENOTDIR；75 由测试进程先持有 writer lock、recover 检测活 owner 或 replay 无 end run。2/3/70 分别用内置安全停机、tamper/INCONCLUSIVE、注入的测试 World 异常产生。

### 核心内部接口契约

| 接口 | 输入 | 输出/错误 | 副作用与幂等 |
|---|---|---|---|
| `createWorldPort(config)` | immutable manifest、显式 scenario | 同构的 WorldPort 实例 | config 是纯 transition 的完整环境输入；Application 必须把 scenario 写入 immutable Run start，Replay 只能据此重建，禁止依赖进程默认值 |
| `WorldRegistry` | world id、稳定 worldVersion、worldImplementationDigest、manifest、scenario 和 state version | WorldPort、ValueSpec、声明式 externalInputs | Application 的适配边界；新实验把 worldVersion 与实现摘要固化进 manifest，继续运行/恢复/Replay 必须校验同一世界身份；未知世界只能通过显式 registry 注入，外部输入必须成为可摘要、可重放的证据 |
| `ExternalWorldPort` | 显式 adapter config、JSONL request | JSONL response 或协议错误 | 宿主使用 `shell:false`、固定 executable/args、超时和输出上限；`stateVersion`/`intervalId` 是 adapter 提供的不透明边界标识，不强制其字符串格式；revision、nonce、manifest policy 和前后状态连续性由宿主绑定；真实 transition 必须由 adapter 声明是否支持同 nonce 幂等恢复 |
| `WorldPort.observe(state)` | immutable worldState | `Observation{vector:number[],stateVersion:string,intervalId:string,evidence[],feedback?}` | 纯函数，不消耗策略 RNG；`feedback[]` 以 `executionNonce` 绑定此前动作的后验快照，数量、nonce、版本、区间、维度和混杂计数均受限；v29 可选 `creditChain` 声明有界动作链份额，v30 可选 `counterfactual-additive-v1` 成员 delta，v31 可选 `counterfactual-attested-v1` 描述符签名，v32 可选 `counterfactual-independent-v1`，由独立 witness 对相同反馈元数据和成员 nonce 产生第二份签名证据 |
| `WorldPort.actions(manifest,state?)` | 实验空间 manifest，可选当前 immutable worldState | `Capability{token:string,cost:number,allowed:boolean,safe:boolean}[]` | token 在同一 lab 跨 Run 稳定、跨 lab 可置换；allowed/safe 是 WorldPort/AuthorityPolicy 基于当前边界生成的领域盲安全投影，不含领域标签；外部 adapter 只有 `hello.supportsStateDependentActions:true` 才收到 state，省略该声明的旧 v1 adapter 保持兼容 |
| `WorldPort.transition(state,request)` | immutable worldState、冻结的 `manifest{tokenMap,authorityPolicy}`、`ActionRequest{token,basedOnVersion,policyVersion,constraintsDigest,executionNonce}` | `{nextWorldState,receipt,postObservation}` 或拒绝 receipt | 内置 WorldPort 是纯函数；外部 WorldPort 可产生现实变化，但必须以 executionNonce 作为持久幂等键，版本比较、AuthorityPolicy、效果和版本递增仍构成单一 transition；外部 adapter 通过 manifest 解析 opaque token，不依赖宿主内部实现 |
| `Kernel.step(input)` | `KernelObservation{vector,stateVersion,intervalId}`、memory、ValueSpec、capabilities、显式 rngState | `StepIntent{status,expectation,choice,nextRngState}` 或 `Halt` | Application 从 WorldPort Observation 剥离 evidence 后投影；纯函数；`distance-v2` 用带权绝对距离和可接受带，`signed-v1` 保留效用方向；缺少版本标记的旧账本保持 `signed-v1` Replay；未知安全行动先于已学习行动探索 |
| `Kernel.verify(input)` | `step` 原样返回的 StepIntent、receipt、投影后的 KernelObservation | `Verification{error,attribution,confidence,learnable}` | 纯函数；预测/选择/回执 token 必须一致；策略版本、约束摘要和 nonce 由 WorldPort/Application 绑定；当前动作证据不足为 AMBIGUOUS，延迟结果由 `learn` 按 pending credit 单独结算 |
| `Kernel.learn(input)` | 已验证当前动作、后验 observation 和持久 Memory | `{status,token,nextMemory,settled?}` | 纯函数；内部重算并绑定 Verification 与原始执行证据，`ACTION && learnable` 更新总体模型、关系条件模型和当前近期上下文模型，`EXECUTION_REJECTED` 更新不含领域文本的最近关系拒绝证据；窗口未完成且无已知混杂时保存有界 pending credit，基线从动作前观测推导，并叠加同一步已明确归属于旧 nonce 的 clean feedback，排除当前动作的部分即时变化；后续匹配 feedback 才更新对应 Token/关系/动作上下文模型，混杂 feedback 只产生不可学习的 AMBIGUOUS settled 记录，同一步存在 settled feedback 时当前动作保守不学习。v29 的单条 clean feedback 若携带完整、不重叠且按 pending 顺序排列的 `creditChain`，则把锚点前置观测到反馈快照的净变化按闭合份额分别写入链成员，并输出 `ACTION_CHAIN`；v30 可改用 `counterfactual-additive-v1` 成员 delta，逐维验证其和是否闭合到实际变化，不闭合就全部以 AMBIGUOUS 结算且不学习；v31 还要求 `counterfactual-attested-v1` 的成员链通过当前 WorldPort 描述符公钥对完整反馈快照的验签，然后复用 v30 闭合规则；v32 还要求 `counterfactual-independent-v1` 同时具备主 adapter 和独立 witness 的签名，且两者成员 delta 完全一致，再复用 v30 闭合规则；这些都是 WorldPort 的可审计证据，不是 Kernel 自证现实因果。已验证变化按固定大小写入 recentHistory，未闭合、拒绝或混杂结果不进入历史；新 Memory 通过 historyClock 为动作分配单调序号，延迟 feedback 结算时按该序号重排历史，不让传输顺序改变上下文。v6 及以后多个合法 feedback 先按 pending credit 的持久顺序规范化，保证传输顺序不泄漏进 `settled`、已结算收据或信念样本；v7 对同一 `stateVersion + intervalId` 的多个新 feedback 全部按共享观测边界保守结算为 AMBIGUOUS，防止同一快照复制给多个动作；Replay 对 v5 及以前显式保留历史到达顺序及旧归因语义。模型更新使用固定有界变化窗口，使近期证据可修正非平稳动力学 |
| `ChangeSupervisor.advance(state,input)` | 当前监督状态、完整 `Verification`、前后含 `stateVersion/intervalId` 的观察及本步新 feedback 结算标记 | 新监督状态，或 `REPLAN_REQUIRED`/终止状态 | 纯函数；只承认没有新 feedback 结算且满足 `ACTION && learnable` 的即时目标距离下降为确认进步，避免旧动作后验冒领当前动作进步；不接触领域标签、模型、WorldPort 或 I/O |
| `ChangeSupervisor.resume(state)` | 上一周期的持久化状态 | 下一变化周期的 `ACTIVE` 状态 | 记录 `runtime-continuation` 原因并清零当前停滞；不重置目标、周期计数、最佳距离或历史变化证据 |
| `ChangeSupervisor.acknowledgeReplan(state,reason)` | `REPLAN_REQUIRED` 状态、有限原因 | 恢复为 `ACTIVE` 的监督状态 | 清零停滞、增加 `replanCount`，并在 `strategy` 中以版本化方式切换 `BALANCED/EXPLORATORY`；不改变目标、权重或历史周期 |
| `Kernel.step(...,strategy)` | 观察、记忆、ValueSpec、能力、RNG 和可选策略 | 确定性 `StepIntent` | `BALANCED` 延续价值排序；新的 `EXPLORATORY + coverage-v1` 在单步选择和有界规划首步都先按样本数覆盖安全候选、再按不确定度选择，旧策略缺少该字段时保持 `uncertainty-v1`；任何模式都不能绕过 allowed/safe |
| `runContinuous(input)` | lab、每 Run 步数、Run 数上限或 persisted continuation | 多个已提交 Run 的汇总 | 每个 Run 的 loopId/runIndex/scenario/budget/planningBranchingMode 固化在 immutable start；同一 lab 的未完成 continuation 在 writer lock 内原子地排他，且只接受与持久化 `nextRunIndex` 相等的下一逻辑 Run；resume 从 verified current 指向的终态 Run 重建 nextRunIndex 和历史规划分支模式，旧 continuation 缺失模式时按已提交 STEP 或终态 externalTransition 证据推断、无法推断则 legacy；显式 `readLoopContinuation()` 仍提供完整账本审计；当前调用遇到终止原因即停止串联，目标达成完成 continuation，崩溃和可幂等外部不确定保留恢复入口，不把失败伪装成持续成功；forever 模式只保留最近 Run 摘要，累计指标与完整历史分离，避免内存随 Run 数增长 |
| `LabStore.append(event)` | 完整事件、预期 run sequence/digest | 已 flush 的 sequence/digest | 单 writer；冲突拒绝；只追加 |
| `LabStore.commit(snapshot)` | 与已追加事件同 sequence 的快照 | 原子替换结果 | 可重复；快照只能追平账本，不能领先 |
| `Replay.decision(run)` | immutable start、事件、外部输入 | 首差异或一致 | 只读；按 start 的 world/scenario 重建纯 World+Kernel+RNG；每个 STEP 的 `boundary.valueSpec` 是不可变决策输入 |
| `Challenge.evaluate(case)` | 隔离 run 证据、预注册判别器 | 演示性三态结论+invalidator | 不读主实验 memory，不合并状态；不得作为自主证明 |

外部 adapter 的 `hello`、`initialState`、`actions`、`observe`、`externalInputs`、`transition` 均以单次 JSONL 请求响应完成；运行期由宿主把外部输入视为潜在混杂，强制 accepted action 标记为 `AMBIGUOUS` 且不可学习。协议 v1 要求 accepted receipt 的 `effectDigest` 等于 `canonicalDigest(nextWorldState)`，rejected receipt 等于 `canonicalDigest(state)`，从而把回执绑定到连续性状态。若 `hello.supportsIdempotentTransitions:true`，adapter 必须在现实变化提交前持久化 nonce→原始结果记录，响应丢失后的同 nonce 请求只能返回该结果，不能重复执行；宿主还必须把原始 token、basedOnVersion、beforeDigest 和 nonce 作为一次性重试约束，并在 checkpoint 模式下先同步 STEP 再删除 in-flight marker；若未声明，宿主会把 accepted transition 的响应丢失标记为 `EXTERNAL_TRANSITION_UNKNOWN`，并阻断后续 Run，等待外部人工对账。外部 Run 的 Replay 使用 STEP 中冻结的 before/after capabilities、观测、回执和 afterState 证据磁带，inspect/replay 只校验本地 adapter 启动摘要，不启动 adapter 子进程，不读取实时环境。

F-148 为外部 adapter 增加显式的 `transport: "persistent-jsonl"` 选项；未声明该字段的旧配置仍使用一次请求一进程。持久模式先用一次性进程完成 `hello` descriptor probe，再启动一个长生命周期子进程复用后续 JSONL 请求；宿主按请求串行化、限制 stdout/stderr、为每个请求设置 timeout，并在超时、协议污染或子进程退出时杀掉当前会话且不自动重放原请求。下一次 `observe/actions/transition/reconcile` 会建立新会话，是否继续只能由既有幂等 nonce 或 reconciliation 契约决定；CLI 在 Run/agent 结束或失败时显式关闭会话，Replay 继续只消费冻结证据，不启动持久 adapter。该 transport 仍是同一用户权限下的进程边界，不是沙箱、远程证明或现实执行真相。

F-186 增加异步 `transport: "tls-jsonl"`。远程 adapter/observer 不再启动本地 executable，而是使用 host/port 与绝对路径 TLS 材料建立一次一请求的 mTLS JSONL 连接；客户端强制校验 CA、server name 和服务端证书，服务端强制校验客户端证书。TLS 材料摘要、endpoint 和 transport 进入 launch digest，继续运行时由 manifest 比较，响应超时、证书失败、额外 JSONL 行和超限内容均在 `hello`/请求边界 fail-closed。Replay 与 inspect 只使用 identity-only registry，不触碰远端；本地 E2E 已验证远程主 WorldPort、远程 reconciliation observer、错误 CA 拒绝和远端停止后的离线 Replay。这闭合的是可审计的网络/身份传输边界，不是远端主机诚实、低权限 OS、可信硬件或物理效果证明。

F-187 将 `tls-jsonl` 接入非幂等恢复实验。主远程 WorldPort 在第一次 transition 已写入效果后丢失响应，宿主保存未决 Run；服务端退出并在相同 endpoint 重启，下一次 CLI 使用同一 execution nonce 发送 `reconcile`，再由独立远程 reconciliation observer 校验结果。效果文件的计数保持为 1，两个远程服务停止后 Replay 只读本地账本并返回 `CONSISTENT`。这补上了远程服务重启与跨 WorldPort 恢复的一条可验证路径，仍不证明远程代码诚实、私钥隔离或物理设备已经执行。

F-188 收紧 TLS JSONL 的响应结束条件。第一行合法 envelope 只代表响应已被解析，不能代表连接内容已经结束；客户端继续读取到远端发送 FIN，允许空白换行，但拒绝后续非空字节。这样，分包或延迟到达的第二个 envelope 不会因为第一包已经完成而逃过校验；服务端不结束连接也会在请求超时后失败。协议污染 E2E 与远程恢复、observer 回归合计 `4/4`，Replay 仍不接触远端。

F-189 在 F-187 的恢复窗口轮换远程 primary 的服务端证书和私钥，但保留同一 CA、server name、endpoint 与客户端身份。manifest 不把服务端叶子证书固定为单一字节内容，而是依赖受信 CA 和名称验证；因此新连接可以在证书轮换后继续对账，旧 nonce、独立 observer 和离线 Replay 的结果不变。该实验覆盖的是同一信任根下的叶子证书更新，不是 CA 轮换、吊销传播或远程主机身份的完整证明。

F-190 为远程 `tls-jsonl` 配置的 `crlFile` 加入服务端证书撤销回归。客户端使用同一 CA 的 CRL，服务端继续提供已被撤销的叶子证书；TLS 连接在 `hello` 之前失败，CLI 返回协议错误，不创建有效 manifest。该边界只说明客户端能执行已提供的撤销列表，不说明 CRL 的发布者、更新时间、部署分发或人工审批可信。

F-191 验证 WorldPort 的 CA 轮换窗口。初始化时把 CA-1 和预授权的 CA-2 放进同一个固定 trust bundle；服务端先用 CA-1 证书运行并完成一个 Run，再在相同 endpoint、server name 和客户端身份下换用 CA-2 证书，后续 Run 不改变 Lab manifest，效果继续提交，Replay 仍为 `CONSISTENT`。随后使用未进入 bundle 的 CA-3 服务端证书，客户端在 `hello` 前 fail-closed，效果计数不增加。这个实验依赖部署方提前声明轮换根；它不允许通过任意修改 `caFile` 把新的信任根悄悄带入既有 Lab，也不证明 CA 发布、bundle 分发、私钥保护或人工审批可信。

F-192 把 mTLS 的另一半撤销边界补齐：测试 WorldPort 服务端加载由同一 CA 签发的客户端 CRL，客户端继续使用已被撤销的证书连接时，TLS 握手在 `hello` 前失败，CLI 不创建有效 manifest。F-190 只证明客户端拒绝被撤销的服务端证书，F-192 不再从客户端行为推断服务端策略；但它仍只证明服务端执行了已提供的 CRL，不证明 CRL 发布、分发时效、私钥保护、远程主机代码诚实或人工审批可信。

F-193 把两个远程 WorldPort 的故障窗口串起来：primary 在非幂等效果已经产生后丢失 transition 回执，primary 与 reconciliation observer 都停止，并分别以新叶子证书在原端口重启。宿主继续使用原 manifest、客户端身份和 execution nonce，第二次 Run 必须先通过 primary 的 `reconcile` 与 observer 的独立观察，效果不重复执行；停止两个服务后 Replay 仍为 `CONSISTENT`。该实验把跨端点恢复的一致性证据补到同一条链上，但没有超出同一 CA、本机进程、同用户权限和测试文件效果的边界。

F-194 将两个远程角色的服务端信任根拆开：primary 服务端证书由 primary CA 签发，observer 服务端证书由另一套 observer CA 签发，客户端证书则由独立 client CA 签发并同时被两端信任。初始化时 observer 的 trust bundle 预授权旧根和轮换根；恢复时 primary 换用同一根下的新叶子证书，observer 换用新根证书，宿主不改变配置、manifest 或 execution nonce，最终通过两端对账并离线 Replay。这个实验说明角色级 TLS 身份可以独立绑定到同一恢复链，但不证明不同机器的 OS 权限、密钥托管、远程代码诚实或真实设备效果。

F-195 将 observer 暂时不可达放进同一恢复窗口：primary 已产生非幂等效果但丢失回执，恢复时 primary 的 `reconcile` 可以得到结果，但 observer 连接失败，宿主在写入 STEP 前返回错误并保留未决 external transition。observer 在原端口恢复后，后续 CLI 使用原 execution nonce 重新完成对账，效果不重复执行，停止服务后的 Replay 仍为 `CONSISTENT`。这验证了辅助观察缺失时的 fail-closed 与可继续性，不证明网络分区下的自动修复、重试时限、远程服务健康判断或人工处置已经成立。

F-196 增加显式 `transport: "persistent-tls-jsonl"`。远程客户端在一次 CLI 操作内复用经过 mTLS 校验的 TLS JSONL 会话，所有请求仍按顺序处理，每个请求有独立超时；连接关闭、协议错误或响应超限会关闭会话，原请求不自动重放，下一次请求才建立新连接。`hello` 也在该持久会话中完成，因此初始化和运行的请求数不再各自触发一次 TLS 握手。transport、endpoint 和 TLS 材料摘要继续写入 launch digest，identity-only registry 与 Replay 不建立连接。这只降低连接建立成本，不改变 execution nonce、对账、人工确认和远程效果真实性边界。

F-197 为持久 TLS 会话补上对端主动收尾的边界：远端可以在返回一份合法 JSONL envelope 后立即发送 FIN，宿主不能把尚未完成 `end/close` 事件的 socket 当作下一请求的会话。客户端在请求队列间让出一次事件循环，并把 `readableEnded`、`writableEnded` 或 `destroyed` 的连接视为不可复用；后续请求建立新的 mTLS 会话。原请求若已发出但回执未知，仍不自动重放，恢复继续依赖 nonce 对账。真实 CLI E2E 验证对端逐响应关闭时可连续完成 init→run，非幂等效果计数为 1，离线 Replay 为 `CONSISTENT`。这只解决正常连接收尾后的安全重连，不等于网络分区恢复或现实效果证明。

F-198 把 `persistent-tls-jsonl` 接入远程非幂等恢复链：第一次 CLI 让主 WorldPort 产生效果后丢失回执，随后主端点重启；下一次 CLI 必须通过同一 execution nonce 的 `reconcile`，再由独立 reconciliation observer 观察，才能写入 STEP。测试同时使用持久 TLS 的 primary 和 observer，效果计数保持 1，远端停止后 Replay 为 `CONSISTENT`。这证明的是该 transport 沿用既有恢复和对账边界，不是断网自动恢复、远程代码诚实或物理效果真实性。

F-199 把服务端证书轮换加入上述持久恢复窗口：primary 与 reconciliation observer 都使用 `persistent-tls-jsonl`，第一次非幂等 transition 丢失回执后，两端分别在原端口以同一 CA 签发的新叶子证书重启。客户端证书、trust bundle、server name、Lab manifest 和 execution nonce 不变；下一次 CLI 重新建立 mTLS 会话，经 primary `reconcile` 与 observer 观察后写入 STEP，效果不重复执行，离线 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `13/13` 增至 `14/14`。这只把连接重建、证书校验和既有 nonce 恢复放进同一测试，不改变“未知请求不自动重放”的原则，也不证明 CA 发布、私钥保护、跨机器权限、远程主机诚实或物理效果。

F-200 把持久 TLS 请求超时放进同一恢复窗口：测试服务先完成非幂等 `transition` 并写入效果，再延迟超过客户端预算才发送回执。宿主在 `WORLD_ADAPTER_PROTOCOL` 超时后关闭当前会话，不重发原请求；下一次 CLI 使用同一 execution nonce，经 primary `reconcile` 和独立 observer 完成未决链，效果计数保持 1，离线 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `14/14` 增至 `15/15`。这个实验覆盖的是受控响应延迟，不是网络分区、远程主机诚实或真实设备效果。

F-201 把响应黑洞与 endpoint 存活放进同一窗口：primary 在 `transition` 已写入效果后保持 TLS 服务监听，却丢弃这一次响应；客户端按 `timeoutMs` 关闭当前持久会话，下一次 CLI 新建连接，经 primary `reconcile` 和独立 observer 恢复同一个 execution nonce。primary 进程没有重启，效果计数仍为 1，离线 Replay 返回 `CONSISTENT`；本机远程 E2E 已从 `15/15` 增至 `16/16`。这排除了“必须重启远端才能恢复”的更窄假设，但仍不是实际网络分区、跨机器权限或物理效果证据。

F-202 把同一未决远程 Run 的并发恢复放进持久会话：第一次 CLI 在 primary 已产生效果后遇到响应黑洞，随后两个独立 CLI 进程同时以相同 `run-2` 发起恢复。LabStore 的单 writer 锁只允许一个进程进入对账和 STEP 追加，另一个进程失败；primary、observer 和新建的持久 TLS 会话仍使用同一 execution nonce，效果计数保持 1，最终 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `16/16` 增至 `17/17`。这验证的是同一实验空间内的排他性，不是分布式锁、跨机器网络时钟或真实设备原子执行。

F-203 将连接级中断与应用层黑洞区分开：测试 primary 在已完成非幂等 `transition` 后直接销毁当前 TLS socket，但保持服务进程和监听端口在线，不发送该请求的 JSONL envelope。持久会话必须把这次关闭报告为 `WORLD_ADAPTER_PROTOCOL`，不能自动重放；下一次 CLI 通过同一 execution nonce 的 `reconcile` 和独立 observer 完成恢复，效果计数保持 1，离线 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `17/17` 增至 `18/18`。该实验覆盖的是服务端触发的 TCP/TLS 连接重置，不等于网络设备、路由分区、跨机器锁或真实物理效果。

F-204 增加一个只转发原始 TCP 字节的故障代理。代理不终止 TLS，也不读取 JSONL；当测试控制文件表明 primary 已写入非幂等效果时，代理销毁当前 client/upstream 连接并记录一次切断，后续连接继续转发。客户端收到连接关闭后不重放未知请求，下一次 CLI 通过原 execution nonce 的 `reconcile` 和独立 observer 完成恢复，primary 与代理仍在线，效果计数保持 1，离线 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `18/18` 增至 `19/19`。这比服务端主动销毁 socket 更接近中间网络设备故障，但故障时机由测试文件控制，不能外推为真实网络分区、分布式锁或物理设备事实。

F-205 在同一透明 TCP 代理上增加回程黑洞模式。代理在检测到 primary 已写入效果后停止向客户端转发上游字节，但保持 client/upstream socket 和代理进程存活；客户端在 `timeoutMs` 到期后销毁自己的会话，不重放原 `transition`。下一次 CLI 通过新连接、同一 execution nonce 的 `reconcile` 和独立 observer 完成恢复，效果计数保持 1，离线 Replay 返回 `CONSISTENT`。本机远程 E2E 已从 `19/19` 增至 `20/20`。这覆盖网络层超时与连接重置的不同错误签名，但控制文件仍决定故障时机，不能替代真实路由器、丢包或半开连接实验。

F-206 把 primary、executionAuthority、executionObserver 和 reconciliationObserver 同时配置为独立的 `persistent-tls-jsonl` 远程 endpoint。第一次 Run 中 executionObserver 在返回 `observeExecution` 结果前退出，primary effect 与 authority effect 已产生但没有完成 STEP；第二次 CLI 重新建立四个角色的 mTLS 会话，用同一 execution nonce 经 primary `reconcile`、authority 对账、execution observer 和 reconciliation observer 完成未决链。新增回归与完整远程 WorldPort 组为 `21/21`，停止所有远端服务后离线 Replay 仍为 `CONSISTENT`。这只覆盖同一测试主机、同一客户端证书和受控文件效果，不证明跨机器锁、OS 权限隔离、远程代码诚实或真实设备效果。

F-149 将同一 transport 规则用于 witness、executionAuthority 和 executionObserver。辅助角色的 `transport` 选择写入各自 manifest metadata，并由 identity-only registry、LabStore 和 Replay 校验；旧配置不带字段时仍保持一次请求一进程。独立 witness 请求现在显式等待异步响应，transition、reconcile 和 observe 不会把未完成的 Promise 放进证据对象。测试覆盖多次 witness evidence 请求，以及 authority/observer 对同一 execution nonce 的幂等重试；会话关闭仍由 registry 统一负责，Replay 不启动这些角色。

F-150 把持久辅助会话放进响应丢失恢复实验：authority 或 observer 先完成各自的 nonce 绑定工作，再在回执发出前退出；第一次 Run 只留下未决 external transition，下一次独立 CLI 重新加载同一 manifest，主 adapter 的幂等 `transition`、authority 的 nonce 记录和 observer 的执行观测依次闭合，最终 STEP 才能落账。恢复过程不把新 nonce 当作补偿，也不让 Replay重新访问任何角色。该实验只覆盖本机同用户权限下的进程故障，不覆盖跨机器身份、断网重连或可信硬件。

F-151 把多角色故障从单点扩展为连续窗口：第一次 Run 在 authority 完成 nonce 绑定后丢失回执，第二次 Run 在 observer 完成检查后丢失回执，第三次 Run 才写入 STEP；三次使用同一 execution nonce，主效果和 authority effect 均保持一次。另有一条真实 EffectBroker 路径使用 `EffectJournal` 和 `SandboxFileExecutor`，在文件移动已产生、authority 回执尚未返回时终止进程；下一次启动从 Journal 恢复 `EFFECT_APPLIED`，不会重复调用文件移动，Replay 保持 `CONSISTENT`。这仍是本机同用户权限下的恢复证据，未覆盖跨机器身份、权限隔离或真实设备回执。

F-152 在 authority 回执上增加可选的持钥身份层。descriptor 通过 `executionPublicKey` 发布公钥，配置必须显式 pin 它；authority 对去掉签名字段的完整回执计算摘要，并以 Ed25519 签署 `{schemaVersion,type,digest,payload}`，结果放入 `executionAttestation`。宿主在 `executeExecution/reconcileExecution` 返回处验签，LabStore 和 Replay 对已持久化 STEP 再验一次；未发布公钥的旧 authority 保留无签名兼容路径。该签名能发现传输篡改、错配回执和错误密钥，不能把同一用户权限下的不诚实 authority 变成现实真相。

F-153 把 F-152 的持钥责任从 EffectBroker authority 代码路径中拆出。`bin/yi-agent-execution-signer.mjs` 只读取受限的 PKCS#8 DER 私钥并处理一次签名请求；authority 通过 `yi-execution-signer` JSONL 协议调用它，不再在自身进程加载私钥。authority 对返回的 attestation 使用已 pin 的 `executionPublicKey` 再验一次，签名者返回伪造、错配或畸形证据时不写入 STEP。协议设置固定的 executable/args、单请求、超时、stdout/stderr 上限和非 shell 启动，保留失败关闭语义。

F-153 的真实测试覆盖 signer 子进程签名、EffectBroker authority 的外部 signer 验签，以及 CLI 的执行、持久效果恢复和 Replay。它改善了密钥暴露面的局部结构，但没有形成 OS 低权限边界：authority、signer 和宿主仍可由同一用户控制，私钥仍可能被同权限进程读取；也没有解决远程密钥托管、可信硬件、跨机器传输或真实设备回执。

F-154 将 F-153 的 signer 扩展为受认证的 TCP 服务。authority 只读取受限 token 文件，并在每个签名请求中携带 token；服务端用常量时间比较拒绝未授权请求，再用私钥签发 attestation。descriptor 公钥仍是最终证据校验根，token 只控制谁能调用签名服务。示例服务强制监听回环地址，TCP 内容不加密，因此该节点只证明本机服务边界和未授权请求的拒绝，不证明跨机器保密性、TLS/mTLS 身份、低权限 OS 隔离或真实设备执行。

F-155 为 signer TCP transport 增加可选双向 TLS。服务端使用证书、私钥和 client CA，要求 authority 提供客户端证书；authority 使用 server CA 和 server name 校验服务端。认证 token 仍保留，作为应用层调用授权；execution public key 仍校验具体回执。TLS 密钥与 execution signing key 分开保存。真实测试使用动态生成的双方证书完成握手和签名。未配置 TLS 时，服务端仍只允许回环监听；TLS 本身也不建立低权限 OS 边界或物理执行真相。

F-156 将 signer 的响应丢失放进真实 EffectBroker 恢复路径。测试服务在完成签名后、写出响应前退出；authority 已完成文件移动但拿不到 attestation，首次 Run 不追加 STEP。重启同一端口的 signer 后，第二个 CLI Run 从未完成 external transition 继续，EffectJournal 复用同一 `EFFECT_APPLIED`，不重复文件移动，Replay 保持一致。该实验把 signer 故障与 nonce、Journal、reconcile 连接起来，仍不覆盖网络分区、证书轮换或远程设备人工对账。

EffectBroker 是 WorldPort 与真实副作用之间的第二道边界。Kernel 只能产生行动选择，应用层把它封装为带 `effectId/actionToken/target/precondition/risk/requiresConfirmation/reversible/compensation/executionNonce/planDigest` 的 EffectIntent。Broker 先登记计划和授权，再执行；执行器返回 `APPLIED/REJECTED/UNKNOWN`，其中 `UNKNOWN` 进入 `RECONCILE_REQUIRED`，禁止用新 nonce 重试。`APPLIED` 只有在存在声明式补偿方案时才允许进入补偿流程；补偿未知进入独立 `COMPENSATION_UNKNOWN`。持久化模式下，`EffectJournal` 先以 `handle.sync()` 刷新状态快照，`EXECUTION_STARTED` 或 `COMPENSATION_STARTED` 落盘后才允许调用对应 executor；恢复看到未完成边界时只能进入对账。每次 journal append 还要在同一文件旁取得跨进程原子 writer lock，锁内重新读取最新账本后再计算 sequence/prevDigest；stale-lock 回收使用固定 reclaim reservation，以原子硬链接竞争避免回收者互删或误删新 owner；执行、对账、补偿全过程再持有按 executionNonce 派生的可恢复操作锁，活跃 executor 不会被恢复流程抢占，进程死亡后才可回收；Broker 以共享日志头摘要作为 CAS 前置条件，陈旧 Broker 快照只返回 `CONFLICT` 而不追加语义事件；活 owner 在有界退避后仍返回 BUSY，确认死亡的 owner 才能回收，避免多个 CLI 进程各自从旧内存状态追加。当前 `src/effects/dry-run-executor.mjs` 只在内存中模拟状态变化，不能被解释为真实文件或设备安全。

ModelAdvisor 的结果是外部非确定输入，不进入连续性状态。Application 调用 Planner/Advisor 前会深复制观测、Memory、ValueSpec、能力、manifest 和候选历史；模型回调只能修改副本，不能通过原地写入改变 Kernel 选择、权限或连续性状态。宿主还对两类回调施加有界等待，默认 60 秒；超时分别成为 `MODEL_TIMEOUT`/`PLANNER_TIMEOUT` 故障证据并走既有 Kernel fallback，连续 Runner 因而不会被永不返回的进程内回调永久阻塞。CLI 另提供可选 `--model-adapter`：每次 `chat` 启动一个固定可执行文件，使用 `yi-model-cli` 单请求 JSONL、固定 stdout/stderr 上限和配置超时；宿主取消或截止时终止该子进程，适配器不合作也不能继续占住当前 Run。这个边界解决 liveness，不是 OS 权限/网络沙箱，也不能撤销已发出的外部副作用；插件权限、进程隔离和网络沙箱仍属于部署边界。每个带模型的 STEP 可选记录 `policyEvidence={schemaVersion,source,model,token,responseDigest,observationDigest,applied,reason}`；`observationDigest` 由 Application 从本步真实、已界定的 observation context 计算并绑定，模型返回的同名字段不具有权威性；`responseDigest` 只绑定模型回答摘要，两者都不是供应商真实性证明。ModelPlanner 的 `planEvidence.observationDigest` 遵循同一宿主绑定规则；即使计划非法，已收到的结构化 Planner 响应也只能绑定实际提供给它的观测上下文，Planner 自报摘要不能成为事实。WorldPort 的原始 evidence 不进入 Kernel，只由 `observation-context` 做有限项数、深度、键数、字符串长度和总字节投影；超限时显式标记截断，避免模型上下文无界增长。Replay 使用该证据中的已接受 token重新调用纯 `Kernel.stepWithPreference`，因此不会访问网络，也不会把模型再次生成的不同结果混入历史。若外部 transition 已写入 in-flight marker，宿主还会把已应用的 `policyEvidence` 一并持久化，并在重试时复用原 token；重试不重新调用 advisor，避免模型非确定性破坏同 nonce 的连续性。

Application 的模型回调边界还通过第二参数传递 `AbortSignal`；内置 Advisor/Planner 把它继续交给 HTTP client，使合作式请求在超时后主动释放网络等待。该信号不改变 JSON 输入契约，也不能强制终止忽略信号的进程内回调或撤销已经发出的外部副作用。

HTTP client 保留取消来源：调用方 `AbortSignal` 触发时返回 `API_CANCELLED`，client 自身截止时返回 `API_ERROR`；这两个错误都不产生模型事实或执行权限。Application 的宿主截止仍由自己的 `MODEL_TIMEOUT`/`PLANNER_TIMEOUT` 证据归因，避免 HTTP 层的停止原因覆盖更高层的闭环语义。

请求的首次中止来源在 controller 第一次进入 aborted 状态时锁定；后续来源不能覆盖它。这样即使底层 fetch 或响应体延迟拒绝，错误仍按先发生的调用方取消或自身截止归因，而不是按最后到达的信号归因。

非 2xx provider 响应的错误正文进入 `ApiClientError` 前会按当前配置的 API Key 做有限脱敏，匹配内容替换为 `[REDACTED]`，状态码和取消/超时错误分类保持不变。这个边界只保护 client 生成的错误消息，不覆盖 provider、代理或宿主日志已经在其它位置复制的敏感内容。

模型进程的取消还覆盖 `spawn()` 交接竞态：若调用方在进程对象返回前后结束请求，宿主在拿到 child 后再次检查已结束状态，先绑定最小错误处理再终止该 child，避免 Promise 已结束而模型进程脱离账本闭环继续运行。

Advisor 的异常和非法结果也按同一证据边界处理：宿主不把异常文本、异常 context 或异常对象写入账本，不把未经校验的 Token 交给 Kernel；只保存稳定的模型标识、摘要指纹、标准化 Token、格式受限的错误码和固定安全摘要。故障回退不是把模型错误算作成功，而是让共同底座在没有模型提议时继续走可验证的安全选择路径。CLI 的 `--kernel-only` 则把这种可替换关系显式化：从启动时就不创建模型工具。

MVP-1 的 repo WorldPort 使用上述共同边界验证真实对象接入：仓库文件树是有界 observation evidence，读取文件和运行测试是两个只读能力，结果进入连续 worldState、STEP 和 Replay。它已通过与内置 `temperature` WorldPort 的连续 Run 外壳对照，并通过第二个 Run 模型边界强制中断后的 `recover→resume→Replay` 验证；这证明的是宿主连续性契约可复用，不是证明仓库动作具备外部幂等或对账能力。它刻意不进入 Kernel，也不声称提供操作系统级权限隔离；测试命令的副作用风险属于部署边界，必须由低权限执行环境承担。

为验证真实执行器仍可被同一底座约束，`src/effects/sandbox-file-executor.mjs` 提供了临时目录级文件移动：它拒绝路径穿越和符号链接，只在带用户显式创建 `.yi-agent-sandbox` 标记的沙箱根内操作，并复用 Broker 的确认、executionNonce、durable journal、reconcile 与 compensation。CLI 的 `effect` 命令跨进程恢复这个 Broker，支持安全实验；它不是用户桌面授权层。

为验证“真实执行器仍可被同一底座约束”，`src/effects/sandbox-file-executor.mjs` 提供了临时目录级文件移动：它拒绝路径穿越和符号链接，只在沙箱根内操作，并复用 Broker 的确认、executionNonce、durable journal、reconcile 与 compensation。它是安全实验执行器，不是用户桌面授权层。

`InspectView` 固定包含：lab/run 状态、boundary、goal、constraints、facts、hypotheses、每 action 的 token/model mean/sampleCount/uncertainty/rejectionModel、最近 attribution/confidence、stopReason、evidence locator。运行时每个 STEP 都用动作前和动作后的 worldState 刷新能力投影，分别保存到 `boundary.capabilities` 与 `boundary.afterCapabilities`；历史 Run 的最终状态使用后者，Replay 仍只重放动作前快照。拒绝证据不保存领域拒绝文本，只保存有限计数、最近关系签名和当前是否仍在该关系下被拒绝。

## 3. 主逻辑链路

### MF-1 初始化（FR-1）

1. 解析并归一化 lab 路径。
2. 创建目标目录并写 `.initializing` 标记；所有文件先以 `.staging` 后缀写在目标目录内，flush 后逐个原子替换，immutable manifest 最后发布并删除标记。
3. 若已有兼容 manifest 且 world/seed 相同，读取后返回；任何差异或其它已有路径均拒绝覆盖。
4. 重新读取并校验初始化结果；若中断后存在 `.initializing` 且无 manifest，后续 init 只清理本工具列明的 staging 文件并重试，不碰其它文件。

断言：重复 init 摘要相同；父目录无新增文件。

### MF-2 运行闭环（FR-2/3/7）

1. 获取实验空间 writer lock；manifest 只读。若上次 current 落后于完整事件，则从对应 Run 起点和事件恢复 current；若事件损坏则 CORRUPT。start/end 都先在同目录写 staging、flush，再原子 rename 发布，发布前文件不参与恢复判定。
2. 对每步依次执行：界→感→存→预→择→动→验→化；“验”内部包含行动后的复观，不增加第九阶段。
3. `择` 只从 allowed 且 safe 的候选中选择；无候选立即记录 HALTED，不调用 `act`。
4. 应用服务把当前 immutable worldState 与请求交给 `transition`；内置 WorldPort 在一个纯函数结果内比较 stateVersion/policyVersion、复核 AuthorityPolicy、计算效果并递增版本，外部 WorldPort 则由 adapter 以 executionNonce 保证同一现实行动的幂等性。拒绝即记录 HALTED，不自动重试。场景外部输入在 transition 前作为独立事件应用，行动中混杂由 scenario 显式包含在 transition 结果。
5. 结果在已知 externalEvents 为空且干预窗口完整时可更新“经验效应”；窗口未完成且无已知混杂时先保存 pending credit，后续 feedback 按 executionNonce 结算，新的 Lab 在有限观察机会内仍无反馈则记录 `UNRESOLVED/FEEDBACK_TIMEOUT` 并不学习；已知混杂则 AMBIGUOUS 不学习。由于不可观测混杂原则上不可识别，v0.1 不把单步归因称为严格因果；独立 Tester 用随机化配对干预/对照实验检验统计效应。
6. 内置 `transition` 不改变外部状态；先把完整 STEP（含 afterState、receipt.executionNonce、postObservation）追加并 flush，成功后该模拟行动才算发生，再原子替换与 STEP.afterState 逐字段相同的 current。外部 `transition` 可能先改变现实状态，因此 accepted response 丢失时只能依赖 adapter 的持久 executionNonce 幂等记录；宿主对未声明幂等能力的 adapter 写入 `EXTERNAL_TRANSITION_UNKNOWN` 并阻断续跑，不能假设外部状态未变。首 STEP 的 beforeDigest/rngBefore 必须绑定 start.initialState，后续 STEP 必须绑定上一 afterState；同 executionNonce 的同证据重试返回原事件，不同证据拒绝。snapshot/finalState 不得另行陈述一套连续性状态；事件已落盘但 current 失败时退出 74，下次由事件恢复，不得标 CORRUPT。
7. Run 提交顺序固定：创建 start→追加 RUN_STARTED→current=RUNNING→逐 STEP→追加终态事件→创建 immutable end→current=READY/HALTED→释放锁。
8. 崩溃恢复矩阵：start 无事件=orphan，追加 crash-HALTED 后补 end/current；有非终态事件且无外部 in-flight marker=从 start 重放后追加 crash-HALTED；外部 marker 未对应已提交 STEP=追加 `EXTERNAL_TRANSITION_UNKNOWN`；有终态事件无 end=补 end；有 end 而 current 落后=以 end 修 current；任何摘要/断序错误=CORRUPT。未决外部 transition 的续跑还必须绑定原 run 的 scenario；只有同场景且 adapter 声明 durable nonce 幂等时才允许自动重试。

断言：任何 executed=true 的动作都有同一事件内的 expectation/before/after/verification/update。

### MF-3 重放（FR-4）

1. 仅允许重放已有 immutable end 的 Run；未终结时返回 BUSY。终态 Run 文件不可再写，因此无 reader/writer 竞态。
2. 只读加载 manifest 的 tokenMap、`runs/<runId>/start.json`、事件和外部输入；起点包含 worldId、scenario、worldState、memory、rngState、kernelStep 与 tokenMapDigest。Replay 必须用起点中的 worldId/scenario 重建同一 WorldPort，不得使用 CLI 默认 scenario；tokenMap 仅供 World/Replay 使用，Kernel 只获得 token。
3. 使用纯模拟 WorldPort、Kernel 和显式 RNG 重新决策并产生结果，与每个事件逐字段比较；账本 reducer 只作为第二层完整性检查。
4. 首个差异即停止并返回 run-local sequence；只比较该终态 Run 的 immutable start/events/end，不包含并发创建的 challenge 目录。

### MF-4 挑战套件（FR-5）

1. 每个 challenge 在 `challenges/<campaignId>/<caseId>` 创建完全独立的子实验空间，拥有独立 manifest/current/RNG/lock/events；不读取或合并主实验状态。
2. 内置 suite 只用于自查和展示。真正反证在候选 `src/**` source-manifest 摘要冻结后，由隔离 Tester 在宿主临时空间晚绑定生成随机线性/分段动力学、观测维度置换、跨实验 token 置换和未公开 seed；它直接调用冻结候选的 Kernel 公共契约并根据原始轨迹判定。Oracle 源码不在执行前写入项目；候选修改后必须生成新 Oracle。
3. 只由判别器产生 PASS/FALSIFIED/INCONCLUSIVE；异常不自动算 PASS。
4. 汇总并返回证据 runId/sequence。

边界：对任意有限测试集合都无法逻辑证明实现不是更大的查表程序；本设计通过晚绑定生成世界、结构隔离和性质测试提高反证力，只报告覆盖范围和“未被证伪”。Replay 仅证明同一实现的确定性自洽与账本一致，不证明学习、因果或智能。

### MF-5 检查（FR-6）

1. 未指定 run 时，原子读取一次 current 作为固定 watermark，只解析到该 sequence 为止；活动 writer 正在追加的 watermark 之后字节（包括未完成尾行）不属于本次视图。指定历史 run/action 时只读该 Run 的 immutable start/events/end；未终态历史 Run 返回 75。CORRUPT 时输出已读部分诊断并 exit 3。
2. 将事实、假设、目标、约束、模型和归因分区输出。
3. 不调用随机源、observe、act、learn 或任何写方法。

## 4. 支线逻辑链路

| 主链路 | 支线 | 处理 | 结果/测试 |
|---|---|---|---|
| MF-1 | 空目录/相对路径/路径穿越 | resolve 后限定全部写入 lab | 路径边界测试 |
| MF-1 | 已有非实验文件 | fail-closed，不覆盖 | 冲突测试 |
| MF-2 | 参数空、超限、未知 world/scenario | 行动前拒绝 | CLI 参数测试 |
| MF-2 | 全部候选 unsafe | 记录 HALTED，不执行 | unsafe 执行计数=0 |
| MF-2 | 未知/越权 action 穿透选择层 | WorldPort 拒绝 | 双层边界测试 |
| MF-2 | 执行未发生 | 记录 receipt，不学习该行动 | n 不增加 |
| MF-2 | 行动中外部事件 | 降权或拒绝学习，明确归因 | attribution 测试 |
| MF-2 | 两步之间外部变化 | 记 external delta，不归因旧动作 | 因果污染测试 |
| MF-2 | 请求版本与 immutable state 不符 | transition 拒绝并 HALT | stale-state 测试 |
| MF-2 | 已知外部事件/混杂 | AMBIGUOUS，不学习 | 混杂测试 |
| MF-2 | 不可观测混杂 | 单步不可识别，不声称因果；由随机配对对照估计 | 外部 oracle 统计测试 |
| MF-2 | 事件追加成功、快照失败 | 下次由事件恢复并重建快照 | crash recovery |
| MF-2 | 并发 run | 第二 writer 立即拒绝 | lock 测试 |
| MF-2 | 进程被中止 | 保留最后完整 JSONL 行，尾部残行判损坏 | 故障注入 |
| MF-3 | schema 不兼容/序号断裂/摘要不符 | 首差异停止，不修复原账本 | tamper 测试 |
| MF-4 | challenge 装置自身失败 | INCONCLUSIVE，不算通过 | invalidator 测试 |
| MF-5 | 连续 inspect | 不消耗随机数、不写文件 | 目录哈希不变 |
| 全部 | 日志与异常 | 带上下文上抛，禁止敏感内容 | stderr/exit 测试 |

无鉴权、网络下游、跨服务事务、i18n、时区和金额支线；v0.1 为单机本地实验室。

## 5. 状态机

实验空间 current 状态：`READY -> RUNNING -> READY`；安全/能力停机为 `RUNNING -> HALTED -> RUNNING`（下一次显式 run），证据损坏为 `* -> CORRUPT`。

- `RUNNING` 仅持锁进程可触发。
- `HALTED` 只能由下一次显式 run 创建新 Run 并进入 RUNNING；inspect 永远不改变状态，上次停止证据不可修改。
- 启动时发现 `RUNNING` 且无活跃 writer：若事件链完整则将前 Run 记为 crash-HALTED 并恢复 current；不完整则 CORRUPT。陈旧锁不自动删除，用户确认清锁后才执行该恢复判定。
- 全系统只有一个排他 `locks/writer.lock`。`recover --confirm-lock-owner-dead` 先用 `process.kill(pid,0)` 检查其 owner，不可证明死亡则拒绝；确认死亡后先原子发布绑定旧锁摘要的 immutable recovery intent，再把旧锁原子 rename 为 stale-lock 证据。此后所有 recovery 竞争者都用排他创建争夺同一个 writer lock，获胜者以 `purpose:"recovery"` 和 intentDigest 标识身份并执行恢复矩阵。
- 旧锁 rename 到 recovery 获得新 writer lock 之间允许路径短暂为空，但未完成 intent 已先落盘。任何普通 run/challenge 即使在空窗获得 writer lock，也必须在写状态前检查 intent；发现未完成 intent 时只释放自己刚建的锁并返回 75，不执行恢复或业务动作。恢复完成后先原子发布 completion，再删除 recovery 身份的 writer lock。任一步崩溃都可由下一次显式 recover 根据 intent/completion/stale-lock 幂等续作；任何时刻最多一个持有 canonical writer lock 的进程可写状态。
- `CORRUPT` 禁止 run，只允许 inspect/replay 定位；v0.1 不自动修复。
- 非法流转统一拒绝，不静默纠正。

Run 状态：`CREATED -> RUNNING -> COMPLETED | HALTED | CORRUPT`，终态不可回退。

## 6. 数据与持久化契约

- `manifest.json`：初始化后不可变，含 schemaVersion、labId、worldId、seed、createdAt、canonicalRoot、稳定的 `worldVersion` 与 `worldImplementationDigest`、声明式 `scenarioIds`、稳定 tokenMap 及 digest；新实验的继续运行、重启恢复和 Replay 必须校验注册表中的完整 WorldPort 身份与 manifest 一致。缺少版本或实现摘要的历史 manifest 仅按 legacy 兼容路径读取。内置注册表的实现摘要覆盖具体 WorldPort 源码、共享 `world-port-base`、定义描述与 factory 源码，不把无关世界的注册表变更算入当前世界身份；外部 adapter 的实现摘要使用其已验证的 descriptorDigest，并与顶层 worldVersion 对齐。外部 adapter 另含 `{schemaVersion:1,protocol:"yi-world-cli",version:1,adapterId,worldVersion,valueSpec,evidencePublicKey,descriptorDigest,launchDigest,supportsIdempotentTransitions?,witness?}`；若声明 witness，metadata 固化其 adapterId/worldId/worldVersion/evidencePublicKey/descriptorDigest/launchDigest，配置同时固定独立 executable/args/timeout，把第二证据来源绑定到实验空间。tokenMap 为 `{schemaVersion:1,entries:[{token,capabilityId}],digest}`，应用层使用由 `SHA256(seed,labId,"capability-map",capabilityId)` 派生的独立 token 域，不消耗 world/policy RNG；即使 seed 相同，不同 labId 也产生不同映射。Runtime 只依据 manifest 的场景契约校验场景标识，不内置新的 WorldPort 领域名单。
- `state/current.json`：worldState、memory、rngState、kernelStep、changeSupervisor、lastRunId、lastRunSequence、status、eventsDigest；可由账本重建。连续 loop 的调度意图不写入 Kernel 连续性状态，而由各子 Run 的 immutable `start.json.continuation` 重建。
- `runs/<runId>/start.json`：每 Run 不可变起点，记录 worldId 与规范化 scenario，引用 manifest 的稳定 tokenMapDigest，含规范化连续性投影和起始摘要；连续 loop 还固定 `{schemaVersion,loopId,scenario,runIndex,stepsPerRun,planningHorizon,planningBranchingMode,mode,maxRuns?}`，用于进程重启后按账本重建剩余预算、同一 WorldPort 场景和历史规划语义；旧 continuation 缺少 `planningBranchingMode` 时从已提交 STEP 或终态 externalTransition 证据恢复；tokenMap、scenario 和 continuation 均不进入 Kernel 输入。
- `runs/<runId>/events.jsonl`：Run 内 sequence 从 1 连续递增；每行含 schemaVersion、runId、sequence、kind、payload、prevDigest、digest。
- 候选历史不是连续性 Memory 的一部分；Runtime 从当前实验空间已提交终态 Run 的 STEP 中投影最近 32 条 `candidateHistory`，每条保留 `runId,worldId,scenario,worldVersion,tokenMapDigest,kernelStep,sequence,recordedAt,candidateOutcome`，以及可选的 `observationDigest`、派生 `quality{errorMagnitude,verified,goalDistanceBefore,goalDistanceAfter,goalProgress,goalReached}` 和有界 `proposal/proposalDigest/proposalTruncated`。其中 `errorMagnitude` 是已有验证误差向量的平均绝对值，`verified` 只表示动作反馈可归因且可学习，不表示领域目标成功；目标距离字段仅在 `distance-v2` 下按同一 ValueSpec 几何派生。投影还按 `{worldVersion,tokenMapDigest,scenario,candidateDigest}` 生成 `candidateScopeDigest` 并标记该候选在同一作用域内的 `attempt` 次数；再按 `{worldVersion,tokenMapDigest,scenario,observationDigest}` 生成 `decisionContextDigest` 并标记同一可观测上下文中的 `contextAttempt`，从而比较不同候选而不混淆上下文；同时保留 `stepsSincePreviousCandidate` 作为连续性时间证据，但不把它解释成候选间的因果修复成本。相同 token/proposal 不会因跨 WorldPort 身份相同而被错误合并。历史查询以 lab 空间为边界，不跨空间聚合不同 WorldPort 的候选语义。单个 proposal 预览最多 8 KiB，ModelAdvisor 侧历史总预算最多 32 KiB；超限候选保留摘要并标记截断。它可在 `inspect` 和下一次 ModelAdvisor 提示中读取，跨进程/跨 Run 恢复；活动 Run 的未终态前缀不作为历史来源，避免把未提交事实泄露给下一决策。
- F-88 的候选谱系只允许模型返回可选 `supersedesCandidateDigest` 作为修正意图；宿主仅接受同一 `worldVersion + tokenMapDigest + scenario` 且历史中确实存在的候选摘要，并把接受后的引用投影到 candidate history。该引用是存在性确认，不是因果、回滚或成功证明；跨 WorldPort、跨场景和不存在的摘要均不进入持久证据。
- F-89 对已接受的谱系引用派生 `stepsSinceSupersededCandidate`，仅使用同一作用域内历史前缀中的源候选和单调 `kernelStep`；缺少源记录、跨作用域或非单调步数时不生成。它是候选修正工作窗口的审计量，不是因果成本，也不改变 Kernel、Replay 的决策语义。
- F-90 在上述谱系和顺序有效时，使用源候选与当前候选各自绑定的 `distance-v2` ValueSpec 派生 `goalDistanceDeltaFromSuperseded` 及布尔 `goalImprovedFromSuperseded`；数值溢出、缺少目标几何或跨作用域时不推断。它只表达统一底层几何上的终态差异，不替代领域判别器，不进入 Kernel 学习或安全选择。
- 应用服务的长跑模式将 STEP 的完整 `payload` 无损 deflate 后以 base64 字符串写入 JSONL；Runtime 读取时还原为同一语义对象，再执行原有 schema、摘要链和重放校验。`RUN_STARTED`、终态事件和公开 `LabStore` 默认仍使用普通 JSON 对象；外层 sequence/prevDigest/digest 始终明文。默认 `strict` 模式每次追加都执行 data-sync 后才返回；显式 `checkpoint` 模式则在 128 步检查点和终态前同步，未改变证据内容，但把长跑的物理持久化窗口明确化。
- STEP payload 必填：`recordedAt,boundary,beforeObservation,memoryEvidenceProjection,beforeDigest,expectation,choice,receipt,postObservation,verification{schemaVersion,error,attribution,confidence,learnable},update,afterDigest,rngBefore,rngAfter,externalInputs,afterState`。其中 `boundary` 至少含 `{schemaVersion:1,valueSpec}`，新应用 Run 的 `valueSpec` 默认固化 `valueMode:distance-v2`，也可由 WorldPort 显式固化 `signed-v1`，两者都保留 `tolerance` 与完整维度；旧账本缺少该字段时由 Replay 使用兼容的 `signed-v1`。外部 Run 还必须含 `externalInputsDigest`；它把该步 Kernel 决策所需的目标/权重和整组外部输入固定进账本；可选的 `boundary.goalActivation` 固定初次目标/计划/Planner 策略，可选的 `boundary.goalReplan` 固定停滞后的计划修订及其证据，Replay 不接受调用者默认值或重新请求 Planner。`afterState` 是该步完整连续性投影 `{worldState,memory,rngState,kernelStep,changeSupervisor}`，用于账本已落盘而 current 尚未发布时的确定性恢复；`changeSupervisor` 仍只由同一套观察向量、ValueSpec、归因和变化证据推进；若某个变化周期完成、停滞或耗尽预算，运行时会记录原因并开启下一变化周期，保持长期运行而不丢失历史证据；`memoryEvidenceProjection` 记录本次预测实际使用的样本数、均值和不确定度摘要；时间只审计，不进决策摘要。模型 policy evidence 可带有界 `proposal`，新候选同时带由宿主按 `{token,proposal}` 计算的 `candidateDigest`；STEP 可带与它绑定的 `candidateOutcome`，记录候选采用状态、回执和验证摘要，Replay 会重算并比较；这些字段是候选身份/结果证据，不是语义正确性证明。旧账本缺少可选字段时仍按兼容路径回放。
- `externalInputs` 每项固定为 `{schemaVersion:1,source:"scenario",kind,payload,appliedBeforeVersion,digest,attestation}`；`digest` 覆盖除 `digest`/`attestation` 外的输入字段，`attestation` 是适配器以 manifest 绑定的 Ed25519 私钥对“规范化输入 + digest”的签名。未知版本、摘要或签名错误为 CORRUPT。已注册内置 scenario 使用其 schema 校验；声明式通用 WorldPort 场景只受 Runtime 的结构与摘要契约约束，不接受任意代码。
- `runs/<runId>/end.json`：终态、finalSequence、finalEventDigest、finalStateDigest 和自摘要；Run 终态后不可修改。完整前缀截断会与 finalSequence/digest 不符。
- manifest/current/start/end 均含 schemaVersion 和 canonical selfDigest；current 还校验引用的 run/sequence/eventDigest。tokenMap 属于 manifest 自摘要。未知 schema、任一对象摘要错、引用错、终态事件与 end 不符均为 CORRUPT。
- `locks/writer.lock`：唯一排他写锁，schema 为 `{schemaVersion:1,labId,pid,ownerNonce,purpose:"run"|"challenge"|"recovery",intentDigest?,createdAt,selfDigest}`；先将完整内容写入并 flush 同目录唯一 candidate，再以硬链接排他发布 canonical lock，避免 canonical lock 出现空文件/残行。普通 run/challenge 获锁后、任何状态写入前必须检查未完成 recovery intent，存在则释放并返回 75。
- `recovery/<writerOwnerNonce>/intent.json`：在移动旧锁前原子发布的 immutable 恢复意图，schema 为 `{schemaVersion:1,writerLockDigest,command,checkedPid,ownerLivenessCheck,requestedAt,selfDigest}`。相同 writerLockDigest 的重复 recover 复用它；内容冲突为 CORRUPT。
- `recovery/<writerOwnerNonce>/stale-lock.json`：由旧 `locks/writer.lock` 原子 rename 得到的原字节证据，不得覆盖。若崩溃的是 recovery 身份 writer，则按恢复世代追加 `stale-lock-<generation>.json`；每次接管前都先确认 pid 已死并将检查证据写入新的 immutable `intent-<generation>.json`。
- `recovery/<writerOwnerNonce>/completion.json`：恢复矩阵与 current/end/events 提交完成后、释放 writer lock 前原子发布，schema 为 `{schemaVersion:1,intentDigest,finalCurrentDigest,completedAt,selfDigest}`。普通 writer 只把存在匹配 completion 的 intent 视为已完成；缺失、摘要不匹配或多分支 completion 为 CORRUPT。上述 recovery 文件、目录及其同目录 staging 明确属于实验空间恢复证据白名单。
- pending recovery 的空窗期若普通 writer 抢锁后在拒写检查前崩溃，recover 将其作为 `contender-intent-N.json` + `contender-lock-N.json` 归档并绑定死亡检查证据，然后继续原 pending intent；它不是新的恢复分支。
- RNG 使用可序列化 PRNG，状态进入 start/current/每步前后摘要；时间、UUID、runId 和审计 hash 不进入连续性等价投影；executionNonce 由连续 kernelStep 派生，写入世界的去重轨迹时不因 Run 分段而改变。WorldPort 只保留固定大小的最近 nonce 窗口，避免每个 afterState 复制完整历史；Run 账本对全历史 executionNonce 做精确唯一性校验。
- inspect 只读原子 current watermark；指定历史 run/action 时从 immutable Run 构造对应 InspectView；replay 只读终态 Run immutable 文件；二者不创建锁。run/challenge/recover 全部只争用 canonical writer lock；pending intent 是空窗期的拒写门，不授予写权限。

## 7. 部分可观测 WorldPort 的系统级反例

`beliefModels` 的存在不能只由 Kernel 单元测试支撑；必须让一个外部世界保留 Kernel 不可见的状态，并通过真实 CLI 的进程边界运行。测试 adapter `hidden-state-world-adapter.mjs` 将 `hiddenMode` 与阶段机放在 `worldState` 中，但 `observe` 只投影 `[value]`。它通过状态依赖能力依次完成 `flip → advance → reset`，让两次 `advance` 都在同一个可见 `value=0`、同一个 `r1:+` 关系下发生，却分别产生 `-1` 与 `+1`。

验收边界固定为：两个独立 CLI Run 共完成 11 个外部 transition；`advance` 对应的 `Token×RelationSignature` 信念样本必须保留 `[[-1],[1],[-1],[1]]`，WorldPort 的持久效果计数必须为 11，最终隐藏模式和可见状态必须与 adapter 轨迹一致；两个 Run 都必须能够在不重新调用 adapter transition 的情况下 Replay 为 `CONSISTENT`。任何失败都要区分为 adapter 状态机、外部协议、Kernel 信念、持久化或 Replay 边界，不能直接向 Kernel 添加 hidden-mode 特判。

这个实验支持的共同规律是“同一可见位置可能对应多个尚未辨识的变化分支”；它只证明系统能够保留有限不确定性，不证明已经识别隐藏状态、校准概率、完成 POMDP 搜索或获得现实因果关系。下一步仍需用更复杂的隐藏状态、反馈缺失和真实对照实验继续反证。

## 7.1 隐藏动力学漂移与周期再验证

固定的历史均值只能描述已经验证过的过去；当 WorldPort 在不公开内部状态的情况下改变动力学，而旧动作又因模型优势长期不再被选择时，系统不会凭空得到新证据。新 Lab 因此在 `Memory.lastVerifiedSteps` 保存每个不透明 Token 最近一次已验证动作的逻辑序号。没有未尝试安全动作且某 Token 已超过 8 个已验证动作未复核时，Kernel 优先从最久未验证的安全候选中重新取证；重新验证后仍必须通过同一 `verify → learn` 边界。

`verificationAge` 进入 Expectation，供账本和 Inspect 解释选择。该机制是固定成本的再验证策略，不是隐藏状态检测、变化点证明或概率校准；如果变化在再验证周期内发生，或 WorldPort 永远不给出可归因反馈，底座仍只能保留不确定性。外部漂移 WorldPort 必须通过独立子进程、跨 Run、幂等 transition 和 Replay 证明这条边界；旧版本 Replay 显式剥离 freshness 字段。

F-98 的漂移实验把“重新取证”与“取证后的策略改变”分开验收：动作 A 在早期每次产生 `+4`，隐藏动力学漂移后变为 `-2`；达到固定新鲜度窗口时，Kernel 仍会选择 A 获取新证据，随后下一步转向动作 B 的 `+1`。只有回执经过 `verify` 并进入 `learn`，旧模型才被有限近期证据修正；未验证的猜测不能直接触发策略切换。该机制保证的是有界的再组织能力，不是检测任意变化、推断隐藏状态或证明切换由单一原因造成。

F-100 的共享边界回归把“不确定性不等于不行动”进一步落到跨进程 CLI：同一 `stateVersion + intervalId` 返回多个新 feedback 时，两个相反传输顺序都必须得到相同的 `AMBIGUOUS` settled 记录；`learn` 不产生 action model，ChangeSupervisor 不把该步记为 `confirmed/improved`。若此前已连续停滞，监督器仍可按固定阈值进入显式 `REPLAN`，但这是停滞控制事件，不是把歧义反馈改写成成功证据。

## 7.2 有界序列规划与假设记忆

单步预测之外，规划器必须能够回答“如果这一步发生，下一步会处于什么关系中”。v16 的 bounded planning 为每个候选分支复制一份临时 Memory，把预测的 `Token+actualDelta` 写入近期历史和顺序累积摘要，再用同一 `buildPredictions` 生成下一步候选。该临时状态只存在于纯规划计算中，不写入真实 Lab，也不授予任何额外安全或执行权限；真实状态仍必须经过 WorldPort 回执、`verify` 和 `learn` 才能改变。

这使已验证的历史条件模型能够影响多步假设，而不是只在真实下一轮才生效。v17 对后续动作的已验证 belief 结果递归分支，但每个未来状态仍只跟随一个贪心动作；v18 的 `tree-v1` 在固定 rollout 预算内评估未来安全动作树，再对每个动作的 belief 结果递归展开。它仍是固定 horizon、模型驱动的有限策略投影，不是无限期计划、反事实因果证明或完整现实搜索。v16 及以前的 Replay 通过 `branchingMode: legacy-v1`，v17 通过 `branchingMode: recursive-v1` 保留各自历史规划语义；v18 STEP 和外部 transition marker 保存 `tree-v1`，旧 marker 缺少字段时默认恢复为 `legacy-v1`，从而在程序升级后仍能用原选择重试同一个 execution nonce。

## 8. 安全设计

- 所有写路径由单一 LabStore 生成，调用方不能提供内部相对路径。
- 不跟随实验目录外的符号链接/目录联接；初始化后记录 canonical root。
- WorldPort 的 action capability 使用闭集白名单；Kernel 和执行器双检。
- 所有 `src/**` 不得导入 `test/**`；Kernel 不得导入 `src/worlds`，不得包含内置 world/scenario/action 领域字面量。晚绑定 Oracle 在隔离临时空间执行，只返回 verdict、冻结源码摘要和证据定位；这增加反证强度但不构成不可作弊证明。
- JSON 对象单文件上限 1 MiB、JSON 最大嵌套深度 128；单 Run 账本上限 40 MiB、事件行上限 1 MiB，读写两侧均拒绝越界，避免意外内存耗尽；该上限覆盖当前压缩证据格式下的 10,000 步模拟 Run（v25 多尺度上下文与探测痕迹使每步压缩证据约增 10%，v26 的 8 条 recentHistory 与窗口 h2 模型再增至 ~3.9 KiB/步，上限由 32 MiB 两次依据实测重校准）。
- 路径操作会拒绝已存在的符号链接/目录联接并在关键写入前复核；但 Node.js 在 Windows 上没有可移植的目录句柄相对操作来彻底封闭“检查后被同权限进程替换”的竞态。因此 v0.1 的威胁边界要求实验目录 ACL 仅授予当前用户，不能抵御同一用户下主动并发篡改；这类场景只会报告为超出安全保证，不宣称已解决。
- v0.1 无 PII、鉴别数据、出站网络和进程内动态代码加载；F-119 的只读检查外壳是唯一监听面：固定绑定 127.0.0.1、仅 GET、复用 inspect 只读读路径、无鉴权（服务对象是本机持有 lab 的用户）、不发 CORS 头（浏览器默认同源策略阻止跨源读取）；显式 external adapter 仅通过固定 executable/args、`shell:false`、有限时限/输出的 JSONL 子进程协议接入。外部输入必须同时满足整步摘要绑定和 manifest 公钥验签；这能抵御证据被改写后重算本地无密钥哈希链，但不等同于 OS 沙箱或真实副作用保证。
- 虚拟桌面只记录合成文件名/类别/位置，不读取文件内容；错误和日志不得输出主机环境变量、真实目录枚举或内部 tokenMap 语义映射。
- v0.1 的纯模拟 transition 解决了“副作用发生而证据未落盘”窗口；外部桌面/设备 adapter 只能在显式声明并实现持久 execution nonce 幂等后获得自动续跑资格，否则进入 `EXTERNAL_TRANSITION_UNKNOWN` 阻断，必须人工对账，不能复用纯模拟结论。
- loop 的自动恢复是显式 opt-in：`--resume --auto-recover` 仅在 current 为 `RUNNING` 且 `LabStore.recover` 的系统 liveness probe 证明旧 writer owner 已死亡时接管；若检查与正常完成之间出现短暂无锁窗口，仍用初始 writer owner 身份复探测，活跃 owner、无法确认死亡或非运行态均不自动接管。它复用原有恢复意图、陈旧锁证据、canonical recovery lock 和 completion，不另造一套恢复状态机。
- `forever` 的热路径不在每个新 Run 或正常 `--resume` 中重复扫描全部历史：`startRun` 已持有唯一 writer lock 后，`--resume` 在进入下一 Run 前，均根据 verified current 指向的最新 terminal Run 重建当前 continuation；显式 `readLoopContinuation()` 审计和恢复候选扫描仍使用全量账本校验，避免性能优化替代历史完整性检查。

## 8.1 同初始状态的候选配对

F-91 增加 `beforeStateDigest` 作为候选产生前连续状态的不可变引用，并在共同 Runtime 中派生最近同状态候选的配对结果。配对条件同时绑定 WorldPort 版本、Token 映射、场景和 before 摘要；候选必须不同且两端质量已验证。比较器优先使用 `distance-v2` 的目标后距离，缺少该几何时才使用验证误差幅度，较小者为优，差值方向固定为左值减右值。该结果只作为历史和 ModelAdvisor 的证据，不改变 Kernel 选择、权限或 Replay 语义。

配对结果的语义是匹配状态的终态比较，不是因果证明：两个候选即便拥有相同 before 摘要，也可能受到外部时间、隐藏副作用或执行环境影响。要把它升级为反事实证据，仍需隔离、随机化/交叉运行和独立领域判别器；在这些条件缺失时，系统宁可不生成比较结果。

## 8.2 隔离分支挑战

F-92 的 `paired-candidates` challenge 建立三个隔离 LabStore：父空间先完成一个真实 Run，两个分支使用相同的 world identity、seed、token map 和父 Run 终态连续性状态，但各自拥有独立的 manifest/current/lock/events。分支通过 `runLab.initialState` 仅在空账本上启动；该入口拒绝向已有 Run 注入回退状态，避免普通续跑被伪装成分支。两个分支使用不同候选、相同 scenario，各自完成后由共同 `candidate-history` 重新配对，并对两个 immutable Run 分别执行 Replay。

该挑战的判定链为：父状态摘要保持不变、分支 before 摘要相等、WorldPort identity 相等、候选摘要不同、质量已验证、配对 verdict 可观察、左右 Replay 均 `CONSISTENT`。它仍是纯模拟 WorldPort 的隔离实验；外部 adapter 的真实副作用不能通过复制初始 JSON 安全分叉，必须等显式幂等/隔离/对账契约后再扩展。

## 8.3 持久化候选配对实验

F-93 的 `experiment pair` 把隔离分支从一次性 challenge 提升为可恢复工件。首次调用要求父 Lab 已有终态 Run，并在用户指定的空输出目录中独占写入 `pair.start.json`；该 start 固定父 manifest/current 摘要、WorldPort identity、Token map、scenario、连续性初始状态摘要、候选 Token 和左右分支 runId。随后两个普通 LabStore 分支从同一初始状态各执行一次 Run，父 Lab 只读。

实验完成前必须重新按同一 `candidate-history` 比较器配对，且左右分支都通过 Replay；只有这样才写入不可覆盖的 `pair.end.json`。如果进程在中间停止，`--resume` 根据 start 继续，已提交的分支不会重复执行。外部 adapter 被拒绝，因为复制一个 JSON 快照不能证明现实副作用可分叉、可回滚或可对账。

## 8.4 配对终态的引用完整性

F-94 修复了持久化结果的引用断裂：`pair.end.json` 不仅保存比较结果，还保存左右分支的 manifest/current 摘要。对已完成实验执行 `--resume` 时，宿主必须校验分支路径和 runId，重新打开对应 LabStore，确认 WorldPort identity 未漂移，并重新执行只读 Replay；缺失、篡改或不一致一律 `CORRUPT`，不能直接返回旧的 PASS。旧版 end 若没有新增摘要字段，仍会经过实际分支 Replay，保持向后读取能力；新生成的 end 保存完整摘要。

这条复核只证明本地持久化工件仍对应其分支账本，不证明现实世界事实或领域任务成功。并发写者、外部副作用、独立终态判别器和人工对账仍属于各自的安全边界。

## 8.5 有界多步轨迹实验

F-95 新增 `experiment trajectory`，把候选从一个 Token 扩展为两个等长且不同的 Token 序列。输入是自描述的 `candidate-trajectory` 文件，长度固定为 1～8；序列只引用父 Lab manifest 已授权的 Token，因此它表达的是共同底座上的动作轨迹，而不是自由代码或领域命令。

实验先固定父 Lab 的终态连续性状态、WorldPort identity、Token map 和 scenario，再创建左右纯模拟分支。每个轨迹元素对应一个普通 Run，使用稳定的 `run-1`… runId，并在每一步完成后落盘；start 工件保存完整序列和预期步数，进程中断后根据分支 current 的 kernelStep 继续，不重放已经提交的步骤。父 Lab 在实验前后都必须保持不变。

完成判据是双分支每个 Run 都能 Replay 为 `CONSISTENT`，并且两端最后候选都具备可验证质量。比较器只使用共同的初始状态摘要、轨迹摘要、终态摘要和统一目标几何（优先 `terminalGoalDistance`，否则 `terminalErrorMagnitude`），不把任何 WorldPort 名称或领域字段写入比较逻辑。end 工件保存每个分支的 manifest/current 摘要；完成后的 resume 会重新打开分支并复核引用，不能只相信旧 PASS。

这里的“轨迹”明确是 open-loop：序列在实验开始时已经固定，运行中不会根据新观测改写后续 Token。它因此能检验连续策略结果、持久化恢复和跨分支一致性，但不能证明闭环自适应、现实副作用可分叉、领域任务成功或长期自主性；外部 adapter 仍需独立的幂等、隔离、对账和人工确认契约。

## 8.6 可观察条件策略实验

F-96 在轨迹之上引入 `candidate-policy`：策略由一个默认 Token 和最多 8 条不透明 `observationDigest → Token` 规则组成。策略不读取 WorldPort 的领域字段，也不能调用代码或扩大权限；Runtime 通过同一个 `projectModelObservation` 计算观测摘要，命中规则则选择对应父 Token，否则使用默认 Token。策略摘要不等于模型能力，规则本身也不等于学习结果。

左右分支仍从同一父连续性状态开始，但每个元素不是预先写死的轨迹：每个 Run 完成后，下一 Run 会重新观察分支当前状态，再执行同一侧策略。账本中的 `policyEvidence.observationDigest` 和 Token 形成实际选择轨迹，end 同时保存策略身份与行为轨迹；比较器要求策略身份不同，并优先比较共同 ValueSpec 的终态目标距离。若两策略在当前世界产生相同轨迹，仍允许得到可审计的平局，不把“策略定义不同”误报为“行为不同”。

恢复时 start 工件提供策略和步数，分支只依据已提交 Run 集合继续；完成后的 resume 会重新验证策略、Run 集合、选择轨迹、current 摘要和每个 Run 的 Replay。该实验把闭环中的“观察后再选择”纳入持久性边界，但仍不提供规则自动归纳、长期自我改进、现实因果或外部副作用安全保证。

## 8.7 verified feedback 驱动的有限适应

F-97 用不向 Kernel 暴露隐藏模式的 `latent-choice` WorldPort 反证“必须新增独立策略学习器”的假设。两个世界只公开同一维数值观测和相同的安全能力集合，但同一 Token 在隐藏模式 A/B 下产生相反变化。测试把 5 步拆成两个独立 CLI Run：前两个选择必须相同，第一 Run 的 verified feedback 经账本恢复后，第二进程的第三步才允许分化。

结果由持久化 Memory 而不是策略文件驱动：`step` 读取当前 Memory，WorldPort 回执经 `verify` 后才由 `learn` 更新，下一进程从 current 重建同一 Memory；每个 Run 再由独立 Replay 验证。这样把“策略变化”归回共同的状态—反馈—更新底层，避免为 `candidate-policy` 再复制一套学习语义。该实验只证明有限后验能影响后续 Token，不能证明隐藏状态完全辨识、样本外迁移、无限记忆或现实因果。

## 9. 有界近期变化上下文

历史隐藏状态反例进一步区分出：保存“同一动作可能有多个结果”并不等于能够利用已验证历史选择动作。新 Lab 的 Memory 可选保存最近两个已验证变化条目 `{token,actualDelta}`，以固定顺序形成 `h1:` 上下文签名；`contextModels` 按该签名和不透明 Token 保存动作模型。Kernel 在当前上下文已有样本时优先使用它，再回退到关系模型和总体模型；学习只在 `ACTION && learnable` 或已闭合 clean feedback 时把变化写入上下文，拒绝、混杂和未闭合反馈不写入。

这个上下文是跨领域的“最近已验证变化”，不是领域字段、自然语言语义或隐藏模式标签。它只提供有限历史条件化：窗口固定为 2，模型和上下文数量有上限，旧 Memory 不带字段时保持旧行为。外部 `history-conditioned` WorldPort 以探针结果在可见状态恢复为零后验证：经过有限训练，模式 A 选择 `target-a`，模式 B 选择 `target-b`；28 次外部效果只提交一次，Replay 仍为 `CONSISTENT`。这证明了历史证据可以改变策略，但不证明长期记忆、隐藏状态完全辨识、概率校准或通用规划。

## 9.1 有界探索回合、多尺度上下文与反事实探测

周期-3 隐藏相位世界（`test/fixtures/cyclic-phase-world-adapter.mjs`）的反证把三处结构缺陷区分出来并演化：

- 探索回合：`EXPLORATORY` 不是永久模式。`acknowledgeReplan` 在切入探索时固化 `{enteredAtCycle, startBestDistance, verifiedSteps}`；确认进展突破进入时最优距离立即切回 `BALANCED`（`exploration-improved`），否则固定 12 个已验证步预算耗尽后切回（`exploration-budget-exhausted`）。没有 exploration 记录的历史监督器状态完全保持旧的单向切换语义；探索回合是取证预算，不是新的权限或成功证明。
- 多尺度上下文：`kernelLearningVersion: 25` 在 h1（窗口-2）之外增加窗口-1 的 `h0:` 键，预测按 h2→h1→h0→关系→总体回退，写入按学习版本门控，旧账本读取因 h0 模型不存在而天然无差异。h2 累加器键被探针证明因位置权重按构造永不复现（写读错位一步），其原始「长期上下文可读」声明不成立，写入仅作为审计保留。
- 键规范化：Memory `contextKeyScale`（新 Lab 固定 9 位十进制）把上下文键中的实际变化量化；`actualDelta` 的浮点重构残差不再把语义相同的历史分裂成不同键。字段缺失的旧记忆按原始字节键回放。
- 反事实探测：当价值最优选择依赖本上下文证据、而另一安全候选在本上下文零样本时，Kernel 按固定间隔（8 个已验证动作）有界地探一次该候选，`choice.contextProbe` 留痕，`lastProbeSteps` 保存每 Token 最近探测序号。全局证据可能被早期混合样本毒化，上下文证据只能由一次真实 `verify→learn` 取得；探测不改变权限、安全边界或学习规则。完全锁定的轨道中所有候选都持有上下文证据，探测自然静默。

验收边界：两个 token 置换 seed 的真实 CLI 跨进程 60 步实验，收尾 18 步当步赢家命中数达到预注册阈值（≥15/18），全部 Run 重放 `CONSISTENT`，外部效果恰好执行一次。这证明的是有界取证预算下的相位条件策略收敛，不是最优策略保证、隐藏状态辨识或变化点检测；更长周期、更大候选集与复合漂移仍需后续反证。

周期-7 碰撞世界（`test/fixtures/cyclic-collision-world-adapter.mjs`，赢家调度 A,B,A,C,B,A,D）进一步区分出窗口-1/2 的表达力上限：碰撞相位上任何窗口-2 条件策略的赢家率上限约 5.5/7。`kernelLearningVersion: 26` 因此把 h2 键的基底从按构造永不复现的累加器摘要改为最近 8 条已验证变化的窗口摘要（`LONG_CONTEXT_KEY_WINDOW = 8`，`MAX_LONG_CONTEXTS = 8`），`recentHistory` 容量扩至 8，h1 键显式取最近 2 条切片。读取始终使用窗口基（旧记忆的累加器 h2 模型本就不可读，行为无差异）；写入按学习版本门控，v25 及更早的 Replay 继续写累加器键。实测：赢家率从盲选水平在 ~150 步内收敛到 6/7 平台（窗口-2 类的信息论最优），双 seed 真实 CLI 360 步成熟窗口通过预注册判据。长跑中的「平台赢家率瓦解」经 F-118 值曲线插桩证实为度量伪影：~650 步时值精确到达目标并转入驻留（|v-400| ≤ 0.2 持续 500+ 步），越过目标后调度赢家不再是价值最优动作，调度赢家率失效——「元稳定恢复失败」的 F-117 叙事据此撤回。同轮以 `kernelLearningVersion: 27`（`revalidationBeliefGate`）把强制重验门控为信念比较：过期行动只有在其预期变化信念仍不劣于任何安全候选时才被强制重访（隐藏漂移场景中该候选仍是信念强者，检测能力保留），全局证据已判劣的冷门候选交由上下文反事实探测层；`step` 输入新增可选 `learningVersion`，Replay 与应用层分别传账本版本与当前版本，v25 及更早语义按版本原样保留（`EXPLORATORY` 模式门控与「饥饿上下文探测」均曾被尝试并分别被漂移 E2E 与四个学习契约 E2E 否决回退）。目标驻留行为由 2×400 步稳定性 E2E 固化；多目标切换后的重新收敛是后续反证方向。

## 10. 外部对账回执的签名证明边界

当前 v0.1 的 `reconcile` 只验证回执的结构、原始请求身份、前后状态和 `effectDigest`；它能防止宿主误把不同动作拼接起来，却不能证明回执来自真实的 WorldPort。签名不能证明现实系统本身诚实，但能把“谁声明了这个事实”从无来源文本提升为可验证的来源声明。

F-182 已把最小版本实现为独立 adapter 的 opt-in 契约，不改变未声明能力的旧 adapter。`hello.result` 可以声明 `reconciliationPublicKey`；宿主把它复制进 manifest adapter metadata。声明后，`reconcile` 的 `APPLIED`、`ABSENT` 和 `UNKNOWN` 都必须携带以下回执字段：

```json
{
  "schemaVersion": 1,
  "type": "world-reconciliation-v1",
  "algorithm": "ed25519-v1",
  "requestDigest": "sha256:<canonical reconcile request>",
  "resultDigest": "sha256:<canonical status and transition>",
  "digest": "sha256:<canonical unsigned attestation>",
  "signature": "<base64 Ed25519 signature>"
}
```

签名输入固定为规范化对象 `{schemaVersion,type,algorithm,worldId,scenario,state,request,status,transition,requestDigest,resultDigest}`。其中 `requestDigest` 覆盖世界身份、场景、完整 before state 和 execution request；`resultDigest` 覆盖 status 及 transition。为了让宿主和 Replay 使用同一字节边界，transition 中的 observation evidence 不进入签名结果投影，Kernel 需要的 vector、版本和 feedback 仍由 STEP 账本独立保存。宿主先验签并重新计算两个摘要，再执行现有的 `APPLIED` 状态/回执校验；验签失败、摘要错配、跨 nonce 或跨状态复用均为协议错误。签名的 `ABSENT`/`UNKNOWN` 仍然只证明 adapter 的否定声明，不能自动升级为可执行重试。Replay 不调用 `reconcile`，而是用已提交的 transition 投影重新验签。

当前实现已经覆盖 descriptor、manifest、恢复路径、STEP boundary、Replay 和篡改反例。它只证明持有 pinned 公钥的 adapter 对这段内容做过签名，不证明 adapter 诚实、私钥未被同权限进程读取、回执对应真实设备或现实效果。密钥轮换、撤销、跨机器身份、独立运营者和物理效果对账仍属于 Future-Gate。

F-183 又增加了可选的 `reconciliationObserver`。它使用不同的 adapter 身份和启动摘要，接收同一 nonce、before state 摘要、Token 和版本，必须返回 `OBSERVED/APPLIED` 以及相同的 before/after state 摘要。宿主在把恢复结果转成 STEP 前完成比较；不一致时不写 STEP。观察结果随 boundary 持久化，Replay 只比较已提交的 transition 和观察证据，不启动 observer。加载配置时还会拒绝主 WorldPort 与 observer 复用完全相同的可执行文件、参数和 transport；路径归一之外还比较底层文件身份，避免只改 `adapterId`、换等价路径或使用硬链接就伪造来源分离。

这个边界只把一个进程的声明和另一个进程看到的声明分开，不能推出物理效果真实发生。两个进程仍可能运行在同一用户权限、读取同一伪造文件或共谋；低权限 OS 身份、跨机器传输、可信执行器和人工对账仍未解决。

活跃 Run 的锁身份使用稳定 `dev+ino`，每次写入同时重新校验锁 JSON 的自摘要；时间戳变化不再构成所有权变化，内容篡改仍会 fail-closed。身份与内容分层只收敛本地锁误报，不把 PID liveness 或分布式文件系统误称为可靠锁服务。

repo WorldPort 的 writable 实验是 adapter 层的最小真实修改边界，不改变通用 Kernel 的 Token-only 决策契约：只有显式提供补丁策略和 nonce 日志时才暴露 `repo.apply-patch`。策略至少授权目标相对路径，并可用默认 `fixed` 或显式 `beforeDigestMode: current` 约束修改前 `contentDigest`；后者每次新 nonce 在写入前重新读取当前普通文件，适用于同一受控目标的连续候选演化，descriptor/worldVersion 仍绑定不变的策略文件。WorldPort 通过有界 observation evidence 把目标、摘要和 proposal 字段约束提供给模型，但这些提示仍不是权威授权；模型 proposal 携带完整替换内容，必须通过应用层边界和 adapter 的独立校验。adapter 先持久化 `PREPARED`，再做普通文件的原子替换，随后追加 `APPLIED`，同一 nonce 的重试复用已保存结果。该顺序覆盖写入前崩溃、替换中断和响应丢失的有限实验矩阵，但不提供 OS 级沙箱、通用 patch 解析、并发写入隔离或回滚保证；真实项目写权限仍属于 EffectBroker/Future-Gate。当前模型可见文件内容仍受 2 KiB 观察预算限制，实验只证明受控 proposal 能进入共同底座，不等于任意代码修改已经安全。

## 10.1 signer 证书轮换与恢复边界

F-157 把 mTLS 服务端证书更换放进多角色恢复矩阵。测试使用同一测试 CA 签发两张不同 serial 的 `localhost` 服务证书和一张 authority 客户端证书；signer 在首次签名后丢失响应，随后在同一端口以新服务证书重启。下一次 CLI 先通过同一 execution nonce 对账 authority 的 EffectBroker 效果，observer 再故意丢失响应，第三次 CLI 才完成。

这个实验分别检查服务端身份能否在重启后重新验证、已产生的效果能否由 Journal 复用，以及 observer 失败是否会阻止 STEP 写入。当前证据只覆盖同一 CA、本机进程和测试沙箱。它没有覆盖 CA 轮换、撤销列表、网络分区、不同 OS 身份或真实设备回执。

F-158 把信任根也换掉：第一轮使用 CA-1，signer 在签名后丢失响应；重启时服务端证书、authority 客户端证书和 signer 的 client CA 全部切换到 CA-2，authority 的信任文件保留两根 CA，随后用相同 execution nonce 恢复。第二轮能成功，说明当前 CLI 读取的是新证书且 signer 确实只接受新 client CA。这个结果仍不等价于证书撤销；撤销列表、轮换窗口和旧证书审计必须由部署环境提供。

F-159 把证书撤销放进同一条恢复链：服务端加载由测试 CA 签发的 CRL，第一轮使用已被撤销的 authority 客户端证书，TLS 握手在 signer 请求到达应用协议前失败；此前已经发生的 EffectBroker 文件效果保持一次。随后把新的、未撤销的客户端证书写回同一配置路径，服务在同一端口重启，第二轮使用原 execution nonce 恢复，Replay 为 `CONSISTENT`。authority 同时加载该 CRL，验证客户端 TLS 参数能安全传递到 Node TLS 层。

这个实验把“证书仍由可信 CA 签发”和“证书当前仍被允许使用”分开了。CRL 只约束 TLS peer 身份，不能证明 signer 私钥未被同权限进程读取，也不能证明 signer 对现实副作用诚实；CRL 的发布、更新时机、旧证书审计和 OS 文件权限仍是部署边界。
F-207 增加 `adapter test` 作为外部 WorldPort 的无副作用预检。CLI 只加载并探测主 adapter 与已配置的辅助角色，返回不含凭据的 descriptor/launch 摘要、能力、场景、状态依赖动作/幂等 transition/对账能力和角色身份；不会初始化 Lab 或写入账本。该命令解决的是接入前的协议诊断，不改变 `init→run→inspect→replay` 的执行和信任边界。

F-208 将主 descriptor 中的状态依赖动作、幂等 transition 和对账支持能力原样放进预检摘要，并用带 execution observer 的外部配置验证角色身份仍能一起探测。预检结果只帮助调用者判断恢复契约是否声明齐全；它不把 adapter 自报能力升级为现实效果或远程代码诚实。

F-209 增加 Python 标准库实现的外部 WorldPort 示例。CLI 仍只依赖 `yi-world-cli` JSONL envelope 和 descriptor，不依赖 adapter 的实现语言；PowerShell 示例实际完成预检、初始化、运行、检查和离线 Replay，运行期配置使用 `persistent-jsonl` 复用 Python 进程。该 adapter 不声明幂等或对账，故响应丢失后的恢复按既有安全边界阻断。

F-210 增加 WSL Ubuntu 运行脚本，通过 Windows `wsl.exe` 启动同一个 Python adapter；Windows CLI 在同机不同 OS 用户态之间完成预检、初始化、运行、检查和离线 Replay。该边界只证明协议互操作与会话生命周期，不证明跨机器、不同账户、容器隔离或真实副作用权限。

F-211 为 `adapter test` 增加派生的 `recoveryMode`：主 descriptor 声明幂等 transition 时为 `idempotent`，否则声明对账能力时为 `reconciliation`，否则为 `blocked`。该字段与宿主实际恢复分支保持一致，帮助接入者在创建 Lab 前发现未知回执的停机边界；它仍只是协议能力摘要。

F-212 增加 `--require-recovery` 前置门。它复用 `recoveryMode`，只允许幂等或对账 adapter 进入“预检通过”结果；`blocked` 只在预检阶段返回 `CONFLICT`，不创建 Lab、锁或账本。该选项是连续运行调用者的显式安全要求，默认不改变旧 CLI 行为。

F-213 将同一前置门接入 `agent loop`。在外部 adapter 已加载但第一个 Run 尚未开始时检查 `recoveryMode`；`blocked` 返回 `CONFLICT`，对账或幂等路径继续。`agent run` 不接受该选项，避免把只针对连续 Runner 的恢复要求误用到单次运行。

F-214 将连续 Runner 的恢复要求纳入 continuation contract。`--require-recovery` 启动的新 continuation 会在每个 Run 的 immutable start 中保存 `requireRecovery:true`，`--resume` 从已验证的 current/Run 账本恢复该值，并在第一个新 Run 前再次检查外部 adapter。loop contract 也比较该字段，防止同一 loop 的不同 Run 使用不同恢复策略。没有该字段的旧 continuation 继续按兼容语义读取，不自动改变历史行为。该机制只防止宿主策略降级，仍不证明 adapter 自报的幂等或对账能力真实。

F-215 用一个故意违反幂等声明的 adapter 做负向实验：它的 `hello` 仍返回 `supportsIdempotentTransitions:true`，因此 `--require-recovery` 预检通过；第一次效果产生后宿主进程崩溃，恢复请求复用原 execution nonce，但夹具再次修改外部效果计数。宿主收到的状态投影仍可形成合法 STEP，离线 Replay 仍为 `CONSISTENT`，所以当前协议不能从单一 adapter 的声明和回执中发现这类现实重复。该结果不是放宽安全边界的理由，而是明确了恢复声明、执行事实和独立观测之间的信任断层。

F-216 修正了 CLI 到应用服务的参数传递遗漏。解析器原本会在外部 adapter 预检阶段执行 `--require-recovery` 检查，但没有把布尔值传入 `runContinuous`，因此直接从 CLI 新建的 loop 不会持久化要求。现在 CLI 与应用服务路径使用同一字段，真实 CLI E2E 读取完成 continuation 确认 `requireRecovery:true`；这只修复宿主策略落盘，不改变 F-215 所记录的外部声明不可自证边界。

F-217 收紧恢复策略的单调性。active legacy continuation 没有 `requireRecovery` 时，`agent loop --resume --require-recovery` 不再只检查当前调用后继续运行，而是返回 `CONFLICT`；因为历史 Run start 不可变，宿主无法把一次调用的要求伪装成已经持久化的 loop contract。新建且带要求的 loop、已有要求的 loop，以及旧 loop 不带该选项的兼容读取均保持原语义。

F-218 用一个陌生的进程内 WorldPort 检查共同底座是否偷偷依赖内置领域形状。该 Port 的状态为 6 维非负向量，能力集合只有 4 个不透明标识，ValueSpec 使用独立的权重和目标；Application 通过同一 `init → run → inspect → replay` 路径完成 4 次 transition，终态维度保持 6，Replay 返回 `CONSISTENT`。实验支持“领域差异由 WorldPort 投影、Kernel 只处理共同契约”的局部判断，但不证明任意现实世界都能被这组向量充分表达，也不覆盖外部副作用、隐藏状态或真实权限。

F-219 把 F-218 的陌生形状移到独立 JSONL adapter 子进程，并从公开 CLI 走完 `init → run(4) → inspect → replay`。adapter descriptor 声明 6 维 ValueSpec 和 4 个不透明能力，宿主不增加领域分支；Windows 本机结果为 `COMPLETED`、4 步、终态向量 6 维、Replay `CONSISTENT`。这验证的是 CLI 外部 WorldPort 协议对不同维度和动作数量的互操作，不覆盖 adapter 诚实性、真实设备权限、跨机器身份或现实状态观测。

F-220 在同一陌生外部 WorldPort 上先用应用服务完成一个有限 continuation Run，关闭持久 registry，再由新的 CLI 进程执行 `agent loop --resume` 完成剩余两个 Run。最终 current 的 `kernelStep` 为 3、WorldPort 状态仍为 6 维，三个 immutable Run 均可离线 Replay 为 `CONSISTENT`。该实验验证的是 continuation、WorldPort descriptor 和向量状态在进程重启后的共同恢复路径；不覆盖未决真实副作用、adapter 诚实性或跨机器权限。

F-221 处理长计划历史的重复工作。应用层内部生成的连续状态会跨 STEP 保留同一个未变更计划对象，因此 `ActiveRun` 复用一份按对象身份索引的 `WeakMap` 序列化缓存；公开追加接口仍为每次调用建立独立缓存，外部可变输入不会获得跨调用缓存。Replay 接收的事件已经由 `LabStore.readLedger` 逐条解析、解压和校验，Replay 本身只读这批事件，不再把完整事件数组深拷贝一遍，后续校验和确定性重演保持不变。

在 Windows 本机的大计划压力用例中，Replay 子进程的观测峰值内存从约 1.84 GiB 降至约 0.99 GiB，耗时从约 265 秒降至约 261 秒；压力用例、LabStore/Replay 78 项回归和陌生外部 WorldPort CLI 4 项回归均通过。这个结果说明重复复制是实际开销，但长历史仍会逐条解压、校验和重演。账本格式、单 STEP 大小限制和现实执行信任边界没有改变。

F-222 把目标生命周期从“一个 Lab 只能有一个已激活目标”推进为连续的有限目标 epoch。目标完成或因预算停机后，下一次 `agent run` 可以提供新的 goal 或 goal plan；运行时只重建监督器，WorldPort 状态、Memory、RNG 和 kernelStep 必须与上一 current 一致。新的 immutable run start 记录前一连续性状态、前一监督器和新监督器的摘要，首个 STEP 的 `goalActivation` 记录新的控制周期。若前一监督器仍为 ACTIVE 或 REPLAN_REQUIRED，目标替换会被拒绝；这条限制保留了活跃控制边界的单调性。该能力让同一世界可以连续经历多个目标，而不是把“换目标”伪装成修改旧账本；它仍不解决自然语言目标的真实含义、目标之间的优先级或现实权限治理。

F-223 把 Replay 从单个 Run 推进到 Lab 级连续账本。`replay --chain` 先读取全部终态 Run，按初始 `kernelStep` 排序并逐个执行原有确定性 Replay；再比较相邻 Run 的 WorldPort 状态、Memory、RNG 和 `kernelStep`。如果监督器状态发生切换，则继续验证前一终态与 `goalEpoch` 的前置摘要、后一 Run 的新监督器摘要，以及前后监督器分别处于终态和 ACTIVE。发现单 Run 差异、跨 Run 断裂或运行中的 current 时，命令返回首个可定位差异，不连接 adapter，也不改写账本。该入口把“本 Run 可重放”和“目标周期确实接续”分成两道可验证边界；它仍不提供对主动篡改者的签名证明，也不把跨 Lab 分支或现实世界因果纳入 Replay。

F-224 把连续 Replay 的边界延伸到 Lab 的当前水位。链回放读取同一只读快照中的 `current.json` 和全部终态 Run；在每个 Run 可重算且相邻 Run 连续后，必须确认 `current.lastRunId`、终态状态、事件序号、事件摘要和状态投影都指向链尾。这样即使有人重算了自洽的 current 摘要并把水位回退到旧 Run，也会得到 `CURRENT_CONTINUITY` 差异；current 仍为 `RUNNING` 时继续 fail-closed 要求先恢复。该检查验证的是账本链尾与可继续状态的一致性，不取代文件系统原子发布、签名信任或现实执行对账。

F-225 为连续 Replay 增加移动水位检测。`readChainSnapshot()` 在读取全部 Run 后重新读取并校验 `current.json`；若初始与末次 current 的内容不同，或任一时刻处于 `RUNNING`，则返回 `BUSY`，不把跨时刻的文件集合交给 Application。稳定快照仍由链回放继续校验链尾和 Run 连续性。该机制是无锁读路径的 fail-closed 边界，不能把它解释成跨文件系统的事务快照或分布式读写锁。

F-226 让连续 Replay 按 Run 流式读取。链快照只读取并排序各 Run 的 immutable start 头部，Application 随后逐个读取、重放并释放完整事件，不再把整个 Lab 的所有账本同时保留在内存中；全部 Replay 完成后再读一次 current，若期间水位移动则返回 `BUSY`。这把长期历史的内存增长从“所有 Run 的事件总量”降到“当前 Run 加有限摘要”，同时保留移动检测和链尾校验。它仍不提供无限历史的磁盘分页、事务快照或现实执行真实性。

F-227 把流式边界推进到单个 Run。`LabStore.readRunStream()` 以异步生成器逐行读取 `events.jsonl`，先校验行大小、JSON、压缩 payload、序号摘要链、STEP 状态连续性和唯一终态，再产出事件；`replayRunStream()` 随事件重演，只保留当前状态、前一摘要和终态。单 Run 与 chain Replay 都使用这条路径，原有数组版 `replayRun()` 继续作为纯内存兼容接口。10,000 步账本在 `--max-old-space-size=128` 的独立 CLI 进程中 Replay 为 `CONSISTENT`。这样宿主的 Replay 峰值不再随单个 Run 的事件数组聚合增长，但仍受单行和完整账本大小上限约束；它不是无限历史、磁盘分页、跨文件事务快照或现实执行真实性。

F-228 把流式读取从 Replay 延伸到候选历史恢复。此前 `readCandidateOutcomes()` 虽然只向 Advisor 返回最多 32 条结果，却先用 `readRun()` 把每个终态 Run 的全部事件装入数组；当模型在长期 Runner 中每步都留下候选证据时，恢复入口会重新承担与 Replay 相同的历史物化成本。现在它通过 `readRunStream()` 逐事件校验并筛选候选，提案仍按既有字节预算截断，随后继续使用原有时间排序和 `annotateCandidateHistory()`，所以 attempt、supersedes 和配对比较没有换语义。Runtime 测试让数组 Run 读取在该公开接口上不可用，候选历史仍能成功恢复；CLI 候选历史回归也覆盖了跨 Run 读取。

这个节点只减少无关事件的驻留，不改变候选摘要的排序输入。所有候选摘要仍可能被收集后再排序，历史注释中的前序查找也仍可能随候选数量增长；下一步需要独立实验来确定是否能在保持旧账本结果的前提下建立有界摘要或外部排序。它没有引入无限记忆、磁盘分页、跨文件事务快照，也没有改变模型证据不自证和现实 WorldPort 的信任边界。

F-229 处理 F-228 暴露的候选历史计算瓶颈。旧的 `annotateCandidateHistory()` 对每个候选分别执行前序切片和 `findLast()`：supersedes 需要寻找同作用域的最近候选，配对比较需要寻找同作用域、同 before 摘要且候选摘要不同的最近记录。新实现只向前遍历一次，使用嵌套 Map 保留同作用域/候选摘要的最新记录，并为配对键保留最近两个不同候选；重复相同候选时更新最新记录但不丢失最近的不同记录。候选结果仍在注释完成后按原调用方处理，质量计算、字段删除和摘要算法没有改动。

这次反证用 8,000 条相同作用域、相同 before 摘要和相同候选的历史衡量旧实现与新实现。旧实现约 3.4 秒，新实现约 0.16 秒；既有候选历史语义回归、LabStore 流式恢复、Application 和 CLI 回归均通过。这个节点只解决前序搜索的 CPU 增长，所有历史摘要仍可能驻留内存，全局时间排序也没有变成外部排序；摘要上界和长期记忆仍是后续实验。

F-230 处理另一条启动恢复热路径。旧的 `findUnresolvedExternalTransition()` 先读取全部 Run，再从完整事件数组中建立 `committed` 列表和 `unknowns` 列表；长期外部 loop 的每一步都可能带来不参与恢复判断的完整状态、观测和学习证据。新实现逐个消费 `readRunStream()`，把每个 STEP 压缩为 `(scenario, executionNonce, token, basedOnVersion, beforeDigest)` 的 canonical 身份键，只把 `EXTERNAL_TRANSITION_UNKNOWN` 的 terminal evidence 留到冲突判断；流消费完成后仍按原有顺序检查未决项和 identity 冲突。

该改动没有改变恢复可信度。身份键集合仍会随已提交 STEP 数量增加，未决项也仍需保留到全量扫描结束；它只减少与“是否已经提交同一外部动作”无关的事件载荷。Runtime 66 项回归和 repo WorldPort 的丢响应恢复、进程重启恢复回归通过，外部 adapter 仍不因单一回执而获得现实效果真实性。

F-231 收拢 legacy loop continuation 的全量扫描。旧路径为寻找可恢复的 loop，把每个 Run 的全部事件数组放进 group；新路径使用 `readRunStream()` 完整验证事件，却只留下有 continuation 的 Run 的 immutable start、terminal 和规划模式集合。`inferLoopPlanningBranchingMode()` 改为读取这份轻量摘要，`summarizeLoopContinuation()` 与 `summarizeLatestLoopRun()` 同时兼容流式摘要和旧数组对象，故 runIndex 连续性、可恢复终态、目标停止原因、active loop 冲突和 contract 漂移规则不变。

流式恢复消费者在事件流耗尽后都会校验 `end.json` 的终态 sequence、digest、status 和 finalStateDigest，避免“只筛选感兴趣事件”削弱旧 `readRun()` 的账本边界。测试覆盖 legacy continuation、历史规划模式推断、continuous/resume、CLI crash continuation 以及外部恢复路径。内存仍会保存各 loop 的轻量 run 摘要，且现代 `readCurrentLoopContinuation()` 对单个旧数组 Run 的兼容路径尚未改写；这不是无限历史或事务快照。

F-232 收拢现代 loop continuation 的当前 Run 读取。旧的 `readCurrentLoopContinuation()` 仍调用数组版 `readRun()`，导致已经拥有 `current.lastRunId` 的现代 `--resume` 也会一次性物化整条 Run。现在当前 Run 与历史扫描共用 `readLoopRunSummary()`：完整消费 `readRunStream()`，验证事件链和 `end.json`，只返回 start、终态和规划模式集合；现代 continuation 直接使用这一摘要，旧 continuation 在规划模式缺失时继续通过历史摘要完成推断。这样重启恢复的热路径不再依赖完整事件数组，同时保留旧版本账本兼容和终态一致性边界。

该节点的 Runtime、continuous/resume 和 CLI crash/continuation 定向回归分别为 `68/68`、`9/9` 和 `7/7`。当前仍会为 legacy 推断保留必要的轻量历史摘要，`readAllRuns()` 等兼容接口也没有改变；这不是无限历史、磁盘分页、跨文件事务快照或现实执行真实性。

F-233 反转未决外部事务的恢复索引。F-230 虽然已经逐事件扫描，但仍为所有历史 STEP 建立 `committed` 集合；当历史中没有未决事务时，这个集合完全不会参与结果，却仍随长期 Run 增长。现在第一遍只完整消费和校验各个终态 Run，收集带 recovery evidence 的 `EXTERNAL_TRANSITION_UNKNOWN`；若没有这类项，直接返回 `null`。若存在，再以这些未决身份为筛选条件重读事件流，只建立可能匹配的 commitment，最后按原有 identity、legacy 和冲突规则决定是否仍需恢复。

该变化把常态扫描的辅助状态从“全部历史 STEP”降为“未决事务集合”，代价是异常恢复路径会多读一遍账本；这是可接受的异常路径成本，并保留每遍的 `end.json` 终态一致性校验。Runtime `69/69`、repo WorldPort `8/8`、reconciliation/durability `10/10` 通过；新增回归覆盖未知事务随后以同 nonce 提交后不再被报告。该节点不提供磁盘索引、跨文件事务快照、分布式锁或现实效果真实性。

F-234 把候选历史恢复的排序和输出改为有界流。F-228 已经只从事件流提取候选，但 `readCandidateOutcomes()` 仍把所有候选载荷收集到数组，排序后才做历史注释，最后才截取 32 条。现在候选按固定大小排序块排序并写入临时目录；所有 Run 消费完成后，多个块以原有 `{recordedAt, runId, sequence}` 顺序归并，增量注释器逐条处理，只保留最终请求窗口。单个块和结果窗口有明确上限，临时目录在成功和失败路径都会清理。

增量注释器与数组版 `annotateCandidateHistory()` 共用同一状态转移，因此 attempt、contextAttempt、supersedes、质量和 paired comparison 的计算规则不变。流式恢复第二遍先从尾部窗口反推出相关 scope、context、supersedes 和 paired 键，只保留这些键对应的最小比较引用；数组版兼容接口仍按调用方输入数组处理，不把它的输入上界冒充为持久化恢复上界。Runtime 跨排序块回归、候选历史/Application/Advisor 回归和 repo WorldPort 候选回归均通过。

F-235 进一步收紧候选尾部的谱系索引。F-234 的排序块归并已经给出最终窗口，第二遍不再需要为全历史建立候选关系；它先从窗口提取相关 scope、context、supersedes 和 paired before-state 键，再让增量注释器只为这些键维护计数和最小比较引用。尾部每条记录的远距 supersedes 与 paired comparison 仍能访问其历史前件，未被尾部引用的历史只推进全局 kernelStep，不进入关系 Map。

这一步把 `readCandidateOutcomes(limit)` 的候选载荷、排序块、输出结果和谱系辅助状态都绑定到有界窗口；显式数组版注释仍保持原接口语义，调用方若主动提供无限数组仍由调用方承担其内存。该设计不引入持久候选索引，也不改变账本、模型证据或现实 WorldPort 的信任边界。

F-236 处理 F-231 留下的 loop 摘要数组。`readLoopContinuation()` 扫描每个 Run 后只把压缩的 continuation 记录写入固定大小排序块，随后按 `loopId → runIndex → startedAt → runId` 归并。归并器一次只处理一个 loop 和一个逻辑索引：它用有限规划模式集合核对 contract，检查前一次尝试是否可恢复，确认 runIndex 从零连续，并留下该 loop 的最新终态候选。这样历史 Run 的轻量摘要不会再以 `group.runs` 的形式全部驻留。

记录在进入排序块前已经由 `readLoopRunSummary()` 完整消费并校验事件流，临时记录只保留后续状态机需要的字段。129 个 Run 跨排序块的回归与旧 continuation、规划模式推断、应用层恢复和 CLI WorldPort 回归保持通过。临时排序块属于读路径辅助文件，路径列表和归并句柄仍受当前实现容量约束；数组版兼容 API、跨文件事务和现实执行信任边界没有改变。

F-237 把 F-234/F-236 的块归并改为多轮。候选历史与 loop continuation 的排序块超过 32 个时，先按 32 个一组归并成新的 JSONL 块，再继续下一轮；已写入的新块关闭后，旧块才会删除。最终的候选注释器和 continuation reducer 仍消费同一排序顺序，只有临时文件的生命周期发生变化。这个边界约束同时打开的输入数，不约束临时目录总大小、总 I/O、CPU 或公开的全量历史返回。

F-238 将 chain Replay 的 Run 头部扫描改为异步目录迭代和外部排序。`readChainSnapshotStream()` 只在内存中保留固定大小的当前块；超过块大小后写入临时 JSONL，并复用最多 32 路的多轮归并。Application 逐条消费有序的 Run 身份，保留原有 Replay、相邻连续性、current 水位和链尾检查。`readChainSnapshot()` 与 `readAllRuns()` 的数组接口不变，因此这是 Replay 读路径的收紧，不是全仓库历史 API 的强制迁移。临时目录仍属于本机辅助状态，不能替代持久索引或跨文件事务快照。

F-239 将崩溃恢复的 Run 目录选择改为单遍异步扫描。`recoverRun()` 只保留 `runCount`、`currentRunPresent`、一个未完成 Run 身份和其计数；因此历史终态 Run 不再以目录名数组驻留。扫描期间仍按原规则清理只含受认可 staging 文件的预启动孤儿目录；扫描结束后继续使用 current 优先和“恰好一个未完成 Run”规则选择恢复对象，后续 start、ledger、terminal 和 current 投影校验不变。该优化只覆盖恢复选择阶段，不能把整个恢复过程说成不加载事件数组。

F-240 将 `readCandidateOutcomes()` 与 `readLoopContinuation()` 的 Run 枚举从已排序数组改为异步目录迭代。两条路径随后都会按自己的稳定键消费或写入排序块，因此目录返回顺序不是语义输入；候选历史的 scope/lineage 注释和 continuation 的 contract、重复索引、缺口检查保持原规则。该变化只去掉目录名数组，未改变 `readAllRuns()`、nonce 精确唯一性或其他数组兼容接口。

F-241 将 `startRun()` 的上一 Run 接续校验接到 `readLedgerStream()`。流式读取器逐事件执行 JSON、摘要链、STEP 状态、executionNonce 和 terminal 校验；接续层只保存首事件、`current.lastRunSequence` 对应事件和事件计数，用它们完成 current 引用及投影检查。对于仍处于 `RUNNING` 的 current，流式校验允许缺少终态，随后沿用原有 `BUSY` 返回；正常终态路径的连续性结果不变。该优化不改 `readRun()` 数组接口，也不把全历史 nonce 唯一性说成常量成本。

F-242 将 `findUnresolvedExternalTransition()` 的两次历史扫描改为异步目录迭代。第一遍只消费并校验 Run 流，收集未决 terminal evidence；若存在带证据的未决项，第二遍重新打开目录并只匹配候选 commitment key。未决结果按 `runId` 排序，保持旧 `listRunIds()` 的确定首项和冲突判断；没有未决项时不再保留全部 Run 名称或进入第二遍。该节点只收紧目录元数据和正常路径的匹配集合，不改变外部效果的 nonce 对账信任边界。
