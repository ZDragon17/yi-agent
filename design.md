# CLI v0.1 设计契约

## 0. 不可偏移的根基：易经原始基因

本项目的最高层设计公理是：万事万物共享一套底层变化逻辑，具体领域只是这套逻辑在不同边界、尺度、关系和约束下的投影。易经在本项目中不是一个待接入的领域插件，而是决定系统如何理解“状态、关系、变化、行动、反馈和再变化”的原始基因。

工程约束如下：

- 电平高低、二进制、数值向量、不透明 Token 和领域对象属于不同表达层；不能把某一表达层误认为智能本身；
- 所有领域必须通过同一套观察—行动—验证—学习闭环接入；金融、医疗、组织、设备和软件的差异只能由 WorldPort 的状态、观测、能力和约束表达；
- Kernel、Memory、Replay 和智能判据必须保持领域中立；新增领域特判、孤立维度或单独一套底层逻辑，均视为架构偏移；
- 每一项扩展必须回答：它对应哪条共同变化规律、如何被反例检验、如何在另一个领域复用；不能只用模型提示词或演示结果宣称成立；
- 易经思想是架构公理和可证伪的工程方向，不把卦象、数字或哲学判断直接冒充为科学定律。

因此，WorldPort 的职责不是把每个领域封装成一个独立智能，而是把同一底层变化逻辑投影到一个可观察、可行动、可验证的世界边界。任何未来的 Planner、Supervisor、长期记忆、自我改进和真实执行器，都必须服从这条根基。

## 1. 系统边界

- 内核负责：闭环时序、候选预测、安全筛选、探索、执行回执处理、验证归因、学习和停止。它只看到数值向量、ValueSpec 和不透明 action token。
- Runtime 负责：实验空间、单 writer 锁、事件追加、快照、恢复和重放。
- WorldPort 负责：领域观测向量、实验空间初始化时随机生成且在该空间内稳定的 action token、纯状态 transition、独立 AuthorityPolicy 安全兜底和场景扰动。v0.1 没有真实外部副作用。
- Application 通过显式 `WorldRegistry` 注入 `worldDefinition/createManifestParts/createWorld/valueSpec/scenarioExternalInputs`；默认 registry 注册五个内置世界，测试或宿主可在进程内注入第三方适配器，CLI 不开放动态代码发现。
- CLI 负责：参数解析、调用应用服务、结构化/人类可读输出和退出码，不直接修改内核状态。
- API client 负责：读取环境变量、调用 OpenAI-compatible `/models` 与 `/chat/completions`；它是显式工具，不进入 Kernel 的确定性决策链。
- ModelAdvisor 负责：把有限的观测、目标和值域上下文转换为一个不可信的 token 提议；它不能写状态、调用 WorldPort 或更新 Memory。
- v0.1 默认含 `temperature`、`virtual-desktop`、`inventory`、`grid` 与 `queue` 五个内置模拟世界；另提供显式外部 WorldPort adapter 协议，但不提供动态发现、任意 in-process import 或真实副作用保证。
- 信任边界：CLI 参数与磁盘数据都按畸形/损坏输入校验；无密钥 SHA-256 链只检测偶然损坏或未重算篡改，不提供对主动攻击者的真实性证明。

依赖方向：`cli -> application -> kernel <- world ports`，`application -> runtime`，`cli -> api client`。Kernel 不依赖文件系统、终端、网络、具体世界或时钟。

## 2. CLI I/O 契约

