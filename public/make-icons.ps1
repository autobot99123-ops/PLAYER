# Generates the PWA icon sizes from a single source image.
# Usage:  put your image at  <project>\icon-source.png  then run:  .\make-icons.ps1
# Adjust $Source if your file has a different name.

param(
  [string]$Source = 'icon-source.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here $Source

if (-not (Test-Path -LiteralPath $src)) {
  Write-Host ""
  Write-Host "  Put your picture here first:  $src" -ForegroundColor Yellow
  Write-Host "  (any png/jpg, square or not - it will be centre cropped)" -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

# centre-crop to a square, then resize
$img = [System.Drawing.Image]::FromFile($src)
try {
  $side = [Math]::Min($img.Width, $img.Height)
  $x = [int](($img.Width - $side) / 2)
  $y = [int](($img.Height - $side) / 2)

  function Save-Icon([int]$size, [string]$name, [int]$insetPercent = 0) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Black)

        # maskable icons need a safe margin so the OS can crop them
        $pad = [int]($size * ($insetPercent / 100.0))
        $draw = $size - (2 * $pad)
        $g.DrawImage($img,
          (New-Object System.Drawing.Rectangle($pad, $pad, $draw, $draw)),
          (New-Object System.Drawing.Rectangle($x, $y, $side, $side)),
          [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $g.Dispose() }

      $out = Join-Path $here $name
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Host ("  wrote {0,-26} {1}x{1}" -f $name, $size) -ForegroundColor Green
    } finally { $bmp.Dispose() }
  }

  Save-Icon 512 'icon-512.png' 0
  Save-Icon 192 'icon-192.png' 0
  Save-Icon 512 'icon-maskable-512.png' 18
  Save-Icon 64  'favicon.png' 0

  # the one the page header shows
  Copy-Item -LiteralPath (Join-Path $here 'icon-512.png') -Destination (Join-Path $here 'icon.png') -Force
  Write-Host "  wrote icon.png" -ForegroundColor Green
}
finally {
  $img.Dispose()
}

Write-Host ""
Write-Host "  Done. Reload the player to see the new logo." -ForegroundColor Cyan
Write-Host ""