param(
  [string]$OutputPath = (Join-Path (Get-Location) 'counter-wsl-adapter.json'),
  [string]$Distribution = 'Ubuntu'
)

$wslCommand = Get-Command wsl -ErrorAction Stop
$wslPath = $wslCommand.Source
$adapterPath = (Resolve-Path (Join-Path $PSScriptRoot 'adapter.py')).Path
if ($adapterPath.Length -lt 3 -or $adapterPath[1] -ne ':') {
  throw "The WSL example requires a Windows drive-letter path: $adapterPath"
}
$drive = $adapterPath.Substring(0, 1).ToLowerInvariant()
$wslAdapterPath = "/mnt/$drive$($adapterPath.Substring(2).Replace('\', '/'))"
$config = [ordered]@{
  executable = $wslPath
  args = @('-d', $Distribution, '--', 'python3', $wslAdapterPath)
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