| 命令 | 输入 | 正常输出 | 错误与退出码 | 幂等/超时 |
|---|---|---|---|---|
| `init --lab PATH --world ID [--seed N] [--adapter CONFIG]` | 不存在的目录、内置或外部世界、32 位种子 | manifest 与空认知快照；exit 0 | 参数 64；冲突 65；I/O 74 | world/seed/adapter 身份相同才幂等 |
| `run --lab PATH --steps N [--scenario ID] [--adapter CONFIG] [--json]` | 已初始化空间、1..10000 | runId、指标、停止原因；exit 0 | HALTED 2；损坏 3；参数 64；内部 70；I/O 74；BUSY 75 | 单 writer；最长 30 秒 |
| `inspect --lab PATH [--run ID|--action RUN:SEQ] [--adapter CONFIG] [--json]` | 实验空间 | 固定 snapshot watermark 的 InspectView | 损坏时部分诊断+3；参数 64；不存在 66；内部 70；I/O 74 | 原子快照只读；不创建锁 |
| `replay --lab PATH --run ID [--adapter CONFIG] [--json]` | 终态 run | 一致或首个差异序号 | 不一致/损坏 3；参数 64；不存在 66；内部 70；I/O 74；未终态 75 | 终态文件不可变；严格只读 |
| `challenge --lab PATH [--suite foundational|--case ID] [--json]` | 主实验空间仅作证据归属 | 每个 case 的 PASS/FALSIFIED/INCONCLUSIVE | 任一 FALSIFIED 2；无证伪但有 INCONCLUSIVE 3 | 每 case 使用隔离子实验空间 |
| `recover --lab PATH --confirm-lock-owner-dead [--json]` | 显式恢复请求 | stale lock 证据、恢复后的 current | 活进程/未确认 75；损坏 3；参数 64；I/O 74 | 唯一允许处理陈旧锁的命令 |
| `effect plan|confirm|execute|reconcile|compensate|reconcile-compensation|inspect --journal PATH [--sandbox-root PATH] [--intent PATH] [--nonce N] [--json]` | EffectIntent、durable journal、显式标记 sandbox | EffectBroker 状态快照或全部 effect 状态 | 参数 64；损坏 3；不存在 66；I/O 74；状态错误 70 | 每次进程从 journal 恢复；execute/compensate 只允许标记 sandbox root |
| `api test [--json]` | 环境变量中的 API 配置 | 连通状态与模型数量 | 参数 64；API 74；协议 70 | 无本地状态副作用 |
| `ask --prompt TEXT|--prompt-file PATH [--json]` | 环境变量中的 API 配置与用户提示 | 模型、回答、可选 usage | 参数 64；API 74；协议 70 | 单次非流式请求；提示文件只读 |
| `agent run --lab PATH --steps N [--scenario ID] [--adapter CONFIG] [--goal TEXT] [--json]` | 已初始化实验空间、API 配置 | 闭环 run 摘要 | 参数 64；安全停机 2；API 74；协议 70 | 每步一次模型提议；replay 不访问 API |

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
| recover | 仅死 owner 且显式确认后恢复 | 0/75/3 | previousLock,recoveryAction,status,evidence |

退出码可重复装置：64 用非法 steps；65 用不同 seed 重复 init；66 用不存在 run；74 用“父路径是普通文件”的 lab 路径产生 ENOTDIR；75 由测试进程先持有 writer lock、recover 检测活 owner 或 replay 无 end run。2/3/70 分别用内置安全停机、tamper/INCONCLUSIVE、注入的测试 World 异常产生。

### 核心内部接口契约

