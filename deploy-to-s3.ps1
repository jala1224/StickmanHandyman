param(
    [Parameter(Mandatory = $true)]
    [string]$BucketName,

    [string]$DistributionId,

    [switch]$BuildProjects,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $repoRoot

try {
    if ($BuildProjects) {
        $addProjectScript = Join-Path $repoRoot 'add_project.ps1'
        if (-not (Test-Path $addProjectScript)) {
            throw 'add_project.ps1 was not found.'
        }

        Write-Host 'Generating new project assets from projects_input...'
        & $addProjectScript

        if ($LASTEXITCODE -ne 0) {
            throw 'add_project.ps1 failed.'
        }
    }

    $requiredPaths = @(
        'home.html',
        'gallery.html',
        'contact.html',
        'nav.html',
        'footer.html',
        'styles.css',
        'load-components.js',
        'projects.json',
        'images'
    )

    $missingPaths = $requiredPaths | Where-Object { -not (Test-Path $_) }
    if ($missingPaths.Count -gt 0) {
        throw ("Missing required deploy paths: {0}" -f ($missingPaths -join ', '))
    }

    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
        throw 'AWS CLI is not installed or not available on PATH.'
    }

    $includeArgs = @(
        '--exclude', '*',
        '--include', 'home.html',
        '--include', 'gallery.html',
        '--include', 'contact.html',
        '--include', 'nav.html',
        '--include', 'footer.html',
        '--include', 'styles.css',
        '--include', 'load-components.js',
        '--include', 'projects.json',
        '--include', 'images/*',
        '--include', 'images/icons/*'
    )

    $syncArgs = @(
        's3', 'sync', '.', "s3://$BucketName",
        '--delete'
    ) + $includeArgs

    if ($DryRun) {
        $syncArgs += '--dryrun'
    }

    Write-Host 'Syncing deployable site files to S3...'
    & aws @syncArgs

    if ($LASTEXITCODE -ne 0) {
        throw 'aws s3 sync failed.'
    }

    if ($DistributionId) {
        Write-Host 'Creating CloudFront invalidation...'
        & aws cloudfront create-invalidation --distribution-id $DistributionId --paths '/*'

        if ($LASTEXITCODE -ne 0) {
            throw 'CloudFront invalidation failed.'
        }
    }

    Write-Host 'Deployment completed successfully.'
}
finally {
    Pop-Location
}