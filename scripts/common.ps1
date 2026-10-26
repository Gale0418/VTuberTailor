$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:TailorRoot = Split-Path -Parent $PSScriptRoot
$rootEntry = Get-Item -LiteralPath $script:TailorRoot -Force
$rootTarget = $rootEntry.ResolveLinkTarget($true)
if ($rootTarget) { $script:TailorRoot = $rootTarget.FullName }
$script:EngineRoot = Join-Path $script:TailorRoot 'vendor/puppetloom'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

function Get-TailorNode {
    param([string]$ExplicitPath)
    $candidates = @($ExplicitPath, $env:VTUBERTAILOR_NODE, (Join-Path $script:TailorRoot '.runtime/node/node.exe'))
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $candidates += $found.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $versionText = & $candidate -p 'process.versions.node'
            if ($LASTEXITCODE -ne 0) { continue }
            $version = [version]$versionText
            if (($version.Major -eq 24 -and $version -ge [version]'24.22.1') -or $version -ge [version]'26.12.1') {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }
    throw 'Node 24.22.1 (24.x) or >=26.12.1 is required. Run setup -NodePath <node.exe>.'
}

function Set-TailorEnvironment {
    param([string]$Node)
    $env:PATH = (Split-Path -Parent $Node) + [IO.Path]::PathSeparator + $env:PATH
    $env:VTUBERTAILOR_ENGINE_ROOT = $script:EngineRoot
    $env:PUPPETLOOM_ROOT = $script:EngineRoot
    $env:PUPPETLOOM_NODE = $Node
    $env:PUPPETLOOM_EXPORT_CACHE = Join-Path $script:TailorRoot '.runtime/exporter-cache'
    $env:VTUBERTAILOR_PWSH = (Get-Process -Id $PID).Path
    $env:PUPPETLOOM_TOOLS_ROOT = Join-Path $script:TailorRoot '.runtime/tools'
    $env:PUPPETLOOM_RUNTIME_ASSET_DIRECTORY = Join-Path $env:PUPPETLOOM_TOOLS_ROOT 'runtime-assets/mediapipe'
    $env:PUPPETLOOM_CONTROL_MANIFEST = Join-Path $env:PUPPETLOOM_TOOLS_ROOT 'user-data/runtime-control.json'
    $env:PUPPETLOOM_E2E_USER_DATA = Join-Path $env:PUPPETLOOM_TOOLS_ROOT 'user-data'
    $env:PUPPETLOOM_PERFORMANCE_ROOT = Join-Path $script:TailorRoot '.runtime/performance'
    $env:PUPPETLOOM_EVIDENCE_ROOT = Join-Path $script:TailorRoot '.runtime/evidence'
    if (-not $env:PUPPETLOOM_ARTIFACT_ROOT) {
        # The engine reserves 38 chars for a run id and 152 for artifact paths.
        # Pick a shorter root instead of increasing its 240-character guard.
        $artifactRoot = Join-Path $script:TailorRoot '.runtime/artifacts'
        if ($artifactRoot.Length -gt 50) { $artifactRoot = Join-Path ([IO.Path]::GetTempPath()) 'vtt' }
        if ($artifactRoot.Length -gt 50) { throw 'Set PUPPETLOOM_ARTIFACT_ROOT to a short writable path (at most 50 characters).' }
        $env:PUPPETLOOM_ARTIFACT_ROOT = $artifactRoot
    }
}

function Get-TailorPython {
    $path = Join-Path $script:TailorRoot '.runtime/python/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Python runtime is missing. Run setup first.' }
    return $path
}

function Invoke-TailorEngine {
    param([string]$Node, [string[]]$EngineArguments)
    Push-Location $script:EngineRoot
    try {
        & $Node (Join-Path $script:EngineRoot 'scripts/build-cli.mjs') --check > $null
        if ($LASTEXITCODE -ne 0) {
            $buildLines = & $Node (Join-Path $script:EngineRoot 'scripts/build-cli.mjs')
            $buildStatus = $LASTEXITCODE
            foreach ($line in $buildLines) { [Console]::Error.WriteLine($line) }
            if ($buildStatus -ne 0) { throw 'Engine build failed.' }
        }
        & $Node (Join-Path $script:EngineRoot 'apps/cli/dist/index.js') @EngineArguments
        $script:TailorExit = $LASTEXITCODE
    } finally { Pop-Location }
}
