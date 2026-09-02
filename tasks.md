# CLI v0.1 执行 DAG

契约、安全和 E2E 测试由独立 Tester 先根据 spec/design 编写到对应 `test/**`，实现 worker 只改列出的 `src/**`/`bin/**`。反作弊 Oracle 不预写入项目：候选源码摘要冻结后，由隔离 Tester 在宿主临时空间生成并执行；候选修改后必须换新 Oracle。所有项目内测试通过 `scripts/test-gate.mjs <scope>` 运行；它必须发现至少 1 个测试文件和 1 个实际 case，否则非零退出，禁止 `tests 0` 假绿。

## T-0 可执行门禁骨架

- 依赖：无
- Tester 改动：无；实现改动：`package.json`、`scripts/test-gate.mjs`、`scripts/source-manifest.mjs`
- 实现：零测试 fail-closed runner；对指定文件集生成相对路径+SHA256 清单用于非 Git 越界核对。
- 自测命令：`node scripts/test-gate.mjs test/__empty_fixture__` 必须非零；放入一个通过 case 后必须为 0。
- Acceptance：空目录、空测试文件、零 case 均失败；source manifest 内容稳定且覆盖未版本化文件。

## T-1 项目骨架与纯 Kernel（覆盖 FR-2/7）

- 依赖：T-0
- Tester 改动：`test/kernel/**`；实现改动：`package.json`、`src/kernel/**`
- 实现：数据契约、可注入随机源、`step -> verify -> learn` 八操作纯闭环、未知安全行动探索、无安全候选停机、执行回执归因。
- Tester 命令：`node scripts/test-gate.mjs test/kernel`
- Acceptance：全 unsafe 时 act=0；未知行动不能被选；每个 executed 动作证据字段完整；Kernel 不接收领域标识、不导入 worlds，在跨 lab 随机 token/维度置换下性质等价。
- 收敛层：功能

## T-2 五个内置 WorldPort（覆盖 FR-2/5/7）

- 依赖：T-1
- Tester 改动：`test/worlds/**`；实现改动：`src/worlds/**`
- 实现：温控、虚拟桌面、库存、网格、队列五个不同面向的纯 transition、白名单 AuthorityPolicy、规律突变/外部事件/执行失败注入。
- Tester 命令：`node scripts/test-gate.mjs test/worlds`
- Acceptance：虚拟桌面含 1 个 protected 项，所有 transition 后其位置不变；温控从 34.9℃请求升温时拒绝且原 state 不变；未知/越权 token、陈旧 stateVersion/policyVersion 均拒绝并 HALT；transition 调用前后输入对象不变。
- 代表性变化轴：库存用 3 维资源与容量边界；网格用 4 维离散位置、障碍物和 5 个动作（含静态不安全动作）；队列用服务/接入/清空约束及外部到达；三者均必须通过相同 Kernel、Runtime 和 Replay 契约。
- 收敛层：功能

## T-3 事件账本、快照与锁（覆盖 FR-1/3）

- 依赖：T-1
- Tester 改动：`test/runtime/lab-store.test.mjs`；实现改动：`src/runtime/lab-store.mjs`、`src/runtime/schema.mjs`
- 实现：目标目录内 staging init、幂等校验、writer lock、per-run hash-chain、完整 Run 提交顺序与逐崩溃点恢复。
- Tester 命令：`node scripts/test-gate.mjs test/runtime/lab-store.test.mjs`
- Acceptance：初始化只在目标 lab 内写 staging；Run start 必须不可变记录 worldId/scenario，且摘要覆盖二者；inspect 用固定 watermark 可与 writer 并存且只读一致；第二 writer 被拒；显式 recover 对活 owner 拒绝，对确认死亡 owner 按 intent→旧锁归档→争夺 canonical writer lock→恢复矩阵→completion→释放锁执行；两个 recover 仅获 canonical writer lock 者写状态，空窗抢到锁的普通 writer 因 pending intent 在任何状态写入前退出 75；上述每个中断点均可幂等续作，冲突 intent/completion 判为 CORRUPT；对 start/RUN_STARTED/current/STEP/terminal/end/current 每个中断点按恢复矩阵得到唯一结果；manifest/current/start/end/tokenMap/externalInputs 的未知版本、摘要/引用错误，事件残行/断序/完整前缀截断均须识别；只有完整非终态前缀按 crash-HALTED 恢复。
- 收敛层：功能

## T-4 纯重放器（覆盖 FR-4）

- 依赖：T-1、T-3
- Tester 改动：`test/runtime/replay.test.mjs`；实现改动：`src/runtime/replay.mjs`
- 实现：从 immutable start 重执行纯 World+Kernel+RNG；每个 STEP 从 `boundary.valueSpec` 读取不可变决策输入；再做无副作用 reducer、序列/digest/摘要核验、首差异定位。
- Tester 命令：`node scripts/test-gate.mjs test/runtime/replay.test.mjs`
- Acceptance：正常一致；Replay 只按 Run start 的 worldId/scenario 重建 WorldPort，篡改或缺失 scenario 判为 CORRUPT；注入 Math.random 非确定选择时失败；篡改后定位 run-local sequence；前后固定 watermark 哈希不变。
- 收敛层：功能

## T-5 应用服务与检查视图（覆盖 FR-1/2/3/6）

- 依赖：T-1、T-2、T-3、T-4
- Tester 改动：`test/application/**`；实现改动：`src/application/**`
- 实现：init/run/inspect/replay/recover 用例；事实/假设/目标/约束分区；跨进程恢复；历史 run/action 只读查询；应用层生成稳定不透明 tokenMap 并接入两个内置 WorldPort。
- Tester 命令：`node scripts/test-gate.mjs test/application`
- Acceptance：同一 lab 稳定 tokenMap，且 tokenMap 使用独立 RNG 域；15+15 与 30 的 `{worldState,memory,rngState,kernelStep}` 投影相等；inspect 连续调用不改变文件哈希/RNG/状态；InspectView 完整；`runId:sequence` 可追溯单动作。
- 收敛层：模块

## T-6 Challenge Engine（覆盖 FR-5）

- 依赖：T-2、T-5
- 预置 Tester 改动：`test/challenges/**`；晚绑定 Oracle：宿主隔离临时空间，不属于候选源码；实现改动：`src/challenges/**`、`src/application/challenge-service.mjs`
- 实现：生产侧实现隔离子实验、原始证据和八个演示 cases；候选摘要冻结后，隔离 Tester 可晚绑定生成世界、随机配对干预/对照和判别器；支持 suite 和单 case。内置 Challenge 结果仅表示有限实验未发现反例。
- Tester 命令：`node scripts/test-gate.mjs test/challenges`
- Acceptance：case 顺序不影响结论且不改变主 current；所有项实际运行；装置/证据不足为 INCONCLUSIVE；输出子实验定位；外部 oracle 对未公开 seed、token/维度置换和随机配对对照给出覆盖范围，报告只称“未被本轮证伪”。
- 收敛层：模块

## T-7 CLI 与真实 E2E（覆盖 FR-1..7）

- 依赖：T-5、T-6
- Tester 改动：`test/e2e/**`；实现改动：`src/cli.mjs`、`bin/yi-agent.mjs`（接线全部 application services，含 challenge/recover）
- 实现：命令解析、JSON/人类输出、退出码、异常上下文；CLI 已接通 init/run/inspect/replay/challenge/recover。
- Tester 命令：`node scripts/test-gate.mjs test/e2e`
- Acceptance：逐项执行 Design §2 的期望语义矩阵，包括 init→run→inspect(run/action)→replay→challenge(suite/case)→recover；逐项断言 verdict/stopReason/关键 JSON 字段和 0/2/3/64/65/66/70/74/75；JSON 成功失败均仅 stdout 单 envelope 且字段互斥。
- 收敛层：系统

## T-8 非功能与安全门（覆盖 NFR）

- 依赖：T-3、T-7
- Tester 改动：`test/nfr/**`；实现改动：仅限触发失败的既有 owner 文件。
- 测试：`node scripts/test-gate.mjs test/nfr`
- Acceptance：10000 步在当前机型 60 秒内；逐 STEP 含 Design §6 全部审计/因果字段且无真实文件内容、环境变量和敏感数据；manifest/current/start/end/事件的版本、大小、摘要、引用门均覆盖；符号链接或目录联接逃逸拒绝；源码无 shell 依赖。只声明 Windows 已验证。长跑门禁通过独立 Node 进程执行，使用显式 `checkpoint` 持久化窗口（128 步）并由父进程再读取同一账本核验 10000 条 STEP；默认 `strict` 模式仍逐 STEP data-sync。
- 结构门：`src/**` 不得导入 `test/**`；`src/kernel/**` 不得导入 worlds 或出现内置领域标识。
- 收敛层：系统

## C-1 功能/模块/系统收敛节点

- 当前外部 autoresearch runner 在本环境不可执行，因此明确采用 convergence-scoping 的 Prose 降级模式 A，不声称具备机器 quorum/isGated。
- 每个 T-1..T-4 后：先后运行 `source-manifest`、对应 `test-gate`，再派 correct+arch+security 三视角 reviewer；修复后重复，连续 2 轮所有视角 H/M=0。
- T-5/T-6 后：scope=`src/application|runtime|challenges` 对应模块，运行其下全部测试，correct+arch+security，连续 2 轮 H/M=0。
- T-7/T-8 后：scope=项目全体，运行 `npm test` 与 CLI E2E，correct+arch+security，连续 2 轮 H/M=0。
- 每轮以前后 `node scripts/source-manifest.mjs <声明 scope>` 输出核对实际变更；证据保存在宿主任务运行态，不写入产品文档。发现越界、测试非零或 reviewer H/M>0 就返回对应 T 节点。最多 6 轮，仍不收敛则报告阻塞。
- 每次候选修改都会使旧 Oracle 失去“未知题”资格；新收敛轮必须冻结新 source-manifest 并由新的隔离 Tester 生成 Oracle，结果绑定该摘要。

## O-1 晚绑定 Oracle 必达门

- 依赖：T-1、T-5、T-6；在每次候选 source-manifest 冻结后执行。
- 所有者：与实现 worker 隔离的 Tester；Oracle 源码与 seed 在执行前不进入项目或实现上下文。
- 输入：冻结 source-manifest、Kernel 公共入口、spec/design；输出到宿主验证证据：`{candidateDigest,oracleRevision,generatedWorldCount,caseCount,verdict,failures}`。
- Acceptance：generatedWorldCount>0、caseCount>0、candidateDigest 精确匹配；无证据/摘要不符/INCONCLUSIVE 均不得通过；候选修改立即使本门失效并要求新 Oracle。

## T-9 终局收敛

- 依赖：T-1..T-8、C-1、O-1
- 改动：仅修复复审发现的范围内问题。
- 验证：`npm test`；`npm run test:e2e`；执行 Design §2 world/scenario/case/退出码矩阵；蜂群 correct/arch/security + codex 异构复审。
- Acceptance：两个命令 exit 0；命令矩阵输出/退出码符合 Design §2；连续两轮 0 High/Medium 且实际变更清单无越界。
- 收敛层：终局

## T-10 受控外部 WorldPort 协议

