param(
  [string]$OutputPath = (Join-Path (Get-Location) 'counter-adapter.json')
)

$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = (& node -p "process.execPath" | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($nodePath)) {
  throw 'Could not resolve the absolute node executable path.'
}

$adapterPath = (Resolve-Path (Join-Path $PSScriptRoot 'adapter.mjs')).Path
$config = [ordered]@{
  executable = $nodePath
  args = @($adapterPath)
  adapterId = 'counter-example-v1'
  worldId = 'counter'
  timeoutMs = 5000
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$json = $config | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutput, $json, $utf8NoBom)
Write-Output $resolvedOutput
