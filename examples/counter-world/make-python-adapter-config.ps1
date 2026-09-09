param(
  [string]$OutputPath = (Join-Path (Get-Location) 'counter-python-adapter.json')
)

$pythonCommand = Get-Command python -ErrorAction Stop
$pythonPath = $pythonCommand.Source
$adapterPath = (Resolve-Path (Join-Path $PSScriptRoot 'adapter.py')).Path
$config = [ordered]@{
  executable = $pythonPath
  args = @($adapterPath)
  adapterId = 'counter-python-v1'
  worldId = 'counter-python'
  timeoutMs = 5000
  transport = 'persistent-jsonl'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$json = $config | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutput, $json, $utf8NoBom)
Write-Output $resolvedOutput