| 接口 | 输入 | 输出/错误 | 副作用与幂等 |
|---|---|---|---|
| `createWorldPort(config)` | immutable manifest、显式 scenario | 同构的 WorldPort 实例 | config 是纯 transition 的完整环境输入；Application 必须把 scenario 写入 immutable Run start，Replay 只能据此重建，禁止依赖进程默认值 |
| `WorldRegistry` | world id、manifest、scenario 和 state version | WorldPort、ValueSpec、声明式 externalInputs | Application 的适配边界；未知世界只能通过显式 registry 注入，外部输入必须成为可摘要、可重放的证据 |
| `ExternalWorldPort` | 显式 adapter config、JSONL request | JSONL response 或协议错误 | 宿主使用 `shell:false`、固定 executable/args、超时和输出上限；nonce、manifest policy 和连续性由宿主绑定 |
| `WorldPort.observe(state)` | immutable worldState | `Observation{vector:number[],stateVersion:string,intervalId:string,evidence[]}` | 纯函数，不消耗策略 RNG |
| `WorldPort.actions(manifest)` | 实验空间 manifest | `Capability{token:string,cost:number,allowed:boolean,safe:boolean}[]` | token 在同一 lab 跨 Run 稳定、跨 lab 可置换；allowed/safe 是 WorldPort/AuthorityPolicy 生成的领域盲安全投影，不含领域标签 |
| `WorldPort.transition(state,request)` | immutable worldState、`ActionRequest{token,basedOnVersion,policyVersion,constraintsDigest,executionNonce}` | `{nextWorldState,receipt,postObservation}` 或拒绝 receipt | 纯函数；版本比较、AuthorityPolicy、效果和版本递增构成单一 transition |
| `Kernel.step(input)` | `KernelObservation{vector,stateVersion,intervalId}`、memory、ValueSpec、capabilities、显式 rngState | `StepIntent{status,expectation,choice,nextRngState}` 或 `Halt` | Application 从 WorldPort Observation 剥离 evidence 后投影；纯函数；禁止读取时钟/环境元数据；未知安全行动先于已学习行动探索 |
| `Kernel.verify(input)` | `step` 原样返回的 StepIntent、receipt、投影后的 KernelObservation | `Verification{error,attribution,confidence,learnable}` | 纯函数；预测/选择/回执 token 必须一致；策略版本、约束摘要和 nonce 由 WorldPort/Application 绑定；证据不足为 AMBIGUOUS 且不学习 |
| `Kernel.learn(input)` | memory、StepIntent、receipt、postObservation、Verification | `{status,token,nextMemory}` | 纯函数；内部重算并绑定 Verification 与原始执行证据，只有 `ACTION && learnable` 才更新行动模型，其余返回未改变的 memory |
| `LabStore.append(event)` | 完整事件、预期 run sequence/digest | 已 flush 的 sequence/digest | 单 writer；冲突拒绝；只追加 |
| `LabStore.commit(snapshot)` | 与已追加事件同 sequence 的快照 | 原子替换结果 | 可重复；快照只能追平账本，不能领先 |
| `Replay.decision(run)` | immutable start、事件、外部输入 | 首差异或一致 | 只读；按 start 的 world/scenario 重建纯 World+Kernel+RNG；每个 STEP 的 `boundary.valueSpec` 是不可变决策输入 |
| `Challenge.evaluate(case)` | 隔离 run 证据、预注册判别器 | 演示性三态结论+invalidator | 不读主实验 memory，不合并状态；不得作为自主证明 |

外部 adapter 的 `hello`、`initialState`、`actions`、`observe`、`externalInputs`、`transition` 均以单次 JSONL 请求响应完成；运行期由宿主把外部输入视为潜在混杂，强制 accepted action 标记为 `AMBIGUOUS` 且不可学习。协议 v1 要求 accepted receipt 的 `effectDigest` 等于 `canonicalDigest(nextWorldState)`，rejected receipt 等于 `canonicalDigest(state)`，从而把回执绑定到连续性状态。外部 Run 的 Replay 使用 STEP 中冻结的 capabilities、观测、回执和 afterState 证据磁带，inspect/replay 只校验本地 adapter 启动摘要，不启动 adapter 子进程，不读取实时环境。

EffectBroker 是 WorldPort 与真实副作用之间的第二道边界。Kernel 只能产生行动选择，应用层把它封装为带 `effectId/actionToken/target/precondition/risk/requiresConfirmation/reversible/compensation/executionNonce/planDigest` 的 EffectIntent。Broker 先登记计划和授权，再执行；执行器返回 `APPLIED/REJECTED/UNKNOWN`，其中 `UNKNOWN` 进入 `RECONCILE_REQUIRED`，禁止用新 nonce 重试。`APPLIED` 只有在存在声明式补偿方案时才允许进入补偿流程；补偿未知进入独立 `COMPENSATION_UNKNOWN`。持久化模式下，`EffectJournal` 先以 `handle.sync()` 刷新状态快照，`EXECUTION_STARTED` 或 `COMPENSATION_STARTED` 落盘后才允许调用对应 executor；恢复看到未完成边界时只能进入对账。当前 `src/effects/dry-run-executor.mjs` 只在内存中模拟状态变化，不能被解释为真实文件或设备安全。

