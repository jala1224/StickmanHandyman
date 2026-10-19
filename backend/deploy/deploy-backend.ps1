param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9.-]+$')]
    [string]$HostName,

    [Parameter(Mandatory = $true)]
    [string]$KeyPath,

    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$UserName = 'ubuntu',

    [ValidatePattern('^/[a-zA-Z0-9/_.-]+$')]
    [string]$ApplicationDirectory = '/opt/stickman-handyman-website',

    [ValidatePattern('^[a-zA-Z0-9_.-]+\.service$')]
    [string]$ServiceName = 'stickman-handyman.service',

    [ValidateRange(1, 65535)]
    [int]$Port = 3000,

    [string]$HealthUrl = 'https://api.stickman-handyman.com/health',

    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$paths = @('backend/src', 'backend/db', 'backend/package.json', 'backend/package-lock.json', 'fonts', 'invoice_template')
foreach ($path in $paths) {
    if (-not (Test-Path (Join-Path $projectRoot $path))) {
        throw "Required release path missing: $path"
    }
}

Write-Output "Backend target: ${UserName}@${HostName}:$ApplicationDirectory ($ServiceName)"
Write-Output ('Release contents: ' + ($paths -join ', '))
Write-Output 'Excluded: .env, backend/data, generated invoices, local node_modules, and frontend files.'
if (-not $Apply) {
    Write-Output 'DRY RUN: no connection or production changes. Use -Apply to validate and release.'
    return
}

foreach ($tool in @('node', 'npm', 'ssh', 'scp', 'tar')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $tool"
    }
}
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw 'SSH identity file not found.'
}

$releaseId = [guid]::NewGuid().ToString('N')
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "stickman-release-$releaseId"
$remoteArchive = "/tmp/stickman-release-$releaseId.tar.gz"
$destination = "${UserName}@${HostName}"
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15')
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
Push-Location $projectRoot
try {
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw 'Local verification failed; no release uploaded.' }

    $identity = Join-Path $temporaryDirectory 'identity.pem'
    Copy-Item -LiteralPath $KeyPath -Destination $identity
    if ($env:OS -eq 'Windows_NT') {
        $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $identity /inheritance:r /grant:r ("{0}:(F)" -f $account) | Out-Null
    } else {
        & chmod 600 $identity
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict temporary identity permissions.' }

    $archive = Join-Path $temporaryDirectory 'release.tar.gz'
    & tar -czf $archive -- @paths
    if ($LASTEXITCODE -ne 0) { throw 'Release archive creation failed.' }
    & scp @sshOptions -i $identity $archive "${destination}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw 'Release upload failed.' }

    $remoteScript = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release.sh')).Replace("`r`n", "`n")
    $remoteCommand = "bash -s -- '$remoteArchive' '$ApplicationDirectory' '$ServiceName' '$Port'"
    $remoteScript | & ssh @sshOptions -i $identity $destination $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw 'Remote release failed; inspect rollback output before retrying.' }

    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 20
    if ($health.ok -ne $true) { throw 'Public API health check failed after the local host checks passed.' }
    Write-Output 'Backend release complete. Public API health passed; remote backups retained.'
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
}