- 依赖：T-7、T-8、O-1
- Tester 改动：`test/e2e/**`；实现改动：`src/application/external-world-registry.mjs`、`src/application/agent-service.mjs`、`src/runtime/external-evidence.mjs`、`src/runtime/lab-store.mjs`、`src/runtime/replay.mjs`、`src/cli.mjs`
- 实现：显式 adapter JSON 配置；固定 `yi-world-cli` JSONL 请求/响应；`hello` 描述能力、场景和值域并提供 Ed25519 证据公钥；宿主绑定 adapter/descriptor/launch 摘要，校验 token、策略、nonce、stateVersion、回执、后观测和外部输入签名；未知 world 通过 `init --adapter` 到 `replay --adapter` 闭环。
- 安全边界：`shell:false`、绝对非 shell executable、最小环境、超时/输出上限；stdout 只允许单响应；外部进程不获实验目录句柄；不宣称 OS 沙箱，不允许真实副作用作为 v0.1 证据。
- Acceptance：未知生成 world 的 CLI `init→run→inspect→replay` 真实闭环；适配器崩溃/污染/超时/非法响应或无效签名不追加 STEP；换启动材料后身份冲突且不可改写已完成账本；篡改外部输入并重算无密钥摘要链仍被 Replay 拒绝；Replay 不读取实时外部输入。
- 收敛层：系统；真实桌面 EffectBroker 与 OS 隔离仍属于 Future-Gate。

## F-1 EffectBroker 副作用契约

- 依赖：T-10、Gate-1
- Tester 改动：`test/effects/**`；实现改动：`src/effects/**`
- 实现：把 Kernel 的行动选择和真实世界副作用分开；EffectIntent 固定目标、前置条件、风险、确认要求、补偿计划、执行 nonce 和 planDigest。EffectBroker 只允许 `AWAITING_CONFIRMATION→CONFIRMED→EXECUTING`，执行结果必须落在 `APPLIED/REJECTED/RECONCILE_REQUIRED`；未知结果禁止换 nonce 盲重试，只能先查询；补偿拥有独立的 `COMPENSATION_UNKNOWN` 对账状态。当前仅提供内存 dry-run executor，不接触真实文件。
- Acceptance：高风险不能跳过确认；同 nonce 同计划幂等、不同计划冲突；执行异常后必须对账；可逆动作才能补偿；补偿异常必须再次对账；每个状态变化都有事件。
- 收敛层：模块；真实 OS executor、权限隔离、撤销语义和人工确认属于 Future-Gate。

## F-2 EffectJournal 两阶段执行与恢复

- 实现：`EffectJournal` 以带 `prevDigest/digest` 的 JSONL 记录 EffectBroker 每次状态快照，并在 `handle.sync()` 完成后才返回；Broker 的 `EXECUTION_STARTED`、`COMPENSATION_STARTED` 必须先写入 journal，随后才可调用对应 executor。所有 Broker 变更串行化为异步操作，避免确认、执行、对账交错；每次 append 还在同一 journal 旁取得跨进程原子 writer lock，锁内重新读取最新账本后计算 sequence/prevDigest，并对活 owner 做有界退避；stale-lock 回收通过固定 reclaim reservation 的原子硬链接竞争保护；执行、对账、补偿全过程持有按 executionNonce 派生的可恢复操作锁，活跃 executor 不会被恢复流程抢占，死亡进程留下的锁可回收；Broker 以全局日志头摘要执行 CAS，陈旧状态只返回 `CONFLICT`，不写入重复语义事件。
- 恢复：从 journal 重建 nonce→intent→phase；若最后状态为 `EXECUTING`，恢复为 `RECONCILE_REQUIRED`，禁止重复执行；已 `APPLIED/REJECTED/REVERSED` 的 nonce 再执行只返回原状态。
- 验收：哈希链篡改拒绝；应用后重开不重复调用 executor；执行不确定后重开只能 reconcile；`EXECUTION_STARTED` 落盘失败时 executor 调用次数为 0；两个独立进程并发 append 仍形成唯一连续链；确认死亡进程遗留锁可安全回收，活 owner 不被抢占。
- 边界：journal 跨进程锁只保护 journal 状态提交，不提供 OS/设备 executor 的幂等性；真实 OS/设备 executor、沙箱或人工 UI 仍属于后续 Future-Gate。

## F-3 Sandbox 文件执行器

- 实现：`createSandboxFileExecutor` 只接受沙箱根目录内的相对文件移动；根目录、父路径和源/目标文件均拒绝符号链接，路径穿越、目录移动和目标冲突均 fail-closed。
- 闭环：在真实临时目录中验证移动、响应丢失后的 `reconcile`、声明式 `compensate`，并让同一 EffectJournal 保存 Broker 边界；不接入用户真实桌面。
- 边界：真实桌面路径授权、操作系统权限隔离、回收站/撤销策略、设备驱动和人工 UI 仍属于 Future-Gate。

## F-4 沙箱 effect CLI

- 实现：增加 `effect plan|confirm|execute|reconcile|compensate|reconcile-compensation|inspect`；每次 CLI 调用都从同一个 EffectJournal 恢复 Broker，允许跨进程验证同 nonce 的状态连续性。
- 安全门槛：`--sandbox-root` 必须是绝对路径，并包含用户显式创建的 `.yi-agent-sandbox` 标记；intent 只能声明沙箱内相对文件移动，CLI 不默认指向真实桌面。
- E2E：独立进程完成 `plan→confirm→execute→inspect→compensate`，且文件回到原位。

## 人工卡点

| 节点 | 类型 | 原因 |
|---|---|---|
| Gate-1 | 架构确认 | CLI-first、零依赖 JSONL、真实桌面写操作延后 |
| Future-Gate | 真实桌面权限 | 接入真实文件系统写操作前确认预览、撤销和损失边界 |

## F-5 Windows CLI API 接缝

- 实现：通过 npm `bin` 暴露 `yi-agent` 命令；提供 `api test` 与 `ask`，使用环境变量配置 OpenAI-compatible API，不把密钥持久化到项目目录。
- 验证：本地 HTTP 模拟服务覆盖 Bearer 认证、`/models`、`/chat/completions`、错误映射和缺失配置；在隔离 global prefix 中实际安装本地包，并从生成的 Windows PowerShell 入口完成 CLI 闭环。
- 边界：当前不自动保存密钥、不调用真实供应商、不包含桌面 UI；真实供应商连通性由用户配置后在本机执行 `yi-agent api test`。

## F-6 模型提议与可重放 Agent CLI

- 实现：`agent run` 将模型限制为结构化 token 提议；Kernel 重新计算预期并独立校验 allowed/safe，WorldPort 负责执行，verify/learn 负责证据和成长。
- 证据：每个模型 STEP 记录有限的 `policyEvidence`，不保存原始回答；Replay 使用冻结提议重放，不重新访问 API。
- 验证：本地 HTTP 模拟服务完成 `init→agent run→policyEvidence→replay`，模型返回非法/unsafe token 时只能走显式 Kernel fallback，不能绕过安全边界。
- 边界：这仍是受控模型辅助闭环，不构成通用智能证明；真实供应商、真实 WorldPort 和真实副作用需要后续独立实验与人工闸门。

## F-7 可复制的外部 WorldPort 示例

- 实现：增加 `examples/counter-world/adapter.mjs`、Windows PowerShell 配置生成脚本和一键运行脚本；示例不依赖项目内部 Kernel，实现最小 `yi-world-cli` 外部世界协议。
- 验证：使用该示例完成真实子进程 `init→run→inspect→replay`，并在已有本地模型模拟服务下验证 `agent run` 可以复用同一外部世界。
- 边界：示例只证明协议接入和证据闭环，不代表任意第三方 adapter 都安全；真实副作用仍需单独的 EffectBroker、隔离和人工确认。

## F-8 领域中立的变化监督器

- 原理：所有领域都投影为观察向量、目标和值域；监督器只计算同一套加权目标距离，并把“行动造成的可归因改善”“歧义/拒绝”“停滞”“重规划”“目标达成”和“预算耗尽”表达为统一状态变化。
- 实现：`src/agent/change-supervisor.mjs` 提供纯 `create/advance/acknowledgeReplan/resume` 契约；确认进步必须同时满足 `attribution=ACTION` 与 `learnable=true`，退步不能被历史最佳距离误判为改善；`changeSupervisor.strategy` 以版本、模式、探索覆盖策略和原因记录领域无关的策略变化，并进入 start/current/STEP afterState/快照/终态，旧实验室可在下一 Run 平滑升级。新的 `coverage-v1` 在单步选择和有界规划首步都先选择已验证样本更少的安全候选，再在同样本数内按不确定度探索；缺少该字段的旧策略保留 `uncertainty-v1` 语义，避免历史回放漂移。
- 验证：覆盖确认进步、歧义不学习、确认退步、目标达成、停滞重规划、重规划恢复、最大周期和参数边界；应用层验证 15+15 与 30 步的监督状态相等，且在五个内置 WorldPort 上验证分段/整段连续性；CLI 通过多进程接力、STEP 落盘后进程崩溃、显式 recover、后续 Run 和 Replay 验证重启恢复及跨 WorldPort 一致。
- 边界：这是底座的可证伪监督层，不等于通用自主智能；策略切换只改变安全候选排序，不能从不存在的观测、归因或执行回执中创造智能。覆盖策略只保证有限样本面的轮换，不保证动作有效、隐藏状态可辨识或全局最优。

- 连续性修正：`changeSupervisor.enabled` 区分默认 ValueSpec 文本与用户显式目标；显式目标一旦写入 Run/current，后续 Run 即使省略 `--goal` 也继续执行同一监督判定，旧状态按默认目标兼容为关闭。

## F-10 可验证目标阶段计划

- 原理：复杂目标不是模型输出的长文本，而是同一观察—目标—约束—变化—反馈逻辑上的有序阶段；每阶段拥有可计算的 `ValueSpec`，阶段完成才推进意图游标。
- 实现：`ChangeSupervisor.plan` 持久化根目标、阶段、当前阶段和修订号；`--goal-plan PATH` 只在首次激活时装载，阶段切换和目标达成进入 current/STEP，Replay 复用已落盘计划。
- 验证：至少覆盖两阶段目标、阶段切换、终态、计划重启、计划 Replay、无计划旧状态和不同 WorldPort 维度；已激活计划被替换时必须冲突而非静默改变。
- 边界：阶段目标仍需由用户或未来受约束的 Planner 提供；当前实现证明的是可持久化、可验证的分解机制，不证明模型能正确理解任意自然语言目标。

## F-11 受约束的自动 Planner

- 原理：Planner 不是第二个执行内核，而是对同一根目标提出有限阶段候选；权重、维度、权限、Token 和真实状态仍由 WorldPort、Application、Kernel 与账本拥有。
- 实现：`src/agent/model-planner.mjs` 生成不可信阶段目标提议；Application 继承当前 ValueSpec 的权重与维度，校验有限数值、阶段数量、根目标一致性和顺序后才激活；首次 STEP 同时记录冻结计划与 `planEvidence`，无效提议回退单阶段根目标。
- 验证：模型有效提议在首次激活时只请求一次；非法 JSON、错误维度、Planner 异常均不改变执行边界；后续普通 Run、重启和 Replay 不重复请求 Planner，只有持久化停滞策略才会为未完成计划请求修订；CLI `--auto-plan` 与显式 `--goal-plan` 互斥。
- 边界：Planner 仍不能从自然语言证明目标正确，也不能替代长期语义记忆、现实因果识别或人工授权；当前证明的是“模型可提出、宿主可验证、账本可恢复”的自动分解边界。

