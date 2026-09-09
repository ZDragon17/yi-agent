param(
  [string]$RootPath = (Join-Path (Get-Location) 'counter-wsl-run'),
  [string]$Distribution = 'Ubuntu'
)

$root = [System.IO.Path]::GetFullPath($RootPath)
if (Test-Path -LiteralPath $root) {
  throw "Refusing to overwrite an existing example directory: $root"
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
$adapterConfig = Join-Path $root 'counter-wsl-adapter.json'
$lab = Join-Path $root 'lab'
$configScript = Join-Path $PSScriptRoot 'make-wsl-adapter-config.ps1'
$cli = Join-Path $PSScriptRoot '..\..\bin\yi-agent.mjs'

& powershell -NoProfile -ExecutionPolicy Bypass -File $configScript -OutputPath $adapterConfig -Distribution $Distribution | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Adapter config generation failed: $LASTEXITCODE" }

function Invoke-YiAgent {
  param([string[]]$Arguments)

  $raw = & node $cli @Arguments | Out-String
  if ($LASTEXITCODE -ne 0) { throw "yi-agent failed with exit code $LASTEXITCODE`n$raw" }
  return $raw | ConvertFrom-Json
}

$preflight = Invoke-YiAgent @('adapter', 'test', '--adapter', $adapterConfig, '--json')
$init = Invoke-YiAgent @('init', '--lab', $lab, '--world', 'counter-python', '--seed', 'counter-wsl-seed', '--adapter', $adapterConfig, '--json')
$run = Invoke-YiAgent @('run', '--lab', $lab, '--steps', '3', '--scenario', 'steady', '--adapter', $adapterConfig, '--json')
$inspect = Invoke-YiAgent @('inspect', '--lab', $lab, '--adapter', $adapterConfig, '--json')
$replay = Invoke-YiAgent @('replay', '--lab', $lab, '--run', $run.data.runId, '--adapter', $adapterConfig, '--json')

[ordered]@{
  adapter = $preflight.data.adapter.adapterId
  transport = $preflight.data.adapter.transport
  lab = $lab
  world = $init.data.worldId
  runId = $run.data.runId
  status = $run.data.status
  steps = $run.data.steps
  inspectedWorld = $inspect.data.manifest.worldId
  replayVerdict = $replay.data.verdict
} | ConvertTo-Json -Compress
