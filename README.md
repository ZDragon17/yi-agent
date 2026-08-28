# 易闭环 Agent CLI

这是一个可在 Windows PowerShell 中运行的、面向通用智能底座实验的 CLI。

它不是另一个“让大模型帮你改代码”的工具，而是尝试回答一个更底层的问题：

> 一个系统要怎样观察世界、提出行动、验证结果、积累经验，并在下一次行动中真正改变自己？

当前最小 API 接口采用 OpenAI-compatible Chat Completions 协议，核心实验能力仍可通过 `init`、`run`、`inspect`、`replay` 等命令使用。

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
- 模型提议层：通过 OpenAI-compatible API 提出候选 Token；
- 安全边界：模型不能绕过 Kernel 直接执行动作；
- 确定性 Replay：回放使用已记录的模型提议摘要，不重新请求模型；
- Effect Broker：对明确声明的副作用提供计划、确认、执行、对账和补偿流程；
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

共同点不是领域名称，而是它们都只通过同一组 `WorldPort` 方法接入：`initialState`、`observe`、`actions`、`transition`。如果新增世界必须修改 Kernel 才能工作，就说明底座仍然夹带了领域假设。

## 用一个外部世界验证通用性

仓库提供了一个不依赖 `src/**` 的最小外部世界示例：`examples/counter-world/adapter.mjs`。它只有一个世界状态 `value` 和一个行动 `counter.increment`，通过 `yi-world-cli` JSONL 协议接入。这个例子故意不认识 Kernel 的实现，只负责回答 `hello`、`initialState`、`actions`、`observe`、`externalInputs` 和 `transition` 请求。

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
Get-Content .\prompt.txt -Raw | yi-agent ask --prompt - --json
yi-agent ask --prompt-file E:\path\to\prompt.txt --json
```

`api test` 只报告连通状态和模型数量，不会输出 API Key。`ask` 的成功结果和失败结果都使用单行 JSON envelope，便于 PowerShell 或脚本继续处理。

`agent run` 会在每一步把当前观测和可用能力交给模型提出一个 token，再由 Kernel 独立计算预期、复核安全性、执行、验证和学习。模型不能直接执行动作；每一步只保存结构化提议摘要，`replay` 不会再次调用模型。

当前 CLI 不会替你保存密钥；真实连通性需要你在本机配置上述环境变量后执行 `yi-agent api test`。模型调用只负责提出候选 Token，仍由 WorldPort、Kernel、verify、learn 和 replay 闭环裁决。
