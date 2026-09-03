param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath,
  [string]$OutputPath = (Join-Path (Get-Location) 'repo-adapter.json'),
  [string]$ReadPath = 'README.md',
  [string]$TestPath = 'test/agent/model-advisor.test.mjs',
  [string]$PatchSpecPath = '',
  [string]$NonceJournalPath = ''
)

$nodePath = (& node -p "process.execPath" | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($nodePath)) {
  throw 'Could not resolve the absolute node executable path.'
}

$repo = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path
$adapterPath = (Resolve-Path (Join-Path $PSScriptRoot 'adapter.mjs')).Path
$adapterArgs = @($adapterPath, $repo, $ReadPath, $TestPath)
$adapterId = 'repo-readonly-example-v1'
if (-not [string]::IsNullOrWhiteSpace($PatchSpecPath) -or -not [string]::IsNullOrWhiteSpace($NonceJournalPath)) {
  if ([string]::IsNullOrWhiteSpace($PatchSpecPath) -or [string]::IsNullOrWhiteSpace($NonceJournalPath)) {
    throw 'PatchSpecPath and NonceJournalPath must be supplied together.'
  }
  $patchSpec = (Resolve-Path -LiteralPath $PatchSpecPath -ErrorAction Stop).Path
  $nonceJournal = [System.IO.Path]::GetFullPath($NonceJournalPath)
  $adapterArgs += @($patchSpec, $nonceJournal)
  $adapterId = 'repo-writable-example-v1'
}
$config = [ordered]@{
  executable = $nodePath
  args = $adapterArgs
  adapterId = $adapterId
  worldId = 'repo'
  timeoutMs = 30000
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$json = $config | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutput, $json, $utf8NoBom)
Write-Output $resolvedOutput
