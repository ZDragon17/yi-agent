param(
  [string]$RootPath = (Join-Path (Get-Location) 'counter-run')
)

$root = [System.IO.Path]::GetFullPath($RootPath)
if (Test-Path -LiteralPath $root) {
  throw "Refusing to overwrite an existing example directory: $root"
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
$adapterConfig = Join-Path $root 'counter-adapter.json'
$lab = Join-Path $root 'lab'
$configScript = Join-Path $PSScriptRoot 'make-adapter-config.ps1'
$cli = Join-Path $PSScriptRoot '..\..\bin\yi-agent.mjs'

& powershell -NoProfile -ExecutionPolicy Bypass -File $configScript -OutputPath $adapterConfig | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Adapter config generation failed: $LASTEXITCODE" }

function Invoke-YiAgent {
  param([string[]]$Arguments)

  $raw = & node $cli @Arguments | Out-String
  if ($LASTEXITCODE -ne 0) { throw "yi-agent failed with exit code $LASTEXITCODE`n$raw" }
  return $raw | ConvertFrom-Json
}

$init = Invoke-YiAgent @('init', '--lab', $lab, '--world', 'counter', '--seed', 'counter-seed', '--adapter', $adapterConfig, '--json')
$run = Invoke-YiAgent @('run', '--lab', $lab, '--steps', '3', '--scenario', 'steady', '--adapter', $adapterConfig, '--json')
$inspect = Invoke-YiAgent @('inspect', '--lab', $lab, '--adapter', $adapterConfig, '--json')
$replay = Invoke-YiAgent @('replay', '--lab', $lab, '--run', $run.data.runId, '--adapter', $adapterConfig, '--json')

[ordered]@{
  lab = $lab
  world = $init.data.worldId
  runId = $run.data.runId
  status = $run.data.status
  steps = $run.data.steps
  inspectedWorld = $inspect.data.manifest.worldId
  replayVerdict = $replay.data.verdict
} | ConvertTo-Json -Compress
