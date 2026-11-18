[CmdletBinding(PositionalBinding = $false)]
param(
    [switch] $NoInfra,
    [switch] $NoOpen
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error 'Node.js 24 is required.'; exit 1 }
$major = & node -p "process.versions.node.split('.')[0]" 2>$null
if ($LASTEXITCODE -ne 0 -or $major -ne '24') { Write-Error 'Node.js 24 is required.'; exit 1 }
if (-not (Test-Path (Join-Path $root 'backend/node_modules/tsx'))) { Write-Error 'Backend dependencies are required.'; exit 1 }
if (-not (Test-Path (Join-Path $root 'frontend/node_modules/vite/bin/vite.js'))) { Write-Error 'Frontend dependencies are required.'; exit 1 }
$settingsPath = Join-Path $root 'intelifluxo.local.json'
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    $allowed = @('DATABASE_URL','AMQP_URL','AUTOMATION_SNAPSHOTS_ENABLED','CONDITIONS_WRITES_ENABLED','VIACEP_WRITES_ENABLED','VIACEP_EXTERNAL_EXECUTION_ENABLED','noInfra','containers')
    foreach ($property in $settings.PSObject.Properties) {
        if ($property.Name -notin $allowed) { throw "Unknown local setting: $($property.Name)" }
        if ($property.Name -in @('noInfra','containers')) { continue }
        if ($property.Value -isnot [string]) { throw "Local settings must use string values: $($property.Name)" }
        if (-not [Environment]::GetEnvironmentVariable($property.Name, 'Process')) {
            [Environment]::SetEnvironmentVariable($property.Name, $property.Value, 'Process')
        }
    }
    if ($null -ne $settings.noInfra -and $settings.noInfra -isnot [bool]) { throw 'noInfra must be boolean.' }
    if ($settings.noInfra) { $NoInfra = $true }
    if ($settings.containers) {
        foreach ($container in $settings.containers) {
            if ($container -isnot [string] -or $container -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$') { throw 'Invalid local container name.' }
        }
        function Test-LocalDocker {
            $ErrorActionPreference = 'Continue'
            & docker info *> $null
            return ($LASTEXITCODE -eq 0)
        }
        if (-not (Test-LocalDocker)) {
            & docker desktop start
            if ($LASTEXITCODE -ne 0) { throw 'Open Docker Desktop and try again.' }
        }
        $dockerReady = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Test-LocalDocker) { $dockerReady = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $dockerReady) { throw 'Docker did not become ready.' }
        & docker start @($settings.containers)
        if ($LASTEXITCODE -ne 0) { throw 'Local containers could not start. Check whether Windows reserved their ports.' }
    }
}
Push-Location (Join-Path $root 'backend')
$nodeArgs = @('--import', 'tsx', (Join-Path $root 'backend/src/runtime-supervisor-main.ts'))
if ($NoInfra) { $nodeArgs += '--no-infra' }
if ($NoOpen) { $nodeArgs += '--no-open' }
try { & node @nodeArgs; exit $LASTEXITCODE } finally { Pop-Location }
