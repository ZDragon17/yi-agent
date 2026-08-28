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

## T-2 两个内置 WorldPort（覆盖 FR-2/5/7）

- 依赖：T-1
- Tester 改动：`test/worlds/**`；实现改动：`src/worlds/**`
- 实现：温控、虚拟桌面的纯 transition、白名单 AuthorityPolicy、规律突变/外部事件/执行失败注入。
- Tester 命令：`node scripts/test-gate.mjs test/worlds`
- Acceptance：虚拟桌面含 1 个 protected 项，所有 transition 后其位置不变；温控从 34.9℃请求升温时拒绝且原 state 不变；未知/越权 token、陈旧 stateVersion/policyVersion 均拒绝并 HALT；transition 调用前后输入对象不变。
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
- Acceptance：10000 步在当前机型 30 秒内；逐 STEP 含 Design §6 全部审计/因果字段且无真实文件内容、环境变量和敏感数据；manifest/current/start/end/事件的版本、大小、摘要、引用门均覆盖；符号链接或目录联接逃逸拒绝；源码无 shell 依赖。只声明 Windows 已验证。
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

- 实现：`EffectJournal` 以带 `prevDigest/digest` 的 JSONL 记录 EffectBroker 每次状态快照，并在 `handle.sync()` 完成后才返回；Broker 的 `EXECUTION_STARTED`、`COMPENSATION_STARTED` 必须先写入 journal，随后才可调用对应 executor。所有 Broker 变更串行化为异步操作，避免确认、执行、对账交错。
- 恢复：从 journal 重建 nonce→intent→phase；若最后状态为 `EXECUTING`，恢复为 `RECONCILE_REQUIRED`，禁止重复执行；已 `APPLIED/REJECTED/REVERSED` 的 nonce 再执行只返回原状态。
- 验收：哈希链篡改拒绝；应用后重开不重复调用 executor；执行不确定后重开只能 reconcile；`EXECUTION_STARTED` 落盘失败时 executor 调用次数为 0。
- 边界：journal 文件由上层单写者锁保护；本阶段还没有跨进程锁、真实 OS/设备 executor、沙箱或人工 UI。

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
- 验证：本地 HTTP 模拟服务覆盖 Bearer 认证、`/models`、`/chat/completions`、错误映射和缺失配置；`npm install --global E:\demo\yi-agent` 通过 npm dry-run 检查安装入口。
- 边界：当前不自动保存密钥、不调用真实供应商、不包含桌面 UI；真实供应商连通性由用户配置后在本机执行 `yi-agent api test`。

## F-6 模型提议与可重放 Agent CLI

- 实现：`agent run` 将模型限制为结构化 token 提议；Kernel 重新计算预期并独立校验 allowed/safe，WorldPort 负责执行，verify/learn 负责证据和成长。
- 证据：每个模型 STEP 记录有限的 `policyEvidence`，不保存原始回答；Replay 使用冻结提议重放，不重新访问 API。
- 验证：本地 HTTP 模拟服务完成 `init→agent run→policyEvidence→replay`，模型返回非法/unsafe token 时只能走显式 Kernel fallback，不能绕过安全边界。
- 边界：这仍是受控模型辅助闭环，不构成通用智能证明；真实供应商、真实 WorldPort 和真实副作用需要后续独立实验与人工闸门。
