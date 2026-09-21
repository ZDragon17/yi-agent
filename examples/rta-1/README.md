# RTA-1：第一个真实仓库任务

`manifest.json` 是一个可重置的 Node.js 小仓库任务。初始实现把加法写成了减法，测试会先失败；Agent 需要通过发现、读取、测试、受控补丁和再次测试完成修复。

`baseline-6.json` 是阶段 2 的六任务基线。六个任务各自创建独立仓库，覆盖加法、乘法、奇偶判断、范围限制、布尔解析和平均值计算。它们共享同一执行边界，但不共享文件、Lab、记忆或补丁日志，因此适合先测 T0：每个任务都从空白上下文开始。

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

输出目录包含隔离仓库、Lab、nonce 日志和 `report.json`。删除输出目录即可重新从同一清单开始；运行中断后使用同样的参数追加 `--resume`。
