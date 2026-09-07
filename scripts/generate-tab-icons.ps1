Add-Type -AssemblyName System.Drawing

$assetDirectory = Join-Path $PSScriptRoot '..\miniprogram\assets'
$iconSize = 81

function New-TabIcon {
  param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][ValidateSet('inventory', 'mine')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$ColorHex
  )

  $bitmap = [System.Drawing.Bitmap]::new($iconSize, $iconSize)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $pen = [System.Drawing.Pen]::new(
    [System.Drawing.ColorTranslator]::FromHtml($ColorHex),
    3.4
  )

  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    if ($Kind -eq 'inventory') {
      $graphics.DrawRectangle($pen, 17, 17, 47, 48)
      $graphics.DrawLine($pen, 17, 34, 64, 34)
      $graphics.DrawLine($pen, 17, 50, 64, 50)
      $graphics.DrawLine($pen, 29, 24, 52, 24)
      $graphics.DrawLine($pen, 26, 42, 44, 42)
      $graphics.DrawLine($pen, 36, 58, 55, 58)
    } else {
      $graphics.DrawEllipse($pen, 31, 17, 20, 20)
      $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
      try {
        $path.StartFigure()
        $path.AddBezier(18, 68, 20, 50, 31, 45, 40, 45)
        $path.AddBezier(40, 45, 50, 45, 61, 50, 63, 68)
        $graphics.DrawPath($pen, $path)
      } finally {
        $path.Dispose()
      }
    }

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $pen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

New-TabIcon -OutputPath (Join-Path $assetDirectory 'tab-inventory.png') -Kind inventory -ColorHex '#84918B'
New-TabIcon -OutputPath (Join-Path $assetDirectory 'tab-inventory-active.png') -Kind inventory -ColorHex '#1F5D49'
New-TabIcon -OutputPath (Join-Path $assetDirectory 'tab-mine.png') -Kind mine -ColorHex '#84918B'
New-TabIcon -OutputPath (Join-Path $assetDirectory 'tab-mine-active.png') -Kind mine -ColorHex '#1F5D49'