## F-12 关系条件长期记忆

- 原理：单一 Token 的全局平均会把不同上下文中的变化混在一起；用观测向量相对当前 ValueSpec 的三态关系签名作为共同上下文轴，形成 `Token×RelationSignature` 条件模型，不引入领域标签。
- 实现：Kernel 在 StepIntent 中记录可选关系签名；经 `ACTION && learnable` 验证后，同时更新总体 `actionModels` 和条件 `relationModels`；执行拒绝则更新不含领域文本的 `rejectionModels`，仅绑定 Token、最近关系签名、拒绝次数和当前拒绝状态。新 STEP 以 `kernelLearningVersion: 4` 标记反馈收据幂等与反馈窗口语义；Replay 对缺少标记或旧版本 STEP 保持历史 Memory 形状和既有拒绝兼容。Application 只为新实验启用收据窗口与有界 pending credit age，旧实验继续沿用原始 Memory 形状，避免破坏精确连续性对账；InspectView 暴露关系模型和拒绝模型数量及每个 action 的条件证据。
- 验证：相同 Token 在两个关系签名下采用不同已验证模型；关系模型只在可归因变化时增长，拒绝会跨 Run 持久化并使同关系下的动作降出探索池，关系变化后仍可重新验证；跨 Run、重启、Replay、五个 WorldPort 和外部 WorldPort 保持同一关系签名和预测结果。
- 边界：关系签名和拒绝证据是数值层的有限抽象，不等于自然语言语义、因果模型或跨世界 Token 对齐；拒绝不会自动证明永久约束，下一步仍需验证多次拒绝、动态约束变化和多目标迁移中的实际收益。

## F-13 反馈驱动的计划修订

- 原理：停滞不是简单切换策略，而是对当前未完成变化假设的反证；允许有限 Planner 提出新路径，但已完成阶段和根目标必须保持不变。
- 实现：`reviseGoalPlan` 只接受 `REPLAN_REQUIRED` 状态，保留已完成阶段前缀，修订未完成后缀并递增 `plan.revision`；Planner 是否可在后续 Run 触发由持久化的 `plannerEnabled` 决定；`boundary.goalReplan` 保存修订计划和 `planEvidence`。
- 验证：覆盖已完成阶段不可篡改、停滞后修订、跨 Run 继续修订、重启不丢失 Planner 策略，以及同一 STEP 在 Replay 中按相同顺序先推进监督器、再应用修订、最后确认重规划。
- 边界：计划修订仍是有限向量搜索，不代表模型理解了自然语言目标、获得了现实因果能力或实现了开放式自我改进。

## F-14 非平稳动力学下的有界变化记忆

- 原理：世界不是永久静态的；同一行动在同一关系位置上的近期反馈可能推翻旧动力学。记忆必须既保留可审计的总样本数，又允许有限近期证据修正当前预测。
- 实现：Kernel 对总体模型和关系条件模型都使用固定有界更新窗口；窗口只作用于已验证 `ACTION && learnable` 证据，不读取 WorldPort 名称、场景标签或模型自述。
- 验证：64 个旧样本后一次相反反馈即可改变当前预测；自定义 WorldPort 在 `baseline → shifted` Run 边界完成适应，memory 跨 Run 持久化，两个 Run 均可 Replay；既有五个内置 WorldPort 的分段/整段连续性仍保持。
- 边界：窗口是有限适应机制，不是完整的变化点检测、因果模型或开放世界预测；窗口大小仍需在更多隐藏动力学和真实 WorldPort 上通过反例校准。

## F-15 晚绑定随机同构反证

- 原理：同一底层变化逻辑不应依赖固定的维度位置、Token 拼写或测试世界名称；反例必须在实现候选之外生成输入，并比较变换前后的闭环关系。
- 实现：新增独立 Kernel 测试，使用确定性随机生成 96 组有限输入，对坐标和不透明 Token 做置换，比较 `step → verify → learn` 的预测、归因和记忆变换；不把生成器或领域标签加入 Kernel。
- 验证：随机维度、动作数量、目标、权重、总体/关系模型和 RNG 输入均通过同构比较；当前 96/96 通过。
- 边界：这是项目内的随机性质测试，不等于隔离宿主持有的未知 Oracle；候选源码摘要冻结后的真正独立晚绑定 Tester 仍是更强的下一道反证门。

## F-16 候选外独立晚绑定 Oracle

- 原理：候选代码不能自己决定测试世界、随机种子和判别器后再宣称通用；更强的证据必须来自候选源码之外，并绑定被检验的源码摘要。
- 实现：仓库外 `E:\demo\yi-agent-oracle\late-bound-oracle.mjs` 作为独立 Node 进程，只加载 Kernel 公共入口；在运行时生成 48 个未知有限世界输入和坐标/Token 置换，比较 `step → verify → learn` 的状态、预测、归因和记忆关系。
- 验证：输出 `candidateDigest/oracleRevision/generatedWorldCount/caseCount/verdict/failures` 单行 JSON；当前 48/48 为 `PASS`。同一候选摘要通过，伪造摘要返回 `INCONCLUSIVE` 且 exit code 非零。
- 边界：这是本机外部验证工件，不是随仓库分发的第三方审计；Oracle 自身仍需由独立组织重新实现才能进一步提高独立性。它只说明当前关系契约未被该输入集合证伪。

## F-17 应用层 WorldPort 同构回归

- 原理：Kernel 通过同构测试还不够；应用服务、持久化、监督器和 Replay 也不能依赖具体世界名称、物理坐标或 adapter 身份。
- 实现：新增独立外部 JSONL WorldPort，对同一组不透明能力提供原坐标和逆序坐标两个 adapter；两者使用不同启动摘要，分别经过两次 CLI 进程运行，再对状态向量、经验模型、关系模型、监督器和 Replay 做语义投影比较。
- 验证：`test/e2e/metamorphic-world-cli.test.mjs` 当前验证两种 WorldPort 均跨 Run 重启继续，最终应用状态等价，`run-1`/`run-2` 均 Replay 为 `CONSISTENT`。
- 边界：该回归验证的是受控外部 WorldPort 的应用闭环，不是桌面、设备或真实副作用；真实执行器仍须经过 execution nonce、幂等回执、对账和人工确认门禁。

## F-18 状态依赖的能力投影

- 原理：约束不是永远静态的；同一世界在变化后可能允许、禁止或暂时不安全不同动作，但这仍是同一状态—关系—约束—变化—反馈底层逻辑的投影。
- 实现：WorldPort 的 `actions(manifest,state?)` 支持基于当前 immutable worldState 生成能力安全投影；Application 与 Replay 在每个 STEP 前刷新能力，Application 同时把动作后投影写入 `boundary.afterCapabilities` 供历史最终状态观察；外部 adapter 只有在 `hello` 显式声明 `supportsStateDependentActions:true` 时才接收当前 state，旧 v1 adapter 继续收到原 payload。
- 验证：最小动态约束世界在第一动作后切换安全动作，跨独立 CLI 进程、重启、历史 inspect 与 Replay 仍使用同一 Kernel 契约；既有外部 adapter 回归验证可选 state 字段不破坏协议，五个内置 WorldPort 继续通过原有契约；旧实现反例为能力快照过期后停机或历史最终状态显示静态约束。
- 边界：能力刷新不能预测未被 WorldPort 暴露的约束，也不能替代执行边界的二次校验；真实设备约束变化仍需通过 adapter 回执和人工安全门确认。

## F-19 外部 transition 响应丢失与幂等恢复

- 原理：外部世界和本地账本无法共享一个原子提交；`transition` 已改变现实但响应丢失时，本地未追加 STEP 不能证明动作未发生。跨边界连续性必须依赖同一 `executionNonce` 的持久幂等结果，未知状态则宁可阻断也不能重复执行。
- 实现：`hello` 可声明 `supportsIdempotentTransitions:true`，宿主把 `executionNonce` 作为跨 Run 重试键；外部 transition 前先持久化宿主侧 in-flight marker，checkpoint 模式在对应 STEP 完成 data-sync 后才清 marker；续跑必须复现原始 token、basedOnVersion、beforeDigest 和 nonce，且约束只消费一次；未声明幂等能力的 accepted transition 不确定错误以终态 `EXTERNAL_TRANSITION_UNKNOWN` 落盘，未决动作身份绑定在终态证据并跨历史 Run 保留，直到同 scenario、同 nonce、同 before-state 的 STEP 真正提交；旧 adapter 不改变正常运行与 Replay 兼容性。
- 验证：独立外部子进程在 transition 持久化一次现实结果后丢弃响应，或让宿主死在外部 transition 返回与 STEP 追加之间；幂等 adapter 的下一 Run 用同 nonce 恢复且 effect 计数仍为 1，Replay 不启动 adapter；文件持久化多效果 adapter 还覆盖同一连续 loop 的响应丢失、重启、第二个 nonce 继续提交和两段 Run Replay，外部效果计数最终为 2 且没有重复；模型选择过的原始 token 由 marker 复用，不依赖重启后的 advisor，CLI 恢复时即使暂时没有 API 配置也不阻断该路径；未声明 adapter 的下一 Run 被 `CONFLICT` 阻断且 effect 计数仍为 1；幂等续跑再次崩溃后仍禁止跨 scenario。
- 边界：宿主无法凭空修复外部 adapter 的 durable store、网络分区或现实世界对账；真实设备仍需 adapter 自己提供 nonce 查询/结果回放及人工安全门，不能把本地 HALTED 当作外部未执行证明。

## F-9 连续 Run Runner

- 实现：`runContinuous` 和 `agent loop` 将有限步数分割为多个独立、可恢复、可 Replay 的 Run；每个 Run 提交完成后才启动下一个，显式目标达成、执行拒绝或无安全动作立即停止；`--forever` 提供长期策略，SIGINT/SIGTERM 只在已提交 Run 边界停止并返回 `INTERRUPTED`，并只在内存保留最近 Run 摘要，累计指标独立维护，完整历史由 lab 账本承载。每个子 Run 的 immutable `start.json` 固化 `loopId/runIndex/scenario/stepsPerRun/mode/maxRuns`，`agent loop --resume` 从 verified current 指向的终态 Run 重建同一 continuation 的 `nextRunIndex`，显式 `readLoopContinuation()` 保留完整账本审计，不把 loop 调度控制混入 Kernel 当前状态；同一 lab 的未完成 continuation 在 `LabStore.startRun` 的 writer lock 内排他，且只接受持久化 `nextRunIndex`，避免并发 loop 形成无法选择的多个恢复意图或重复提交同一逻辑 Run；目标达成终止 continuation，幂等外部不确定终态保留可重试 continuation。
- 验证：同一个 lab 在多个 Run 间持续推进，所有子 Run 可独立 Replay；重新执行 loop 命令从 current 继续，不重置 WorldPort、memory、RNG 或 supervisor strategy；CLI 在真实 API 请求延迟期间注入 SIGINT，仍完成当前 Run 并保持 current 一致；独立 E2E 真实强制终止 CLI 子进程后，显式 recover 并用 `--resume` 接续剩余有限预算，已提交 Run 不重复，current/kernelStep 不回退。
- 边界：单个 Run 崩溃后的锁接管仍需显式 `recover --confirm-lock-owner-dead`，这是故意保留的人工安全卡点；Windows 下无法用 Node `child.kill('SIGINT')` 模拟控制台 Ctrl+C，真实控制台行为仍需人工在目标终端验证；后台服务编排和真实桌面执行不在本阶段自动开启。

