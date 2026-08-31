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

- 纯 Kernel：数值观测、ValueSpec、不透明 Action Token、确定性随机状态；
- `WorldPort`：五个内置世界覆盖连续控制、受保护对象、多资源库存、离散网格和排队系统；
- 可插拔外部世界：通过受控 JSONL 子进程协议接入；
- 可审计运行时：事件账本、快照、锁、恢复和哈希链；
- 证据闭环：行动前预期、行动回执、复观、验证、学习；
- 变化监督器：用同一套目标距离、确认进步、停滞、重规划和停止判定约束不同世界；状态随 STEP、快照、终态和恢复账本连续保存，跨进程 CLI 可继续运行；
- 连续 Runner：`agent loop` 把有限 STEP 批次串成多个已提交 Run；每个边界都可独立 Replay，进程重启后从同一个 current 继续；每个子 Run 的 `loopId/runIndex/scenario/budget` 都写入 immutable start，使用 `--resume` 时从账本重建剩余预算，不重复已提交 Run；
- 进程级恢复回归：E2E 真实启动 CLI 子进程，在第二个模型请求挂起期间强制终止进程，显式回收死亡 owner 后继续下一 Run，验证 current 和 execution 链不回退；
- 跨 WorldPort 同构回归：独立外部 adapter 在坐标、状态表示和启动身份都不同的情况下，仍通过相同的应用闭环跨进程继续，并让两段 Run 的状态、记忆、监督器和 Replay 保持等价；另有文件持久化 adapter 覆盖多 Run 外部效果在响应丢失后的同 nonce 重试，验证外部效果只提交一次且 Replay 不触发副作用；
- 证据驱动策略变化：停滞不会只写一条日志，而会把领域无关的 `BALANCED/EXPLORATORY` 策略、版本和原因持久化；探索策略只使用动作样本数/不确定度重新排序安全候选；
- 模型提议层：通过 OpenAI-compatible API 提出候选 Token；
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

仓库提供了一个不依赖 `src/**` 的最小外部世界示例：`examples/counter-world/adapter.mjs`。它只有一个世界状态 `value` 和一个行动 `counter.increment`，通过 `yi-world-cli` JSONL 协议接入。这个例子故意不认识 Kernel 的实现，只负责回答 `hello`、`initialState`、`actions`、`observe`、`externalInputs` 和 `transition` 请求。若 adapter 连接真实副作用，必须额外实现持久 `executionNonce` 幂等记录；没有在 `hello` 声明 `supportsIdempotentTransitions:true` 的 adapter 发生响应丢失后会被宿主阻断续跑，等待人工对账。

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

## 当前明确不是什么

当前版本还不是通用自主智能，也不会自动操作真实桌面、任意 Shell 或用户文件。它没有证明“智能已经出现”，只提供一个可以持续做实验、记录证据、制造反例和检查回放一致性的底座。

模型越强，不会自动让这个系统越可靠。模型只是提议器；真正需要继续建设的是：

