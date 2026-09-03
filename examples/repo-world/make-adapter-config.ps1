param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,
  [string]$OutputPath = (Join-Path (Get-Location) 'repo-adapter.json'),
  [string]$ReadPath = 'README.md',
  [string]$TestPath = 'test/agent/model-advisor.test.mjs'
)

$nodePath = (& node -p "process.execPath" | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($nodePath)) {
  throw 'Could not resolve the absolute node executable path.'
}

$repo = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path
$adapterPath = (Resolve-Path (Join-Path $PSScriptRoot 'adapter.mjs')).Path
$config = [ordered]@{
  executable = $nodePath
  args = @($adapterPath, $repo, $ReadPath, $TestPath)
  adapterId = 'repo-readonly-example-v1'
  worldId = 'repo'
  timeoutMs = 30000
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$json = $config | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutput, $json, $utf8NoBom)
Write-Output $resolvedOutput