## F-20 有界观测上下文

- 原理：数值观测是 Kernel 可验证的共同尺度，结构化 evidence 是模型理解当前事实与关系的辅助材料；二者必须分开，不能让模型上下文反向成为执行事实或安全权限。
- 实现：`src/agent/observation-context.mjs` 将 WorldPort observation evidence 投影为有界、可序列化的数据，仅提供给 ModelAdvisor/ModelPlanner；投影超限会显式标记截断。模型结果记录 `observationDigest`，只绑定实际提供给模型的投影摘要；Kernel、WorldPort transition、verify、learn 和 Replay 契约保持不变。
- 验证：内置带场景 evidence 的 WorldPort 通过真实 CLI 将 evidence 送达模型；Advisor 与 Planner 使用同一投影；超大/非数据 evidence 被截断而不扩大提示；既有多 WorldPort、重启、外部 transition 和 Replay 仍保持一致。
- 边界：上下文投影不验证 evidence 的现实真实性，也不替代 WorldPort 的状态/权限回执；真实文件、设备和敏感信息的授权仍属于外部 adapter 与人工安全门。

## F-21 模型故障隔离

- 原理：模型只是可替换的假设生成器，不应成为 Kernel 闭环的单点故障；模型不可用或越过输出契约时，底座仍须沿可验证路径继续，并留下可解释、可 Replay 的证据。
- 实现：应用边界捕获 advisor 异常，或拒绝非法能力令牌/非法结果，回退到 Kernel 的确定性选择；模型故障原因、规范化结果和响应摘要指纹写入 STEP policy evidence，重启与 Replay 不重新调用模型。
- 验证：应用测试和真实 CLI 子进程分别覆盖模型抛出 provider outage、HTTP 503、返回非法 token 或缺失响应指纹；Run 仍完成，Kernel 不执行模型未授权的动作，账本可重放且与 current 一致。
- 边界：这不是把模型错误伪装成成功；真实外部动作仍受 WorldPort receipt、幂等协议和人工安全门约束，模型不可用时不自动扩大权限或生成新能力。

## F-22 Kernel-only 启动

- 原理：如果模型只是可替换的假设生成器，它不能成为底座启动的必要条件；同一套状态—关系—约束—变化—反馈闭环必须能在没有模型时独立运行。
- 实现：CLI 增加显式 `--kernel-only`，跳过 API client、Advisor 和 Planner 创建，直接把 WorldPort 交给 Application/Kernel；默认模式仍保持模型配置错误可见，避免静默改变用户意图。
- 验证：无 API 环境下真实 CLI 的 `agent run` 与 `agent loop` 均可完成，多 Run、inspect 和每个 Run Replay 保持一致；带 API 的既有提议路径不变。
- 边界：Kernel-only 不等于自然语言目标理解或现实自主性；`--auto-plan` 没有模型时只能记录 Planner 不可用并退回受限根目标，真实外部副作用仍须独立安全门。

## F-23 目标几何一致性

- 原理：如果监督器用绝对距离判断变化，而 Kernel 用带符号差值选择动作，同一目标会在不同层产生相互矛盾的“好变化”；目标应先定义可接受关系，再决定行动价值。
- 实现：Kernel 支持领域无关的 `valueMode=distance-v2` 与标量 `tolerance`；新应用 Run 固化该语义，关系签名在容差带内归零；缺少版本字段的旧输入保持 `signed-v1`，Replay 不破坏历史账本。
- 验证：越过目标的强动作不再压过较近动作；容差带内候选价值为零；旧 Replay、Kernel 置换不变性、连续 Run、五个内置 WorldPort 和外部 adapter 回归继续通过。
- 边界：这只是统一目标评价几何，不是自然语言目标理解、可达性证明或长期规划；下一道反例仍是需要暂时远离目标才能到达目标的多步动力学。

## F-24 有界多步变化推演

- 原理：同一套状态—关系—约束—变化—反馈逻辑不能只在当前一步评价；当已知变化显示“先离后合”时，单步贪心会把必要的过渡误判为退步。推演必须仍以当前经验、目标几何和安全候选为边界，不能凭空创造世界事实。
- 实现：Kernel 增加可选 `planning.horizon`（1～8，默认 1）。当没有未尝试安全动作时，对当前 `actionModels`/`relationModels` 做有界滚动预测，以终点 ValueSpec 价值扣除累计成本和不确定度后选择首个动作；真实执行仍只提交首个动作，下一步重新观测并重新筛选。规划候选和未来候选共享固定窗口，避免 WorldPort 能力数增长为每个候选重复展开全量平方计算。Application 将配置写入 STEP boundary，连续 loop 写入 continuation；外部 transition 的 in-flight marker 也固化同一配置，重启重试时自动复用。Replay 复用冻结配置。
- 验证：单步贪心会失败的“暂时远离、下一步到达”反例由 Kernel 选出绕行动作；规划/非规划仍共享 RNG、安全和 Token 边界；CLI、跨 Run、重启恢复、五个内置 WorldPort 和 Replay 保持一致。
- 边界：这是固定候选窗口内的有界模型滚动，不是全局搜索、可达性证明、因果识别或现实世界长期自主性；未来模型错误时仍以实际 WorldPort 观测和 verify/learn 反馈纠正，未知约束不得由推演越权。

## F-25 延迟反馈与有界信用归因

- 原理：真实变化的结果不一定在同一个 transition 内可见；如果把“当前没有完整证据”永久等同于“什么也没有发生”，底座无法处理跨时间反馈。反馈仍属于同一套状态—关系—约束—变化—反馈逻辑，必须用稳定 executionNonce 重新闭合而不是依赖调用顺序猜测。
- 实现：Observation 可携带有界 `feedback[]`，每项绑定 executionNonce、后验状态版本、区间、向量和 confounderCount。Kernel 对 accepted、归因窗口未完成且无已知混杂的动作保存 pending credit，基线从动作前观测推导；若同一步结算旧 clean feedback，只把该旧 nonce 的实际变化叠加到新 pending 基线，不把当前动作的部分即时变化重复归因；同一步出现 settled feedback 时当前动作保守跳过学习。后续匹配反馈更新总体/关系模型并返回 `settled`，混杂反馈只记录 AMBIGUOUS；有界 settled feedback 收据使完全相同的重复投递幂等忽略，同 nonce 矛盾内容、未知 nonce 以及超限数据 fail-closed。新账本还以有界观察机会推进 pending credit 的 age，超过策略窗口仍无证据时移出 pending，返回 `UNRESOLVED/FEEDBACK_TIMEOUT` 且不学习，之后的晚到反馈按未知 nonce 拒绝。Application、外部 WorldPort 协议、STEP 账本和 Replay 保持同一投影。
- 验证：Kernel 覆盖延迟闭合、混杂不学习、未知 nonce、重复投递和矛盾投递；独立外部 adapter 让第一 Run 产生 pending，后续新的 adapter 进程返回反馈并重复返回历史反馈，多个 Run 都可 Replay 为 CONSISTENT，状态和 Memory 跨进程恢复。
- 边界：这只是显式后验快照的有界信用归因，不是部分可观测环境的信念状态、完整因果识别、跨世界语义对齐或长期自主性；收据窗口之外的旧重复反馈仍会被拒绝，旧账本没有被静默迁移到新窗口；后续反例需要检验反馈乱序、隐藏状态和多动作同时生效。

## F-27 反馈窗口关闭与未闭合结果

- 原理：持续闭环不能把“等待更多证据”变成无限增长的隐含状态；当一个变化在有限观察机会内没有返回可归因反馈，底座必须记录“证据缺失”而不是制造学习结论。
- 实现：新 Lab 的 Kernel memory 携带 `pendingCreditPolicy.maxAge=8`。每个无反馈的 STEP 推进 pending credit 的 age；到达窗口边界时返回 `UNRESOLVED` 与 `FEEDBACK_TIMEOUT`，移出 pending 且不更新动作/关系模型。窗口之后抵达的反馈没有 pending 或 settled receipt，继续按未知 nonce fail-closed。旧 Lab 不注入该策略，以保留既有账本的精确连续性；Replay 以 `kernelLearningVersion=4` 区分两种投影。
- 验证：Kernel 覆盖窗口内保留、边界过期、无学习和晚到反馈拒绝；CLI 通过反馈永久缺失的独立 WorldPort 进程连续启动十个 Run，检查 pending 有界、重启恢复、每个 Run Replay 为 CONSISTENT。
- 边界：观察机会不是物理时间，也不是因果效应已经不存在的证明；它只是底座对等待成本的明确策略。F-28 已引入可检验的后验分支信念，但乱序反馈、多动作并发和真实隐藏状态辨识仍待验证。

## F-28 部分可观测变化的有界预测信念

- 原理：同一数值观测可能对应多个未显露的真实状态；底座不能把后验均值冒充唯一变化，也不能读取领域内部字段来强行辨识。共同能力应保存可观察后验的有限分支，并将分支离散度反馈到不确定性。
- 实现：新 Lab 的 Kernel memory 携带可选 `beliefModels`，按 `Token×RelationSignature` 保存最近最多 8 个已验证后验变化样本；样本只由 `ACTION && learnable` 的当前动作或已闭合的 clean feedback 写入。Kernel 用样本相对当前预测均值的平均绝对离散度提升不确定性，安全筛选、WorldPort 回执和模型权限不变；旧 Lab 不注入该字段，Replay 以 `kernelLearningVersion=5` 保持历史 Memory 形状。
- 验证：同一 manifest、token、数值观测和 RNG 下，两个隐藏动力学分别产生 `+1/-1`，WorldPort 观测输入相同但后验不同；Kernel 必须保留两条样本、提升后续不确定性。样本上限、跨 Run、重启和 Replay 保持一致，既有五个内置 WorldPort、外部 adapter 和晚绑定 Oracle 继续通过。
- 边界：这是预测结果的有界信念，不是隐藏状态识别、概率校准、全局 POMDP 求解、严格因果模型或长期自主性；同一观测且没有额外证据时只能保持不确定，后续需用多动作并发和真实部分可观测 WorldPort 继续证伪。反馈乱序已在 Kernel 公共边界收窄为规范化结算：同一批合法 nonce-bound 反馈的传输顺序不能改变持久 Memory 或 `settled` 输出；这不提供多动作信用分配，重叠效果仍需显式混杂证据。

## F-29 反馈集合的规范化结算

