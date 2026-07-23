# Download the sidecar binaries (yt-dlp, ffmpeg, deno) for Windows x64.
# Places them in src-tauri/binaries/ with Tauri's <name>-<triple>.exe naming.
# Usage: pwsh scripts/fetch-binaries.ps1
$ErrorActionPreference = "Stop"

$triple = "x86_64-pc-windows-msvc"
$dir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dir = (Resolve-Path $dir).Path
Write-Host "Fetching sidecars for $triple -> $dir"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    Write-Host "* yt-dlp"
    Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
        -OutFile (Join-Path $dir "yt-dlp-$triple.exe")

    Write-Host "* ffmpeg"
    $ffZip = Join-Path $tmp "ffmpeg.zip"
    Invoke-WebRequest "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" `
        -OutFile $ffZip
    Expand-Archive $ffZip -DestinationPath (Join-Path $tmp "ff") -Force
    $ff = Get-ChildItem -Recurse (Join-Path $tmp "ff") -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $ff.FullName (Join-Path $dir "ffmpeg-$triple.exe") -Force

    Write-Host "* deno"
    $denoZip = Join-Path $tmp "deno.zip"
    Invoke-WebRequest "https://github.com/denoland/deno/releases/latest/download/deno-$triple.zip" `
        -OutFile $denoZip
    Expand-Archive $denoZip -DestinationPath (Join-Path $tmp "dn") -Force
    Copy-Item (Join-Path $tmp "dn\deno.exe") (Join-Path $dir "deno-$triple.exe") -Force

    Write-Host "Done."
    Get-ChildItem $dir -Filter "*-$triple.exe" | Select-Object Name, Length
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
