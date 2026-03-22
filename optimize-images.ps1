# Recompress all existing gallery images to web-optimised sizes.
# Safe to run multiple times. Skips preview images (already small).
# After running, redeploy with: .\deploy-to-s3.ps1 -BucketName "stickmanhandyman-site-prod" -DistributionId "YOUR_DISTRIBUTION_ID"

param(
    [int]$Quality = 75,
    [int]$MaxWidth = 1600
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$imagesDir = Join-Path $PSScriptRoot 'images'
$jpgFiles = Get-ChildItem $imagesDir -Filter '*.jpg' | Where-Object { $_.Name -notlike '*_preview.jpg' }

$totalBefore = ($jpgFiles | Measure-Object Length -Sum).Sum
$count = 0

foreach ($file in $jpgFiles) {
    $image = [System.Drawing.Image]::FromFile($file.FullName)

    if ($image.Width -gt $MaxWidth) {
        $newHeight = [int]($image.Height * ($MaxWidth / $image.Width))
        $resized = New-Object System.Drawing.Bitmap($MaxWidth, $newHeight)
        $g = [System.Drawing.Graphics]::FromImage($resized)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($image, 0, 0, $MaxWidth, $newHeight)
        $g.Dispose()
        $image.Dispose()
        $image = $resized
    }

    $encoderParam = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $encoderParams.Param[0] = $encoderParam
    $jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' }

    # Write to temp then replace so we never corrupt the original on failure
    $tmp = $file.FullName + '.tmp'
    $image.Save($tmp, $jpgCodec, $encoderParams)
    $image.Dispose()

    Move-Item $tmp $file.FullName -Force
    $count++
    Write-Host "Optimised $($file.Name) -> $([math]::Round((Get-Item $file.FullName).Length / 1KB, 1)) KB"
}

$totalAfter = (Get-ChildItem $imagesDir -Filter '*.jpg' |
    Where-Object { $_.Name -notlike '*_preview.jpg' } |
    Measure-Object Length -Sum).Sum

$savedMB = [math]::Round(($totalBefore - $totalAfter) / 1MB, 1)
$beforeMB = [math]::Round($totalBefore / 1MB, 1)
$afterMB  = [math]::Round($totalAfter  / 1MB, 1)

Write-Host ""
Write-Host "Done. $count images optimised."
Write-Host "Total size: $beforeMB MB -> $afterMB MB (saved $savedMB MB)"
Write-Host ""
Write-Host "Run the deploy script to push the smaller images to S3:"
Write-Host '  .\deploy-to-s3.ps1 -BucketName "stickmanhandyman-site-prod" -DistributionId "YOUR_DISTRIBUTION_ID"'