- 原理：反馈是按 `executionNonce` 绑定的一组后验事实，不是按到达顺序构成的事实流；如果传输顺序进入持久 Memory，重启、不同 WorldPort 和 Replay 会对同一变化产生不同认知。
- 实现：v6 Kernel 在结算前按 pending credit 的持久顺序排序合法 feedback；该顺序同时稳定 `settled`、`settledFeedback` 和 `beliefModels` 的样本写入。Replay 对 v5 及以前显式保留历史到达顺序，避免重算旧账本时改变结果。未知 nonce、矛盾 feedback、重复 nonce 和超限数据仍 fail-closed，不通过排序掩盖契约错误。
- 验证：两个 pending action 收到同一组反馈的正序与逆序时，`settled` 与完整 Memory 规范化相等；已有延迟反馈、重复投递、窗口关闭、重启和 Replay 回归继续通过。
- 边界：规范化消除的是传输时序差异，不是多动作信用分配；一个观测无法区分多个动作的重叠效果时，WorldPort 必须提供 `confounderCount>0`，Kernel 只记录 `AMBIGUOUS` 而不学习。

## F-30 共享观测边界的保守多动作归因

- 原理：多个 pending action 如果只得到同一 `stateVersion + intervalId` 的后验快照，数值结果没有提供把变化拆回各动作的独立观测边界；不能因为 adapter 将 `confounderCount` 声明为 0 就把同一份变化复制成多条经验。
- 实现：v7 Kernel 在 feedback 结算前按观测边界统计本批新反馈；同一边界出现多个 pending nonce 时，全部记录 `AMBIGUOUS`、移出 pending 并保留有界收据，不更新总体模型、关系模型或信念样本。v6 及以前 Replay 显式使用旧归因模式，避免重写历史。
- 验证：独立外部 adapter 让两个动作跨 Run/进程保持 pending，再在第三个 Run 以相同后验边界返回两条故意声称 clean 的 feedback；正序/逆序 adapter 得到相同 Memory，两个 settled 均为 `AMBIGUOUS`，动作模型不增长，三个 Run 均可 Replay 为 `CONSISTENT`。
- 边界：不同观测边界的 feedback 仍只能说明各自快照下的经验效应，不是严格因果证明；共享边界规则也不能识别 adapter 伪造的边界或现实中的隐藏混杂，真实设备仍需提供可审计的隔离/对账证据。

## F-31 外部 WorldPort 的不透明版本边界

- 原理：`stateVersion` 和 `intervalId` 是世界给出的边界标识，不是 Kernel 可以解释的领域文本。把它们强制成 `state:<worldId>:<revision>` 会把一个实现习惯误当作通用契约，阻断哈希版本、复合时钟和不暴露世界名称的合法 WorldPort。
- 实现：外部适配器宿主只要求版本/区间标识为非空字符串，并继续校验 revision 单调性、nonce 窗口、观测前后绑定和反馈边界；不再检查 stateVersion 的字符串模板。内置世界保留自身内部格式，旧外部 adapter 的正常格式保持兼容。
- 验证：独立外部 adapter 使用 `opaque-v7/<revision>` 与 `boundary-v7/<revision>` 完成 init、跨进程 Run 和 Replay；非法 revision 仍在写入 STEP 前被拒绝。
- 边界：不透明标识不能证明适配器没有伪造现实版本；真实外部系统仍需提供可审计的版本/对账语义，宿主只验证它能观察到的连续性。

## F-32 延迟反馈与变化监督器的证据对齐

- 原理：一个合并 observation 同时携带旧动作的后验 feedback 和当前动作的回执时，Kernel 可以把旧 nonce 独立结算，但监督器若只读取当前 `Verification`，会把旧动作造成的距离下降冒领为当前动作进步。
- 实现：`ChangeSupervisor.advance` 接收本步是否存在新的 feedback settlement；该标记为真时，即使当前 receipt 自报 clean，也不确认当前动作的进步、不重置停滞或更新最佳距离。重复的已结算收据和纯 `FEEDBACK_TIMEOUT` 不会无端阻断当前动作；Application 与 Replay 使用同一标记。
- 验证：外部 delayed-feedback adapter 让第一动作保持 pending，第二动作声明窗口已关闭但返回第一动作的反馈；第二 STEP 的反馈仍按 nonce 学习，监督器的 `lastChange` 为 `AMBIGUOUS/confirmed:false/improved:false`，跨进程 Replay 一致；Replay 对降级为 v7 的旧监督语义账本仍保持一致。
- 边界：这只能对齐本地可见的反馈结算与监督状态；如果 adapter 隐瞒反馈、伪造边界或世界存在不可观测变化，底座仍不能推出严格因果。

## F-33 隐藏状态 WorldPort 的系统级反证

- 原理：同一可见状态或关系位置可能对应多个未暴露的世界状态；底座必须保留有界后验分支，不能把一次观测路径误当成唯一动力学，也不能把隐藏字段泄漏给 Kernel 后再宣称完成了部分可观测验证。
- 实现：`test/fixtures/hidden-state-world-adapter.mjs` 通过独立 JSONL 子进程持久化 `hiddenMode`、阶段机和效果记录，只把 `value` 投影给 Kernel，并用 `supportsStateDependentActions:true` 暴露每个阶段唯一的安全动作；`test/e2e/hidden-state-world-cli.test.mjs` 以两个独立 CLI Run 完成 `flip→advance→reset` 轨迹，读取 manifest 的 capability 映射确认 `advance` Token，检查 `Token×RelationSignature` 后验分支、外部效果计数、最终状态和每个 Run 的 Replay。
- 验证：同一可见 `value=0` 与 `r1:+` 关系下，`advance` 交替产生 `-1/+1`，跨 Run 的信念样本为 `[[-1],[1],[-1],[1]]`；11 次外部效果不重复，最终状态为 `value=1/hiddenMode=A`，两个 Run 均为 `CONSISTENT`。
- 边界：该反例只证明有界信念能保留已验证的多分支，不能证明隐藏状态识别、概率校准、因果识别、全局 POMDP 或现实世界自主性；不能为 adapter 的隐藏字段向 Kernel 增加领域特判。

## F-34 有界近期变化上下文的策略适应

- 原理：仅保存同一动作的多分支后验，不能回答“刚刚发生的已验证变化如何改变当前行动条件”；底座需要把有限历史作为可复用上下文，但不能把 WorldPort 的 hidden mode、领域名称或自然语言标签写进 Kernel。
- 实现：新 Lab 的 Memory 增加有界 `recentHistory` 与 `contextModels`；最近两个已验证的 `{Token,actualDelta}` 形成稳定 `h1:` 上下文签名，Kernel 按 `context×Token` 预测，缺少上下文样本时回退到关系模型和总体模型。未闭合 feedback、混杂和拒绝不进入历史；旧 Memory 不注入新字段，Replay 继续按账本中的字段形状运行。
- 验证：`history-conditioned-world-adapter.mjs` 将模式 A/B 留在外部持久状态，只投影一维 value；探针后 value 恢复为零，训练四组目标动作，再在相同可见输入下验证模式 A/B 是否分别选择 `target-a/target-b`。外部 28 次效果、上下文模型、重启边界和 Replay 必须一致。
- 边界：窗口 2 只是当前可证伪的最小历史尺度，不是完整状态估计、因果识别或长期记忆；若真实世界需要更长依赖，必须用新的外部反例证明并重新选择公共上下文契约，不能偷偷扩大窗口或添加领域特判。

## F-35 延迟反馈不改变历史发生顺序

- 反例：动作 A 先执行但反馈延迟，动作 B 的即时结果先完成；A 的反馈在 B 之后到达。旧实现按学习/反馈到达顺序写入 `[B,A]`，与真实动作顺序 `[A,B]` 相反。
- 实现：新 Memory 增加 `historyClock`；每个可学习或进入 pending 的动作携带单调 `historyOrder`，近期历史按该序号保留最近两个；旧 Memory 没有时钟时保持旧形状。
- 兼容：`kernelLearningVersion: 10` 固化新顺序语义；Replay 低于 v10 时剥离时钟和序号，不改写旧账本。
- 验证：Kernel 反例测试必须先观察旧实现失败，再确认 `[A,B]`；随后补充外部 WorldPort 的真实 CLI、重启和 Replay 证据。

## F-36 有序历史状态的 fail-closed 约束

- 反例：新 Memory 曾接受两个相同 `historyOrder`，或接受大于 `historyClock` 的历史条目；排序结果会依赖输入排列，破坏持久上下文的唯一性。
- 实现：带 `historyClock` 的 Memory 要求 recent/pending 中的动作序号存在、唯一且不超过时钟；没有时钟的旧 Memory 继续走旧语义。
- 边界：这只保证当前两步历史表示的内部一致性，不解决固定窗口对三阶及更长依赖的表达上限；三阶反例已确认需要重新设计上下文表示，而不是继续堆叠常数。
- 验证：Kernel 拒绝重复/超前序号；全量旧账本、跨进程重启、Replay 和 late-bound Oracle 保持一致。

## F-37 可压缩的顺序因果上下文

- 反例：三步历史直接超过固定 `recentHistory` 窗口；把窗口改成 3 仍会被更长依赖击穿。
- 实现：新 Memory 以固定 256 位顺序敏感累积状态表达已验证变化；动作序号作为位置系数，延迟反馈可在旧位置补入，当前最近两条轨迹继续保留作审计。Kernel 同时保留 h1 可泛化上下文与极小有界的 h2 精确指纹缓存，预测缺少 h2 样本时回退 h1，避免长期指纹把连续运行的快照推成线性增长。
- 兼容：`kernelLearningVersion: 11` 启用 `historyAccumulator`；`kernelLearningVersion: 12` 启用基于已验证 belief samples 的主动信息规划；`kernelLearningVersion: 13` 将信息价值收紧为“后验分支必须改变下一步决策/预期变化”；`kernelLearningVersion: 14` 进一步要求该变化落在当前 ValueSpec 的价值几何内；旧版本 Replay 移除不属于其版本的字段，不改变旧上下文和旧规划语义。
- 边界：这是有限状态摘要，不是无限记忆、语义理解、无碰撞证明或因果识别；摘要碰撞、h2 精确缓存的极小容量和 `contextModels` 总容量仍是明确实验边界。
- 验证：三步序列在最近窗口仍为 2 条但累积状态不同；顺序置换产生不同上下文；延迟 feedback、跨进程重启、Replay、旧账本和 48 个随机 WorldPort 继续通过。

## F-38 有界主动信息价值

- 反例：同一可见观测下，眼前收益略高的动作无法区分后续关系，而眼前收益较低的安全探测动作拥有已验证的多分支后验；均值规划会持续利用，不能主动降低下一步决策的不确定性。
- 实现：`kernelLearningVersion: 14` 的规划读取候选动作当前关系下最多 8 个 `beliefModels` 后验样本，只在第一步做有界结果分支；每个分支仍通过同一关系签名重新生成安全候选，并且只有分支后的下一步价值相关预期变化真正不同，才把当前不确定度与分支后不确定度的下降计入规划效用。无 belief samples 时保持均值推演；Replay 对 12 之前的 STEP 强制 legacy 均值语义，对 v12 保留旧的“仅看不确定度”规则，对 v13 保留未投影的决策分化规则。Kernel 不接收隐藏状态、领域字段或信息增益标签。
- 边界：这是从已验证数值后验和关系分区得到的主动实验启发式，不是完整 belief-state、熵、因果或 POMDP 求解；分支样本有限、未来记忆不在模拟中写回，不能证明探测一定有效，也不能越过 WorldPort 的真实安全/授权边界。
- 验证：二维同观测反例中，单步贪心选择利用动作，有界规划在未来决策分化时选择探测动作；对“只在非价值维度产生高方差、未来动作不变”的成对反例拒绝虚假信息价值；既有 detour、最大能力面、CLI、多 WorldPort、重启恢复和 Replay 继续验证。

