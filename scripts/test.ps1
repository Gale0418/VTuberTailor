[CmdletBinding()]
param([switch]$Engine)
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Get-TailorNode
Set-TailorEnvironment -Node $node
Push-Location $script:TailorRoot
try {
    & (Get-TailorPython) -m unittest discover -s tests -p 'test_*.py' -v
    if ($LASTEXITCODE -ne 0) { throw 'Python helper tests failed.' }
    & $node --test 'tests/*.test.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Node helper tests failed.' }
    if ($Engine) {
        Push-Location $script:EngineRoot
        try {
            & $node (Join-Path $script:EngineRoot 'node_modules/vitest/vitest.mjs') run --config vitest.config.ts packages
            if ($LASTEXITCODE -ne 0) { throw 'Engine unit tests failed.' }
        } finally { Pop-Location }
    }
} finally { Pop-Location }
