[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0)][ValidateSet('setup','doctor','engine','inspect','compare','register','verify-native','package-vts','smoke','help')][string]$Command='help',
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
)
. (Join-Path $PSScriptRoot 'common.ps1')
if ($Command -eq 'help' -or $Arguments -contains '--help' -and $Command -eq 'setup') {
    Write-Output @'
VTuberTailor
  setup [-NodePath <node.exe>] [-NpmCliPath <npm/bin/npm-cli.js>] [-PythonPath <python.exe>] [-JavaPath <java.exe>] [-WithExporter]
  doctor [--forbid-root <retired-folder>] [--json]
  engine <PuppetLoom CLI command and arguments>
  register <assets register arguments>
  inspect <image> [inspect_rgba.py arguments]
  compare <source> <candidate> --out <new-dir> [compare_overlay.py arguments]
  verify-native --project <dir> --export <dir> --core <Core.dll> [--output <new-dir>]
  package-vts --export <dir> --output <new-dir> --name <name> [--preset <model.vtube.json>]
  smoke [--output <new-dir>]
Only engine executes in vendor/puppetloom. Use absolute paths for project/input/output arguments.
'@
    exit 0
}
if ($Command -eq 'setup') {
    # Invoke via a new PowerShell parser so named setup arguments keep their meaning.
    & (Get-Process -Id $PID).Path -NoLogo -NoProfile -File (Join-Path $PSScriptRoot 'setup.ps1') @Arguments
    exit $LASTEXITCODE
}
$node = Get-TailorNode
Set-TailorEnvironment -Node $node
switch ($Command) {
    'engine' { Invoke-TailorEngine -Node $node -EngineArguments $Arguments; exit $script:TailorExit }
    'register' { Invoke-TailorEngine -Node $node -EngineArguments (@('assets','register') + $Arguments); exit $script:TailorExit }
    'inspect' { & (Get-TailorPython) (Join-Path $PSScriptRoot 'inspect_rgba.py') @Arguments; exit $LASTEXITCODE }
    'compare' { & (Get-TailorPython) (Join-Path $PSScriptRoot 'compare_overlay.py') @Arguments; exit $LASTEXITCODE }
    'doctor' { & $node (Join-Path $PSScriptRoot 'doctor.mjs') @Arguments; exit $LASTEXITCODE }
    'verify-native' { & $node (Join-Path $PSScriptRoot 'verify_native.mjs') @Arguments; exit $LASTEXITCODE }
    'package-vts' { & $node (Join-Path $PSScriptRoot 'package_vts.mjs') @Arguments; exit $LASTEXITCODE }
    'smoke' { & $node (Join-Path $PSScriptRoot 'smoke.mjs') @Arguments; exit $LASTEXITCODE }
}