## F-39 隐藏状态的可辨识性边界

- 原理：如果两个 WorldPort 在当前时刻向底座提供完全相同的公开观测、能力、记忆和随机状态，底座不能凭空选择不同动作；只有后续可验证结果不同，经验模型才有依据分化。
- 验证：Kernel 回归构造两个全部动作均安全、但隐藏动力学相反的世界；相同公开前缀的首个 Token 必须相同，收到结果后两条策略轨迹分化为各自适配的动作。该实验不向 Kernel 传入隐藏模式。
- 边界：这证明的是“未知时保持不可辨识、证据到达后更新”，不是隐藏状态识别、概率校准或完整 POMDP；若公开反馈永远相同，必须保持不确定或请求新的可验证观测/人工确认。

- 外部验证：`test/fixtures/latent-choice-world-adapter.mjs` 让两个全部动作均安全的独立 adapter 只在隐藏动力学上相反；`test/e2e/latent-choice-world.test.mjs` 验证相同公开首步、反馈后的动作分化、效果不重复、进程边界和 Replay。

## F-40 隐藏动力学漂移的有界周期再验证

- 反例：一个已验证动作在 WorldPort 内部发生动力学反转，但由于当前目标下的旧模型仍然占优，Kernel 长期不再选择它；没有新的执行就没有新的反转证据，其他动作会持续把状态带离目标。
- 实现：新 Lab 的 Memory 增加有界 `lastVerifiedSteps`，记录每个不透明 Token 最近一次 `ACTION && learnable` 证据的逻辑序号；当已知安全动作超过 8 个已验证动作未复核且不存在未尝试动作时，Kernel 优先选择最久未验证的候选。`Expectation.verificationAge` 固化选择依据；模型提议不能绕过该安全再验证策略，外部 transition 重试则保留原 Token。
- 兼容：`kernelLearningVersion: 15` 启用新鲜度字段和周期再验证；v15 之前的 Replay 剥离该字段，保持旧账本选择语义。没有 `historyClock` 的旧 Memory 不启用该策略。
- 验证：`test/kernel/history-context.test.mjs` 验证过期安全动作被重新选择并更新序号；`test/fixtures/drifting-choice-world-adapter.mjs` 在独立子进程中隐藏地反转一个动作效果；`test/e2e/drifting-choice-world.test.mjs` 验证跨两个 CLI Run、持久外部效果和 Replay 一致。
- 边界：周期再验证只能在固定间隔内获得新证据，不能感知未执行动作的即时变化、证明变化点、校准概率或解决无反馈/混杂；它是统一的证据获取策略，不是领域特判。

## F-41 有界序列规划的假设记忆传播

- 反例：当前 horizon=2 规划只推进预测观测，不推进历史记忆；一个动作的直接收益较低，但它会让下一动作进入已验证的高收益上下文，规划器仍会选择直接收益较高的动作。
- 实现：v16 在每个候选分支内复制临时 Memory，将首步和后续预测动作的 `Token+actualDelta` 写入近期历史/顺序摘要，再生成下一步预测；临时记忆不写回真实状态，不越过 WorldPort 安全边界。
- 兼容：`contextMode: context-v1` 为新语义；v15 及以前 Replay 强制 `contextMode: legacy-v1`，防止历史规划选择因代码升级而漂移；外部 transition marker 持久化该模式，缺少字段的旧 marker 按 `legacy-v1` 恢复并保持同 nonce 重试身份。
- 验证：一维上下文反例中，静态规划选择直接收益动作 B，传播假设记忆后选择序列入口 A；输入 Memory 保持不变，旧模式仍选择 B。
- 边界：只覆盖固定 horizon 内的模型投影，不能证明长期计划、反事实因果或真实结果必然遵循预测；预测错误仍需真实闭环反馈纠正。

## F-42 后续 belief 的有界递归规划

- 反例：horizon=3 时，首步 A 进入已验证上下文后选择 B；B 的后验有两个结果，只有其中一个结果会让第三步 C 直接抵达目标。只把 B 的均值写入临时历史会选择短期动作 X，按后验分支评估则应选择 A。
- 实现：v17 在首步之后继续对每个未来动作的已验证 belief 结果建立临时观测和临时历史分支；每个候选的递归 rollout 使用固定预算，并保持安全候选筛选、WorldPort 边界和真实 `verify → learn` 记忆转移不变。
- 兼容：v16 及以前 Replay 使用 `branchingMode: legacy-v1` 回放非递归算法；v17 STEP boundary 和外部 marker 固化 `branchingMode: recursive-v1`，缺失字段的旧 marker 按 legacy 恢复。
- 验证：Kernel 三步 opaque-token 反例必须从 X 分化为 A，输入 Memory 不得改变；既有规划、旧版本 Replay、跨进程 E2E 和随机 WorldPort 继续通过。
- 边界：分支预算和 horizon 都是有限启发式，不等价于完整树搜索、概率校准、因果推断或长期自主性。

## F-43 未来动作树的有界策略评估

- 反例：horizon=3 时，首步 A 后的未来状态有两个安全动作；动作 D 的即时预测价值略高但只能继续停留在中间状态，动作 E 的即时价值略低却能进入已验证的 C 上下文并到达目标。只递归 D 的 belief 结果会选择短期动作 X，评估未来动作树才能选择 A。
- 实现：v18 的 `tree-v1` 在每个递归未来状态枚举有界安全候选，为每个候选评估其 belief outcome，再递归进入下一状态；候选选择仍服从未尝试覆盖、安全/授权筛选和固定预算，临时 Memory 不写回，v17 `recursive-v1` 保留旧的贪心未来策略。
- 兼容：v18 STEP boundary 和外部 marker 固化 `tree-v1`；v17 Replay 固化 `recursive-v1`，v16 及以前仍为 `legacy-v1`，避免升级后历史规划选择漂移。
- 验证：opaque-token 三步反例中，未改代码时现实现选择 X；v18 选择 A，v17 分支仍选择 X，输入 Memory 不变；全量、Oracle、连续运行、重启和跨 WorldPort 回归继续通过。
- 边界：动作树仍受固定 horizon、候选窗口和 rollout 预算限制，不等于完整 POMDP、概率校准、因果推断、无限计划或现实适应能力。

## F-44 连续 loop 的规划语义恢复

- 反例：v17 的 loop continuation 只保存 planningHorizon；程序升级到 v18 后执行 `--resume`，如果只按当前默认值恢复，就会把历史 `recursive-v1` 静默替换成 `tree-v1`，同一 loop 的后续选择与 Replay 语义不再一致。
- 实现：新 continuation 固化 `planningBranchingMode`，`runContinuous` 在每个 Run start 和恢复调用中沿用该字段；读取旧 continuation 时扫描已提交 STEP 的 `kernelLearningVersion`/planning marker 及终态 `externalTransition.planning` 证据，推断 v17 `recursive-v1`、v18 `tree-v1` 或更早 `legacy-v1`，多模式混合直接判为 CORRUPT。
- 验证：新 loop 读回 `tree-v1`；缺少字段但已有 v17 STEP 的 loop 读回 `recursive-v1`，后续 Run 继续保存该模式；连续运行、重启恢复、Replay、外部 transition 和 Oracle 保持一致。
- 边界：没有任何 STEP 证据的古老 continuation 无法知道曾使用的规划实现，只能保守 legacy；这不会伪造历史确定性，必要时应由人工重新确认。

## F-45 多 WorldPort 的连续耐久矩阵

- 反例：单个内置世界的一次 loop 通过，不能推出公共底座在不同状态形状、能力投影和外部副作用边界上都能连续运行；一次响应丢失通过，也不能推出恢复后 Replay 不会重复现实效果。
- 实现：新增独立 CLI E2E 矩阵，使用多个内置 WorldPort 验证相同的 loop、inspect、Run 账本和 Replay 契约；使用可持久化外部 WorldPort 注入“效果已提交、响应丢失、宿主进程终止”，再经过显式 recover、跨进程 resume 和 Replay 检查 nonce 幂等与现实效果计数。
- 验证：`node scripts/test-gate.mjs test/e2e/durability-matrix-cli.test.mjs` 执行 3/3；相关 agent CLI、crash/restart、packaged CLI 与该矩阵合计 19/19；外部效果在四次连续强杀恢复后恰好为四次，Replay 后不增加。
- 边界：当前矩阵覆盖三种内置 WorldPort、一个幂等外部 adapter 和四次连续响应丢失；它本身不覆盖非幂等对账，真实设备、无限运行、并发多写者和现实世界对账语义仍需沿各自边界继续构造反例。

## F-46 非幂等 WorldPort 的对账接续

- 原理：外部动作可能已经发生而响应丢失时，本地账本不能把“没有响应”解释成“没有效果”；非幂等 adapter 也不能通过换 nonce 或重试执行来碰运气。只有外部世界明确返回已应用的原始结果，宿主才允许把同一动作写入 STEP。
- 实现：`hello` 可声明 `supportsReconciliation:true`；外部 transition marker 同时固化原始 Kernel intent、能力投影、action request 身份和完整决策边界（目标、监督器、ValueSpec）。恢复未决 external transition 时，宿主向同一 adapter 发出只读 `reconcile` 请求，携带原始 scenario、状态和 action request；即使现实效果改变了当前能力投影，也不重新选择动作。`APPLIED` 必须提供经过同一 state/request/receipt 校验的 accepted transition，宿主不再调用 `transition`；`ABSENT` 与 `UNKNOWN` 都保持 `CONFLICT`/未决状态，不写 STEP；恢复调用不能注入新的 goal/goalPlan/planner。能力声明进入 descriptor digest 和 manifest，旧 adapter 不受影响。
- 验证：独立 CLI E2E 覆盖非幂等 adapter 的响应丢失后 `APPLIED` 接续、`ABSENT` 阻断、`UNKNOWN` 阻断，以及连续 loop 的重启恢复和宿主强杀→显式 recover→resume；APPLIED 效果计数保持一次，完成 Run 的 Replay 不调用外部动作，旧 adapter 的既有恢复回归继续通过。
- 边界：对账结果仍是 adapter 对现实系统的声明，宿主只能验证其结构、原始动作绑定和状态连续性，不能证明外部系统没有伪造结果；真实设备的查询权限、签名、人工复核和“未找到后是否允许再次执行”仍属于外部契约与人工安全门。本协议暂不把 `ABSENT` 自动升级为可执行。

## F-47 非幂等 loop 的并发恢复

- 反例：单个 `--resume` 成功不能推出两个独立 CLI 同时恢复同一未决 loop 时不会重复副作用，尤其是对账与下一逻辑 Run 可能交错。
- 验证：两个真实 CLI 进程同时执行 `--resume --auto-recover` 恢复同一个可对账非幂等 loop；必须保持每个逻辑 Run 至多一次、外部效果计数精确为逻辑 Run 数，且 lab 只保留一个已恢复的 crashed Run 加三个完成 Run；每个完成 Run 的 Replay 均为 `CONSISTENT`。
- 边界：当前证明的是本地文件账本和单 writer lock 下的跨进程排他；分布式存储、网络分区和真实设备的原子查询/执行仍不在本地实验范围内。

