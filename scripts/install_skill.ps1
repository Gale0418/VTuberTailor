[CmdletBinding()]
param([string]$Destination)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'SKILL.md'))) { throw 'Run from a complete VTuberTailor repository.' }
if (-not $Destination) {
    $codexBase = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $Destination = Join-Path $codexBase 'skills/vtuber-tailor'
}
$destinationFull = [IO.Path]::GetFullPath($Destination)
$repoFull = (Resolve-Path -LiteralPath $repoRoot).Path
$realRepo = (Get-Item -LiteralPath $repoFull -Force).ResolveLinkTarget($true)
if ($realRepo) { $repoFull = $realRepo.FullName }
if (Test-Path -LiteralPath $destinationFull) {
    $entry = Get-Item -LiteralPath $destinationFull -Force
    $resolved = $entry.ResolveLinkTarget($true)
    if ($resolved -and $resolved.FullName -eq $repoFull) {
        Write-Output "Already installed: $destinationFull -> $repoFull"
        exit 0
    }
    throw "Destination already exists and was not replaced: $destinationFull"
}
New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFull) -Force | Out-Null
New-Item -ItemType Junction -Path $destinationFull -Target $repoFull | Out-Null
Write-Output "Installed Skill: $destinationFull -> $repoFull"