ModelAdvisor 的结果是外部非确定输入，不进入连续性状态。每个带模型的 STEP 可选记录 `policyEvidence={schemaVersion,source,model,token,responseDigest,applied,reason}`；其中 `responseDigest` 只绑定模型回答摘要，不是供应商真实性证明。Replay 使用该证据中的已接受 token重新调用纯 `Kernel.stepWithPreference`，因此不会访问网络，也不会把模型再次生成的不同结果混入历史。

为验证真实执行器仍可被同一底座约束，`src/effects/sandbox-file-executor.mjs` 提供了临时目录级文件移动：它拒绝路径穿越和符号链接，只在带用户显式创建 `.yi-agent-sandbox` 标记的沙箱根内操作，并复用 Broker 的确认、executionNonce、durable journal、reconcile 与 compensation。CLI 的 `effect` 命令跨进程恢复这个 Broker，支持安全实验；它不是用户桌面授权层。

为验证“真实执行器仍可被同一底座约束”，`src/effects/sandbox-file-executor.mjs` 提供了临时目录级文件移动：它拒绝路径穿越和符号链接，只在沙箱根内操作，并复用 Broker 的确认、executionNonce、durable journal、reconcile 与 compensation。它是安全实验执行器，不是用户桌面授权层。

`InspectView` 固定包含：lab/run 状态、boundary、goal、constraints、facts、hypotheses、每 action 的 token/model mean/sampleCount/uncertainty、最近 attribution/confidence、stopReason、evidence locator。

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
4. 应用服务把当前 immutable worldState 与请求交给纯 `transition`；它在一个函数结果内比较 stateVersion/policyVersion、复核 AuthorityPolicy、计算效果并递增版本。拒绝即记录 HALTED，不自动重试。场景外部输入在 transition 前作为独立事件应用，行动中混杂由 scenario 显式包含在 transition 结果。
5. 结果在已知 externalEvents 为空且干预窗口完整时可更新“经验效应”；已知混杂则 AMBIGUOUS 不学习。由于不可观测混杂原则上不可识别，v0.1 不把单步归因称为严格因果；独立 Tester 用随机化配对干预/对照实验检验统计效应。
6. `transition` 不改变外部状态；先把完整 STEP（含 afterState、receipt.executionNonce、postObservation）追加并 flush，成功后该模拟行动才算发生，再原子替换与 STEP.afterState 逐字段相同的 current。首 STEP 的 beforeDigest/rngBefore 必须绑定 start.initialState，后续 STEP 必须绑定上一 afterState；同 executionNonce 的同证据重试返回原事件，不同证据拒绝。snapshot/finalState 不得另行陈述一套连续性状态；事件已落盘但 current 失败时退出 74，下次由事件恢复，不得标 CORRUPT。
7. Run 提交顺序固定：创建 start→追加 RUN_STARTED→current=RUNNING→逐 STEP→追加终态事件→创建 immutable end→current=READY/HALTED→释放锁。
8. 崩溃恢复矩阵：start 无事件=orphan，追加 crash-HALTED 后补 end/current；有非终态事件=从 start 重放后追加 crash-HALTED；有终态事件无 end=补 end；有 end 而 current 落后=以 end 修 current；任何摘要/断序错误=CORRUPT。

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

