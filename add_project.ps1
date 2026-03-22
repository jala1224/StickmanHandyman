# PowerShell script to add projects from folders in projects_input with automatic image compression and HEIC conversion

# Load .NET assembly for image processing
Add-Type -AssemblyName System.Drawing

# Check if ImageMagick is installed
function Test-ImageMagick {
    $magickPath = "C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\magick.exe"
    if (Test-Path $magickPath) {
        return $magickPath
    }
    
    # Try to find it in PATH
    try {
        $magick = Get-Command magick -ErrorAction Stop
        return $magick.Source
    }
    catch {
        Write-Host "ImageMagick not found. Please install it from: https://imagemagick.org/script/download.php"
        Write-Host "Make sure it's installed in the default location: C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\"
        return $null
    }
}

# Function to convert HEIC to JPG
function Convert-HeicToJpg {
    param(
        [string]$HeicPath,
        [string]$OutputPath,
        [string]$MagickPath
    )
    
    try {
        & $MagickPath convert "$HeicPath" "$OutputPath"
        Write-Host "Converted: $(Split-Path $HeicPath -Leaf) → $(Split-Path $OutputPath -Leaf)"
        return $true
    }
    catch {
        Write-Host "Error converting HEIC file: $_"
        return $false
    }
}

# Function to compress and resize image
function Compress-Image {
    param(
        [string]$ImagePath,
        [string]$OutputPath,
        [int]$Quality = 80,
        [int]$MaxWidth = 1200
    )
    
    try {
        $image = [System.Drawing.Image]::FromFile($ImagePath)
        
        # Resize if too wide
        if ($image.Width -gt $MaxWidth) {
            $newHeight = [int]($image.Height * ($MaxWidth / $image.Width))
            $resizedImage = New-Object System.Drawing.Bitmap($MaxWidth, $newHeight)
            $graphics = [System.Drawing.Graphics]::FromImage($resizedImage)
            $graphics.DrawImage($image, 0, 0, $MaxWidth, $newHeight)
            $graphics.Dispose()
            $image.Dispose()
            $image = $resizedImage
        }
        
        # Set compression quality for JPG
        $encoderParameter = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $Quality)
        $encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encoderParameters.Param[0] = $encoderParameter
        
        $jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        
        if ($OutputPath.ToLower().EndsWith('.jpg') -or $OutputPath.ToLower().EndsWith('.jpeg')) {
            $image.Save($OutputPath, $jpgCodec, $encoderParameters)
        } else {
            $image.Save($OutputPath)
        }
        
        $image.Dispose()
        Write-Host "Compressed: $(Split-Path $OutputPath -Leaf)"
    }
    catch {
        Write-Host "Error compressing image: $_"
        Copy-Item $ImagePath $OutputPath -Force
    }
}

# Function to crop image to fixed size (center crop)
function Crop-Image {
    param(
        [string]$ImagePath,
        [string]$OutputPath,
        [int]$CropWidth = 320,
        [int]$CropHeight = 220
    )
    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($ImagePath)

    # Calculate scale factor to cover preview size (no whitespace)
    $scale = [Math]::Max($CropWidth / $image.Width, $CropHeight / $image.Height)
    $newWidth = [int]($image.Width * $scale)
    $newHeight = [int]($image.Height * $scale)

    # Resize image
    $bitmap = New-Object System.Drawing.Bitmap($newWidth, $newHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($image, 0, 0, $newWidth, $newHeight)
    $image.Dispose()

    # Center crop to exact size
    $x = [int](($newWidth - $CropWidth) / 2)
    $y = [int](($newHeight - $CropHeight) / 2)
    $rect = New-Object System.Drawing.Rectangle($x, $y, $CropWidth, $CropHeight)
    $cropped = $bitmap.Clone($rect, $bitmap.PixelFormat)
    $cropped.Save($OutputPath)
    $bitmap.Dispose()
    $cropped.Dispose()
    $graphics.Dispose()
    Write-Host "Cropped preview: $(Split-Path $OutputPath -Leaf)"
}

# Check for ImageMagick
$magickPath = Test-ImageMagick
if (!$magickPath) {
    exit
}

# Read the current projects.json
$jsonPath = "projects.json"
if (Test-Path $jsonPath) {
    $projects = Get-Content $jsonPath | ConvertFrom-Json
} else {
    $projects = @()
}

$inputDir = "projects_input"
if (!(Test-Path $inputDir)) {
    Write-Host "projects_input folder not found. Please create it and add project folders inside."
    exit
}

$projectFolders = Get-ChildItem $inputDir -Directory
if ($projectFolders.Count -eq 0) {
    Write-Host "No project folders found in projects_input."
    exit
}

foreach ($folder in $projectFolders) {
    $projectName = $folder.Name
    $descriptionFile = Join-Path $folder.FullName "description.txt"
    if (Test-Path $descriptionFile) {
        $description = Get-Content $descriptionFile -Raw
    } else {
        $description = "Project description"
    }

    # Get all image files including HEIC
    $imageFiles = Get-ChildItem $folder.FullName -File | Where-Object { $_.Extension -in @('.jpg', '.jpeg', '.png', '.gif', '.heic') }
    $images = @()

    foreach ($image in $imageFiles) {
        # Convert HEIC to JPG first
        if ($image.Extension -eq '.heic') {
            $jpgName = "$projectName`_$($images.Count + 1).jpg"
            $jpgPath = Join-Path "images" $jpgName
            
            if (Convert-HeicToJpg -HeicPath $image.FullName -OutputPath $jpgPath -MagickPath $magickPath) {
                $images += $jpgName
            }
        } else {
            $newName = "$projectName`_$($images.Count + 1)$($image.Extension)"
            $destPath = Join-Path "images" $newName
            
            # Compress image before saving (quality 90 for sharp images)
            Compress-Image -ImagePath $image.FullName -OutputPath $destPath -Quality 75 -MaxWidth 1600
            $images += $newName
        }
    }

    if ($images.Count -gt 0) {
        # Create preview image from first image
        $previewName = "$projectName`_preview.jpg"
        $previewPath = Join-Path "images" $previewName
        Crop-Image -ImagePath (Join-Path "images" $images[0]) -OutputPath $previewPath -CropWidth 320 -CropHeight 220

        $newProject = @{
            name = $projectName
            description = $description.Trim()
            images = $images
            preview = $previewName
        }
        $projects += $newProject
        Write-Host "Added project: $projectName with $($images.Count) image(s)"
    } else {
        Write-Host "No images found for project: $projectName"
    }
}

# Write back to JSON
$projects | ConvertTo-Json | Set-Content $jsonPath

Write-Host "All projects processed, converted, compressed, and added to projects.json!"