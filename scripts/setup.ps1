[CmdletBinding()]
param(
    [string]$NodePath,
    [string]$NpmCliPath,
    [string]$PythonPath,
    [string]$JavaPath,
    [switch]$WithExporter,
    [switch]$ForceInstall
)
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Get-TailorNode -ExplicitPath $NodePath
$runtime = Join-Path $script:TailorRoot '.runtime'
$ownedNode = Join-Path $runtime 'node/node.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $ownedNode) -Force | Out-Null
if ($node -ne $ownedNode) { Copy-Item -LiteralPath $node -Destination $ownedNode -Force }
$node = $ownedNode
if (-not $NpmCliPath) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) { $NpmCliPath = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules/npm/bin/npm-cli.js' }
}
$ownedNpm = Join-Path $runtime 'node/node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $ownedNpm)) {
    if (-not $NpmCliPath -or -not (Test-Path -LiteralPath $NpmCliPath)) { throw 'npm CLI is missing. Pass -NpmCliPath <npm/bin/npm-cli.js>.' }
    $npmSource = Split-Path -Parent (Split-Path -Parent (Resolve-Path -LiteralPath $NpmCliPath).Path)
    New-Item -ItemType Directory -Path (Join-Path $runtime 'node/node_modules') -Force | Out-Null
    Copy-Item -LiteralPath $npmSource -Destination (Join-Path $runtime 'node/node_modules/npm') -Recurse
}
[IO.File]::WriteAllText((Join-Path $runtime 'node/npm.cmd'), '@"%~dp0node.exe" "%~dp0node_modules\npm\bin\npm-cli.js" %*' + "`r`n", [Text.UTF8Encoding]::new($false))
Set-TailorEnvironment -Node $node
$statePath = Join-Path $runtime 'setup-state.json'
$lockHash = (Get-FileHash -LiteralPath (Join-Path $script:EngineRoot 'package-lock.json')).Hash
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$needInstall = $ForceInstall -or -not $state -or $state.packageLockSha256 -ne $lockHash -or -not (Test-Path -LiteralPath (Join-Path $script:EngineRoot 'node_modules/.package-lock.json'))
Push-Location $script:EngineRoot
try {
    if ($needInstall) {
        & $node $ownedNpm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & $node $ownedNpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Engine build failed.' }
} finally { Pop-Location }

$python = Join-Path $runtime 'python/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    if (-not $PythonPath) { $PythonPath = (Get-Command python.exe -ErrorAction Stop).Source }
    & $PythonPath -m venv (Join-Path $runtime 'python')
    if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed.' }
}
$requirements = Join-Path $script:TailorRoot 'requirements-lock.txt'
if (-not (Test-Path -LiteralPath $requirements)) { $requirements = Join-Path $script:TailorRoot 'requirements.txt' }
& $python -m pip install --disable-pip-version-check --no-input -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Python QA dependencies failed.' }

if ($WithExporter) {
    $exportArguments = @((Join-Path $script:EngineRoot 'scripts/setup-cubism-exporter.mjs'), '--cache', (Join-Path $runtime 'exporter-cache'), '--compiler', (Join-Path $runtime 'exporter-cache/kotlin-compiler-embeddable-2.2.20.jar'))
    if ($JavaPath) { $exportArguments += @('--java', $JavaPath) }
    $libs = Join-Path $runtime 'exporter-libs'
    if (Test-Path -LiteralPath $libs) { $exportArguments += @('--libs', $libs) }
    Push-Location $script:EngineRoot
    try {
        & $node @exportArguments
        if ($LASTEXITCODE -ne 0) { throw 'Native exporter setup failed.' }
    } finally { Pop-Location }
}
$snapshot = [ordered]@{ version = 1; packageLockSha256 = $lockHash; nodeVersion = (& $node -p 'process.versions.node'); python = 'python/Scripts/python.exe'; exporterConfigured = (Test-Path -LiteralPath (Join-Path $script:EngineRoot 'runtime/cubism-exporter/config.json')); updatedAt = [DateTime]::UtcNow.ToString('o') }
[IO.File]::WriteAllText($statePath, ($snapshot | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output 'VTuberTailor setup complete. Run: ./scripts/tailor.ps1 doctor --json'