- `manifest.json`：初始化后不可变，含 schemaVersion、labId、worldId、seed、createdAt、canonicalRoot、声明式 `scenarioIds`、稳定 tokenMap 及 digest；外部 adapter 另含 `{schemaVersion:1,protocol:"yi-world-cli",version:1,adapterId,worldVersion,valueSpec,evidencePublicKey,descriptorDigest,launchDigest}`，将协议/描述/启动材料和外部证据公钥绑定到实验空间。tokenMap 为 `{schemaVersion:1,entries:[{token,capabilityId}],digest}`，应用层使用由 `SHA256(seed,labId,"capability-map",capabilityId)` 派生的独立 token 域，不消耗 world/policy RNG；即使 seed 相同，不同 labId 也产生不同映射。Runtime 只依据 manifest 的场景契约校验场景标识，不内置新的 WorldPort 领域名单。
- `state/current.json`：worldState、memory、rngState、kernelStep、lastRunId、lastRunSequence、status、eventsDigest；可由账本重建。
- `runs/<runId>/start.json`：每 Run 不可变起点，记录 worldId 与规范化 scenario，引用 manifest 的稳定 tokenMapDigest，含规范化连续性投影和起始摘要；tokenMap 与 scenario 均不进入 Kernel 输入。
- `runs/<runId>/events.jsonl`：Run 内 sequence 从 1 连续递增；每行含 schemaVersion、runId、sequence、kind、payload、prevDigest、digest。
- 应用服务的长跑模式将 STEP 的完整 `payload` 无损 deflate 后以 base64 字符串写入 JSONL；Runtime 读取时还原为同一语义对象，再执行原有 schema、摘要链和重放校验。`RUN_STARTED`、终态事件和公开 `LabStore` 默认仍使用普通 JSON 对象；外层 sequence/prevDigest/digest 始终明文。每次追加都执行 data-sync 后才返回，压缩不改变证据完整性或恢复边界。
- STEP payload 必填：`recordedAt,boundary,beforeObservation,memoryEvidenceProjection,beforeDigest,expectation,choice,receipt,postObservation,verification{schemaVersion,error,attribution,confidence,learnable},update,afterDigest,rngBefore,rngAfter,externalInputs,afterState`。其中 `boundary` 至少含 `{schemaVersion:1,valueSpec}`，外部 Run 还必须含 `externalInputsDigest`；它把该步 Kernel 决策所需的目标/权重和整组外部输入固定进账本；Replay 不接受调用者默认值。`afterState` 是该步完整连续性投影 `{worldState,memory,rngState,kernelStep}`，用于账本已落盘而 current 尚未发布时的确定性恢复；`memoryEvidenceProjection` 记录本次预测实际使用的样本数、均值和不确定度摘要；时间只审计，不进决策摘要。
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

## 7. 安全设计

- 所有写路径由单一 LabStore 生成，调用方不能提供内部相对路径。
- 不跟随实验目录外的符号链接/目录联接；初始化后记录 canonical root。
- WorldPort 的 action capability 使用闭集白名单；Kernel 和执行器双检。
- 所有 `src/**` 不得导入 `test/**`；Kernel 不得导入 `src/worlds`，不得包含内置 world/scenario/action 领域字面量。晚绑定 Oracle 在隔离临时空间执行，只返回 verdict、冻结源码摘要和证据定位；这增加反证强度但不构成不可作弊证明。
- JSON 对象单文件上限 1 MiB、JSON 最大嵌套深度 128；单 Run 账本上限 16 MiB、事件行上限 1 MiB，读写两侧均拒绝越界，避免意外内存耗尽。
- 路径操作会拒绝已存在的符号链接/目录联接并在关键写入前复核；但 Node.js 在 Windows 上没有可移植的目录句柄相对操作来彻底封闭“检查后被同权限进程替换”的竞态。因此 v0.1 的威胁边界要求实验目录 ACL 仅授予当前用户，不能抵御同一用户下主动并发篡改；这类场景只会报告为超出安全保证，不宣称已解决。
- v0.1 无 PII、鉴别数据、网络和进程内动态代码加载；显式 external adapter 仅通过固定 executable/args、`shell:false`、有限时限/输出的 JSONL 子进程协议接入。外部输入必须同时满足整步摘要绑定和 manifest 公钥验签；这能抵御证据被改写后重算本地无密钥哈希链，但不等同于 OS 沙箱或真实副作用保证。
- 虚拟桌面只记录合成文件名/类别/位置，不读取文件内容；错误和日志不得输出主机环境变量、真实目录枚举或内部 tokenMap 语义映射。
- v0.1 的纯模拟 transition 解决了“副作用发生而证据未落盘”窗口；真实桌面/设备适配器不具备该保证，必须在 Future-Gate 另设计持久 execution nonce、幂等回执查询、补偿/人工对账，不能复用本结论。