- 更丰富但仍然可验证的观测和行动契约；
- 更接近现实的外部干扰、延迟、失败和部分可观测环境；
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
yi-agent agent loop --lab E:\labs\temperature --resume --json
yi-agent agent run --lab E:\labs\temperature --steps 10 --goal-plan E:\plans\stability.json --json
yi-agent agent run --lab E:\labs\temperature --steps 10 --goal "自动维持温度" --auto-plan --json
Get-Content .\prompt.txt -Raw | yi-agent ask --prompt - --json
yi-agent ask --prompt-file E:\path\to\prompt.txt --json
```

`api test` 只报告连通状态和模型数量，不会输出 API Key。`ask` 的成功结果和失败结果都使用单行 JSON envelope，便于 PowerShell 或脚本继续处理。

`agent run` 会在每一步把当前观测和可用能力交给模型提出一个 token，再由 Kernel 独立计算预期、复核安全性、执行、验证和学习。模型不能直接执行动作；每一步只保存结构化提议摘要，`replay` 不会再次调用模型。

`agent loop` 是连续运行的 CLI 入口：`--steps` 表示每个可恢复 Run 的步数，`--runs` 表示最多串联多少个 Run；需要长期守护时使用 `--forever`，它与 `--runs` 互斥。每个 Run 都先完成自己的账本提交，再开始下一个 Run；收到 SIGINT/SIGTERM 时只在当前 Run 提交后停止，返回 `INTERRUPTED`。loop 的 `loopId/runIndex/scenario/budget` 会固化到每个 immutable `start.json`，进程重启并完成恢复卡点后，可以用 `yi-agent agent loop --lab PATH --resume --json` 从完整账本重建剩余 Run，不必重新输入也不会重复已提交 Run。同一 lab 中，一条未完成 continuation 对实验空间拥有唯一调度权；新的 loop 或普通 run 会被拒绝，必须先用 `--resume` 接续，已完成或已停止的历史 loop 不阻塞新实验。发生执行拒绝、无安全动作或显式目标达成时，循环会停止并返回原因。`--forever` 的内存结果摘要只保留最近一个 Run，累计 `runs/metrics` 持续统计，完整历史以 lab 账本和独立 Replay 为准，因此不会随运行时间积累结果对象。进程在一个 Run 内被终止或崩溃时，仍须先用 `recover --confirm-lock-owner-dead` 完成明确的恢复卡点，再使用 `--resume` 继续；若未决外部 transition 已保存原始策略证据，恢复进程暂时没有 API 时也能复用该证据并由 Kernel 继续安全选择；`test/e2e/crash-restart-cli.test.mjs` 已用真实子进程强制终止覆盖该路径。

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

Memory 现在同时保留三层证据：`actionModels` 记录 Token 的总体变化，`relationModels` 记录同一 Token 在观测相对当前目标的关系签名（每个维度为接近、相等或远离）下的变化，`rejectionModels` 记录同一 Token 在最近关系位置是否遭到执行拒绝。Kernel 优先使用关系条件模型，缺失时回退总体模型；拒绝反馈只在同一关系签名下暂时降权，关系改变或所有候选都被拒绝时仍允许重新验证。关系签名只由数值观测和 ValueSpec 计算，不读取领域名称。每个模型使用有界变化窗口，让近期已验证证据能够修正过时动力学，同时保留总样本数审计；旧账本没有关系字段时仍按旧模型 Replay，新实验会把关系模型和拒绝证据随 current/STEP 持久化。

复杂目标可以通过 `--goal-plan PATH` 提供阶段序列。每个阶段只声明不透明的阶段 ID、阶段目标文本和可选 `ValueSpec`；运行时仍用同一套观察向量、加权距离、证据和安全约束推进阶段，阶段完成后才切换到下一个阶段。计划会进入 supervisor/current/STEP，Replay 不会重新询问模型或读取计划文件；已激活的计划不能在同一个 lab 中被静默替换。

需要让模型提出阶段序列时，可使用 `--goal TEXT --auto-plan`。Planner 只能返回阶段目标向量，宿主会继承当前 WorldPort 的维度和权重并进行有限性、边界和阶段顺序校验；非法或不可用提议退回单一根目标阶段，不会改变权限、Token 或执行规则。首次激活时，已校验计划和 `planEvidence` 一起写入 STEP；之后的普通 Run、进程重启和 Replay 都使用账本中的计划，不重复请求 Planner。只有持久化的停滞策略触发未完成计划修订，且修订计划同样进入 STEP 并由 Replay 冻结重演。`--auto-plan` 与 `--goal-plan` 互斥。

当前 CLI 不会替你保存密钥；真实连通性需要你在本机配置上述环境变量后执行 `yi-agent api test`。模型调用只负责提出候选 Token，仍由 WorldPort、Kernel、verify、learn 和 replay 闭环裁决。
