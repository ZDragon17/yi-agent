# 易闭环 Agent CLI

这是一个可在 Windows PowerShell 中运行的 CLI。当前最小 API 接口采用 OpenAI-compatible Chat Completions 协议，核心实验能力仍可通过原有 `init`、`run`、`inspect`、`replay` 等命令使用。

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

## 调用 API

```powershell
yi-agent api test --json
yi-agent ask --prompt "请用一句话解释什么是闭环" --json
Get-Content .\prompt.txt -Raw | yi-agent ask --prompt - --json
yi-agent ask --prompt-file E:\path\to\prompt.txt --json
```

`api test` 只报告连通状态和模型数量，不会输出 API Key。`ask` 的成功结果和失败结果都使用单行 JSON envelope，便于 PowerShell 或脚本继续处理。

当前 CLI 不会替你保存密钥，也不会自动调用真实供应商；真实连通性需要你在本机配置上述环境变量后执行 `yi-agent api test`。