## F-48 恢复决策边界语义校验

- 原则：恢复不是重新推理，账本中的原始决策边界必须能被当前 Runtime 语义化验证后才能再次进入 Kernel。
- 实现：`external-transition.json` 的 ValueSpec、ChangeSupervisor、目标激活计划和 Planner 证据均经过完整边界校验；摘要可被重新计算但内容语义畸形时，统一判为 `CORRUPT`。
- 验证：覆盖畸形 ValueSpec、监督器和目标激活计划，且连续运行、强杀恢复、并发接续、跨 WorldPort 回归与 Oracle 均保持通过。
- 边界：这仍是本地账本完整性与语义校验，不等价于外部 WorldPort 对现实回执的密码学认证；签名对账回执需要后续协调协议契约。

## F-49 显式 opt-in 的 loop 自动恢复

- 原则：长期 loop 在进程崩溃后可以减少人工接力，但不能把“看起来像陈旧”的 writer lock 当成死亡证明；自动恢复必须复用同一 liveness probe 和恢复矩阵，并保持活跃 owner 不被抢占。
- 实现：`agent loop --resume --auto-recover` 先读取 writer owner 身份并确认 current 为 `RUNNING`，再调用既有 `LabStore.recover`；仅系统判定旧 owner 已死亡时接管，完成边界短暂无锁时仍复探测原 owner，避免把活跃进程误判为已完成。其他状态保留人工 `recover --confirm-lock-owner-dead` 路径。非 resume 使用自动恢复会在 CLI/Application 边界拒绝。
- 验证：真实外部 transition 响应保持挂起时强杀 CLI，单次 `--resume --auto-recover` 完成剩余 loop 且效果不重复；旧 CLI 仍存活时并发自动恢复返回 `LIVE_OWNER/BUSY`，不新增 Run、不终止旧进程。
- 边界：这是本地文件账本下的显式自动化；同一用户主动伪造 PID、Windows 进程终止与锁检查之间的竞态、分布式锁和真实设备安全仍不在保证范围。

## F-50 forever continuation 的历史扫描边界

- 反例：如果每个 forever Run 都为判断 loop 所有权扫描并校验全部历史 Run，Run 数增长会把连续运行退化为历史数量的重复扫描，1000 个单步边界无法在可接受时间内完成。
- 实现：正常 `--resume` 和 `startRun` 已持有唯一 writer lock 后，只从 verified current 指向的最新 terminal Run 读取并总结当前 continuation；新 loop 没有既有 owner 时强制从逻辑索引 0 开始。显式启动时的冲突检查、`readLoopContinuation` 审计和恢复候选扫描仍保留全量账本校验。正常账本的唯一 active continuation 仍由此前的 startRun 原子所有权约束保证，历史全量扫描继续作为显式恢复/审计路径。
- 验证：1000 个单步 forever Run 在真实 Runtime 中完成，内存结果仍只保留最近一个 Run，最终 current 与累计指标一致；随后从 current frontier 接续第 1001 个逻辑 Run，显式 `readLoopContinuation` 审计仍保持可用；既有全量账本、恢复、Replay 和跨 WorldPort 测试保持通过。
- 边界：该优化不改变账本真相或绕过当前 Run 的结构校验；若同一用户主动篡改历史形成多个 continuation，必须通过全量 inspect/recovery 审计发现，分布式索引和无限磁盘增长仍不在 v0.1 保证范围。

## F-51 连续 Runner 的规划分支契约

- 反例：应用 API 接受 `planningBranchingMode: recursive-v1`，但连续 Runner 创建 continuation 时固定写入 `tree-v1`，导致调用输入、immutable start、STEP 决策边界和后续 Replay 语义不一致。
- 实现：新 loop 沿用调用方已验证的 `planningBranchingMode`，未指定时才使用 `tree-v1`；默认 `tree-v1` 在 horizon=1 可保持紧凑证据，非默认分支即使 horizon=1 也写入显式 STEP evidence；resume 仍只接受持久化的 continuation 契约，不重新接受规划配置。
- 验证：真实 application loop 写入 `recursive-v1` 的 start 与 STEP，并完成 Replay；已有连续运行、重启恢复、全量审计和跨 WorldPort 矩阵保持通过。
- 边界：分支模式仍是有限规划策略，不等于通用规划；CLI 当前不暴露该内部兼容参数，外部用户默认使用 `tree-v1`。

## F-52 WorldPort JSONL 传输故障闭环

- 反例：只验证一个理想的一次性 JSON 响应，不能推出 WorldPort 跨 Windows 子进程边界仍可判定；半帧、重复响应、错请求 ID、错协议版本和 stdout 污染都可能把“没有得到完整事实”误写成一步成功。
- 实现：沿用现有 `yi-world-cli` 单请求/单响应边界，测试 adapter 注入截断 JSON、重复 JSONL 响应、错误 ID、错误版本、非 JSON 污染、超时和非零退出；宿主必须在外部响应完成且 envelope 严格匹配前不追加 STEP。另验证 adapter 的 stderr 诊断与 CRLF 响应不会污染 stdout 协议。
- 验证：`test/e2e/cli.test.mjs` 对每种故障真实启动独立 adapter 子进程，并检查 Run 账本 STEP 数为零；stderr/CRLF 真实完成 `init→run→replay` 且 Replay 为 `CONSISTENT`。
- 边界：当前仍是本地一次请求一次进程的 JSONL 协议，不等于网络流式传输的分片重组、消息确认或分布式重试保证；持久 adapter 会话、网络分区和外部效果发生后响应丢失仍需沿非幂等对账契约与人工安全门继续验证。

## F-53 连续运行的有界记忆淘汰

- 反例：如果每个新关系、隐藏结果或历史上下文都永久留在 Memory，连续 WorldPort 迟早会撞上固定上限；如果直接抛错，Agent 会在尚未完成现实目标时因内部缓存耗尽停机；如果无规则删除，重启和 Replay 又会产生不同决策。
- 实现：`kernelLearningVersion: 19` 对 relation、belief 和 context 三类嵌套模型按稳定嵌套映射顺序淘汰最早项，保持每类既有硬上限；淘汰发生在 `verify→learn` 的纯 Memory 转移内，不改变 WorldPort 权限、执行回执或真实状态。旧版本账本在未触及上限时保持原结果，Replay 支持 v19 并重现同一淘汰顺序。
- 验证：Kernel 构造达到上限的关系/信念/上下文 Memory，再提交一个新证据；每类数量保持上限、新模型存在、最旧模型被移除。连续 CLI、跨进程重启、Replay、五个内置 WorldPort、外部 adapter 和晚绑定 Oracle 继续通过。
- 边界：这是固定容量下的确定性遗忘，不是重要性学习、语义压缩、概率校准或无限长期记忆；淘汰可能丢失仍有价值的经验，后续需要用变化速度和未知 WorldPort 反例校准容量与淘汰策略。

## F-54 全模型族的连续 Token 淘汰

- 反例：F-53 只覆盖 relation、belief、context；一个连续 WorldPort 若逐步暴露第 8193 个全新能力 Token，`actionModels` 或 `rejectionModels` 仍会直接抛出容量错误，Agent 依旧可能在经验种类增长时停机。
- 实现：`kernelLearningVersion: 20` 对 `actionModels`、`rejectionModels` 以及已有三类嵌套模型统一采用确定性有界淘汰；新增顶层模型时按稳定顶层映射顺序移除最早项，并同步清理被淘汰 action Token 的 `lastVerifiedSteps`，避免新鲜度索引残留。每一类仍保持自己的容量边界，淘汰发生在 `verify→learn` 的克隆 Memory 内。
- 验证：Kernel 在 action/rejection 两类模型达到 8192 项后提交第 8193 个新 Token，数量保持上限、最早项移除、新项写入；全量回归与 Replay 继续覆盖 v20。
- 边界：稳定映射顺序是可复现的确定性遗忘，不是按价值、频率或语义重要性学习；各模型族独立淘汰可能保留某个 Token 的更具体上下文而移除总体模型，后续需要用跨 Token 置换和真实未知 WorldPort 反例决定是否引入统一的持久模型年龄。

## F-55 持久模型年龄与表示顺序独立

- 反例：F-54 把 JavaScript 对象的插入顺序当作“最早模型”；同一语义 Memory 只改变 JSON 键顺序时，`canonicalDigest` 不变，但下一次容量淘汰可能移除不同 Token，跨 WorldPort、重启和 Replay 的共同底座因此不再表示独立。
- 失败证据：第一版为每类模型保存完整路径顺序表，逻辑上修复了置换反例，但 10,000 步连续运行的真实 ledger 超过固定 32MB 上限；这个方案被 NFR 反证，不能靠扩大阈值或弱化断言放行。
- 实现：`kernelLearningVersion: 21` 用每个模型的 `modelAge` 和 Memory 级 `modelClock` 表达统一创建序列；新增模型递增时钟，更新模型保留年龄，顶层及嵌套淘汰按最小年龄、再按规范化身份决胜。缺少年龄的 v20 及更早 Memory 保留原稳定映射顺序，并由 Replay 对新字段做版本投影。
- 验证：Kernel 对同一年龄映射的正序/逆序 JSON Memory 均淘汰同一最老 Token、生成同一新年龄；应用/Runtime、NFR、CLI E2E、全量回归与多 WorldPort 连续/重启/Replay 继续验证。第一版顺序表的 ledger 超限作为失败边界保留在本记录中。
- 边界：年龄只表达创建先后，不等于价值、频率、因果可信度或语义重要性；模型族仍独立受容量限制，真正的跨模型重要性与遗忘策略仍需新的可证伪 WorldPort 反例。

## F-56 模型年龄状态的原子契约

- 反例：Memory 若携带 `modelAge` 或紧凑 `modelAges` 却缺少 `modelClock`，第一轮淘汰仍可能被接受；新增模型后年龄表示变成半版本状态，下一轮会回退到对象插入顺序，同一 `canonicalDigest` 的正序/逆序输入因此产生不同淘汰结果。
- 实现：Kernel 将 `modelAge/modelAges` 与 `modelClock` 视为一个不可拆分的持久表示；没有时钟的年龄状态在 `step` 与 `learn` 的公共 Memory 校验入口统一 fail-closed。无年龄字段的 v20 及更早 Memory 不受影响，v21 的正常 Memory 仍要求全部模型年龄不超过时钟。
- 验证：Kernel 回归覆盖逐模型年龄和紧凑年龄向量两种畸形输入，分别确认 `step`、`learn` 均拒绝；原始顺序置换反例在修复前产生分叉，修复后不再进入淘汰路径；48 个 Kernel 契约、全量回归与既有旧版本 Replay 继续通过。
- 边界：这只保证年龄表示的版本原子性，不解决模型族独立淘汰、创建年龄不等于重要性，以及跨模型经验如何共享生存预算；后者仍需新的可观察 WorldPort 反例决定是否升级记忆实体模型。

