# RTA-1：第一个真实仓库任务

`manifest.json` 是一个可重置的 Node.js 小仓库任务。初始实现把加法写成了减法，测试会先失败；Agent 需要通过发现、读取、测试、受控补丁和再次测试完成修复。

`baseline-6.json` 是阶段 2 的六任务基线。六个任务各自创建独立仓库，覆盖加法、乘法、奇偶判断、范围限制、布尔解析和平均值计算。它们共享同一执行边界，但不共享文件、Lab、记忆或补丁日志，因此适合先测 T0：每个任务都从空白上下文开始。

`long-run-12.json` 在这六项之后增加数组求和、字符串反转、元音统计、华氏转摄氏、最大值和严格正数判断。它用于阶段 3 的连续运行测试；对应 E2E 会在 3 个已提交任务边界强杀 benchmark，再用 `--resume` 接续到 12/12。

`--learning-profile t0`（默认）不向任务注入跨任务经验；`--learning-profile t1` 会在每个独立任务启动前读取上一个已完成 Lab 的账本，只提取 capability 工作流、测试次数和 Replay 结论，写入有界的 `experience.json`。它不共享仓库文件、补丁内容、目标答案或 Lab 状态。T1 的经验仍是模型可见的非权威 observation evidence，不能绕过 Kernel、WorldPort 或测试验收。

运行时可以使用符合 `yi-agent` 进程模型协议的模型适配器配置：

```powershell
yi-agent repo benchmark `
  --manifest $PWD\examples\rta-1\manifest.json `
  --output $PWD\rta-1-run `
  --model-adapter C:\bench\model-adapter.json `
  --json
```

也可以省略 `--model-adapter`，直接使用 `YI_AGENT_*` 环境变量配置的真实模型。

运行六任务基线：

```powershell
yi-agent repo benchmark `
  --manifest $PWD\examples\rta-1\baseline-6.json `
  --output $PWD\rta-1-baseline-001 `
  --json
```

运行十二任务长跑：

```powershell
yi-agent repo benchmark `
  --manifest $PWD\examples\rta-1\long-run-12.json `
  --output $PWD\rta-1-long-run-001 `
  --json
```

运行 T1 长跑并保留跨任务经验：

```powershell
yi-agent repo benchmark `
  --manifest $PWD\examples\rta-1\long-run-12.json `
  --output $PWD\rta-1-t1-001 `
  --learning-profile t1 `
  --json
```

输出目录包含隔离仓库、Lab、nonce 日志和 `report.json`；T1 还会生成 `experience.json`。删除输出目录即可重新从同一清单开始；运行中断后使用同样的参数追加 `--resume`，不能更换 learning profile。

当前可复现夹具结果：同一六任务清单下，T0 完成 1/6，T1 完成 6/6；T1 在十二任务清单下完成 12/12，完成项 Replay 均为 `CONSISTENT`。夹具模型会在没有经验时重复错误工作流，在看到前序账本后复用已验证工作流。这验证的是经验传递、隔离和验收契约，不代表真实模型在开放任务上的泛化能力。