## F-57 淘汰后证据新鲜度保持一致

- 反例：F-55/F-56 的统一年龄淘汰可能先移除某个 Token 的总体 `actionModel`，但保留同一 Token 的关系模型；旧逻辑同时删除 `lastVerifiedSteps`，关系模型仍会被使用，却以 `verificationAge:null` 绕过 F-40 的周期再验证。
- 实现：`recordActionEvidence` 延迟处理被淘汰 Token 的新鲜度索引，等本次完整 `verify→learn` 转移完成后，只有该 Token 已无关系、信念和历史上下文模型时才删除 `lastVerifiedSteps`。因此索引始终覆盖仍可能被选择的已验证模型证据，不改变模型容量或 WorldPort 边界。
- 验证：Kernel 构造 8192 个带年龄的 action 模型和一个保留关系模型的 Token，真实学习新 Token 后确认总体模型被淘汰、关系模型保留、新鲜度序号仍在；下一次 `step` 继续选用关系预测并返回有限 `verificationAge`。既有周期再验证、全量回归和晚绑定 Oracle 保持通过。
- 边界：这只修复 Token 级证据索引与模型生命周期的错位，不代表模型重要性排序，也不解决各模型族共享生存预算或主动保留策略；这些仍需新的 WorldPort 反例。

## F-58 嵌套模型淘汰后的孤儿新鲜度清理

- 反例：当 Token 没有总体 `actionModel`，只剩一条关系模型和 `lastVerifiedSteps` 时，关系容量淘汰可以移除最后一条可复用证据；旧逻辑没有经过关系淘汰路径清理该索引，Memory 会保留一个不再对应模型的历史新鲜度记录。
- 实现：将 `lastVerifiedSteps` 维护提升为 Memory 克隆后的派生不变量，按当前 action、relation、belief、context 四类可复用模型扫描并删除孤儿索引；因此总体模型淘汰后仍有嵌套证据时保留，所有证据消失时清理。
- 验证：Kernel 构造关系模型达到 8192 项、移除没有根模型的最老 Token 后确认关系数量不变、该 Token 的索引消失、当前 Token 的学习结果保留；F-57 的根模型淘汰/关系保留场景、全量回归和晚绑定 Oracle 继续通过。
- 边界：这保证索引与证据生命周期一致，不改变有限容量下的淘汰选择，也不解决跨模型族共享生存预算、重要性排序或防止高价值模型被创建年龄淘汰。

## F-59 共享持久化生存预算

- 反例：各模型族分别限制为 8192 项，仍允许 action、rejection、relation、belief、context 同时增长；一个可由 Kernel 产生的 Memory 在真实 `LabStore.append` 中达到 1,670,385 字节，触发 `Ledger event payload exceeds the size limit`，连续 Agent 会因内部记忆而停机。
- 实现：将 1 MiB 事件上限与 768 KiB Memory 预算提升为公共 schema 契约。Kernel 在可持久化 Memory 克隆阶段统计规范 JSON 字节数，跨五类模型按 `modelAge`、规范化路径稳定淘汰，批量重算以控制长跑 CPU；淘汰后清理孤儿 `lastVerifiedSteps` 并重建 `modelAges`，旧的无年龄 Memory 继续使用兼容的稳定映射顺序。
- 验证：真实存储入口复现超限；Kernel 覆盖单族容量、跨族合并、年龄顺序、F-57/F-58 新鲜度及现有 Replay/连续运行契约；最终持久化 Memory 不超过共享预算。
- 边界：768 KiB 是为当前 1 MiB STEP 包保留证据余量的持久化预算，不是语义重要性评分；单个非模型字段若独占事件上限仍会被存储层拒绝，后续需要由新的可观察反例决定是否继续压缩证据表示。

## F-60 持久化预算版本兼容

- 反例：F-59 改变了 `learn` 输出 Memory 的持久化形状；如果 Replay 仍把旧 v21 STEP 当作当前版本重算，合法的近容量历史可能被新预算提前淘汰，导致旧账本的 Replay 漂移。
- 实现：应用层新 STEP 升级为 `kernelLearningVersion: 22`；Replay 从 STEP boundary 读取并传入 Kernel。v22 及以后启用共享 768 KiB Memory 预算，v21 及更早版本仅保留此前的年龄压缩语义；Kernel 拒绝大于当前支持版本的输入，防止静默猜测未来规则。
- 验证：新增旧 v21 近容量 Memory 的 Kernel 兼容断言，覆盖 Replay 的版本透传、应用层边界版本和既有全量 Kernel/Application/Replay 契约；语法检查与晚绑定 Oracle 继续作为独立证据。
- 边界：版本兼容只保证已定义版本的确定性重演，不让旧账本获得新预算；未来修改持久化 Memory 形状仍必须新增版本并补充旧版本投影，不能仅依赖当前默认值。

## F-61 有界 WorldPort 边界标识

- 反例：Kernel 原先接受 500,000 字符的 `stateVersion`，并把它复制到预测观察；外部 adapter 也没有共享长度契约，长标识可能直到 STEP 追加时才撞上 1 MiB 事件上限。
- 实现：在公共 schema 增加 `MAX_BOUNDARY_IDENTIFIER_LENGTH=4096`；Kernel 对观察、feedback 和 pending credit 的 `stateVersion/intervalId` 使用同一上限，外部 WorldPort 对 state、observation 和 feedback 也在协议归一化入口执行同一检查。标识保持 opaque，不添加领域格式限制。
- 验证：Kernel 在预测前拒绝超限标识；外部 CLI adapter 在 `init` 后第一次 `run` 即被协议层拒绝且不追加 STEP；既有 opaque stateVersion、跨进程恢复、Replay 和晚绑定 Oracle 继续验证。
- 边界：4096 是持久化边界，不是现实系统版本语义或真实性证明；receipt 中其它持久化文本仍须沿各自契约保持有界，未来若改变该上限需要重新评估事件预算与版本兼容。

## F-62 证据新鲜度驱动的模型淘汰

- 反例：v22 在一个同时含 8192 个 action 与 8192 个 rejection 模型的 Memory 中反复验证最早创建的 Token；共享预算压缩后该 Token 的 action 模型仍被淘汰，实际结果为约 1,529,099 字节输入压缩到 785,826 字节、`retainedAction=false`，创建年龄掩盖了持续证据。
- 实现：v23 为已验证触碰的模型重新分配统一 `modelClock` 序号，覆盖 action、rejection、relation、belief、context 五类模型及延迟 feedback 结算；共享预算仍按年龄和稳定身份淘汰，v22 及更早版本保持创建年龄语义，Replay 传入版本后不会改写旧账本。
- 验证：Kernel 对同一容量反例断言 v22 淘汰旧 action、v23 保留被重新验证的 action，并确认压缩后 Memory 仍在 768 KiB 内；全量回归、外部 WorldPort、连续恢复和晚绑定 Oracle 继续作为独立证据。
- 边界：证据新鲜度只是“最近被验证”的领域无关信号，不代表模型重要性、未来效用、因果真实性或语义理解；未被重新验证但仍有价值的模型仍可能被淘汰，下一步必须由新的 WorldPort 反例决定是否需要频率、置信度或多信号生存策略。

## F-63 统一执行 nonce 边界

- 反例：外部 WorldPort 的 `usedExecutionNonces` 原先只限制数组最多 8 项，不限制每项长度；因此状态可以携带超长 nonce，直到后续 STEP 序列化时才触发持久化大小错误。
- 实现：公共 schema 增加 `MAX_EXECUTION_NONCE_LENGTH=256`；Kernel 的 feedback、pending credit、receipt 与外部 adapter 的状态 nonce、feedback nonce 共用该常量，保持执行身份不透明但有界。
- 验证：外部 CLI adapter 返回超长状态 nonce 时，在第一次 `run` 的协议归一化阶段失败，且 inspect 确认没有创建 Run；既有 nonce 幂等、延迟 feedback、崩溃恢复和晚绑定 Oracle 继续通过。
- 边界：该上限只约束本地持久化/传输标识长度，不证明外部 nonce 的密码学真实性；外部状态中的其它任意领域字段仍需要独立的状态大小与事件预算实验。

## F-64 可靠性支配式模型淘汰

- 反例：F-62 的 v23 只按最近验证年龄保留模型；一个高样本、低不确定度的旧 action 与一个新近、低样本、高不确定度的 action 同时逼近共享预算时，单一 recency 会把两者视为不可区分的“新鲜证据”，无法表达已有证据对新噪声的支撑关系。
- 实现：`kernelLearningVersion: 24` 引入 `pareto-v1`。对同构的 action/relation/context 预测模型，只用已有的 `sampleCount` 与 `uncertainty` 建立偏序：样本不少且不确定度不高的模型支配另一模型；被支配者优先进入共享预算淘汰队列，仍无法比较的模型按 v23 的 `modelAge` 与稳定身份决胜。用按不确定度分组的前缀最大样本数计算支配标记，避免对长跑 Memory 做全量两两比较。rejection/belief 不被强行映射到预测质量坐标。
- 验证：容量反例中 v23 会淘汰持续高质量但较旧的 `TOKEN_A`，v24 保留该非支配模型，同时仍把 Memory 压到 768 KiB 以内；应用层 STEP 版本升级到 24，旧版本 Replay 不改变；目标是为模型淘汰增加可解释的质量偏序，不是声称发现了通用重要性。
- 边界：样本数和不确定度仍是有限统计证据，不是因果真实性；最近的高不确定度模型可能是环境漂移的最早信号，非支配候选之间也没有不依赖目标的唯一选择。后续必须用漂移 WorldPort、模型族互相挤压和重启/Replay 反例继续决定是否需要新的可观察信号，不能直接加入任意权重。

## F-65 WorldPort 状态持久化预算

- 反例：外部 adapter 原先允许任意领域字段进入 `nextWorldState`；实测约 1.045 MB 的合法对象能通过状态协议和 Kernel，直到 STEP 原始 JSON 超过 1 MiB 才失败。若真实外部效果已发生，这个失败点已经晚于执行，且不能由宿主把大状态安全写进 Replay 链。
- 实现：公共 schema 增加 `MAX_PERSISTED_WORLD_STATE_BYTES`，取事件上限扣除 Memory 预算后的剩余空间一半，即当前 128 KiB。内置 `createWorldPort` 和外部 WorldPort 的状态归一化入口都对 canonical JSON 字节数执行同一边界；canonical JSON 不合法也转换为带字段上下文的协议错误，不让任意 TypeError 穿透边界。
- 验证：生成 adapter 返回 1.045 MB 领域状态时，CLI 在 STEP 追加前拒绝，账本 STEP 数保持为零；既有外部状态、五个内置 WorldPort、重启/恢复、Replay 与 338 项回归继续覆盖。该实验还确认了此前真正的失败位置是持久化预算，而非 Kernel 预测。
- 边界：128 KiB 是当前 STEP 预算分配，不是通用领域状态大小答案；状态超过该值必须引入快照、引用或分片协议，并重新定义幂等与 Replay 绑定。若外部副作用在状态被拒绝前已经发生，宿主仍只能依赖 adapter 的 reconcile/idempotency 契约，不能把“未追加 STEP”解释成“现实未改变”。
