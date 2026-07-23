# Download the sidecar binaries (yt-dlp, ffmpeg, deno) for Windows x64.
# Places them in src-tauri/binaries/ with Tauri's <name>-<triple>.exe naming.
# Uses curl.exe + tar (both ship with Windows 10+/runners) for reliability.
# Usage: pwsh scripts/fetch-binaries.ps1
$ErrorActionPreference = "Stop"

$triple = "x86_64-pc-windows-msvc"
$dir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dir = (Resolve-Path $dir).Path
Write-Host "Fetching sidecars for $triple -> $dir"

$root = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tmp = Join-Path $root ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-File($url, $out) {
    curl.exe -fL --retry 3 --retry-all-errors -o $out $url
    if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
}

try {
    Write-Host "* yt-dlp"
    Get-File "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
        (Join-Path $dir "yt-dlp-$triple.exe")

    Write-Host "* ffmpeg"
    $ffZip = Join-Path $tmp "ffmpeg.zip"
    Get-File "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" $ffZip
    $ffDir = Join-Path $tmp "ff"
    New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
    tar -xf $ffZip -C $ffDir
    $ff = Get-ChildItem -Recurse $ffDir -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $ff) { throw "ffmpeg.exe not found in archive" }
    Copy-Item $ff.FullName (Join-Path $dir "ffmpeg-$triple.exe") -Force

    Write-Host "* deno"
    $denoZip = Join-Path $tmp "deno.zip"
    Get-File "https://github.com/denoland/deno/releases/latest/download/deno-$triple.zip" $denoZip
    $denoDir = Join-Path $tmp "dn"
    New-Item -ItemType Directory -Force -Path $denoDir | Out-Null
    tar -xf $denoZip -C $denoDir
    $deno = Get-ChildItem -Recurse $denoDir -Filter "deno.exe" | Select-Object -First 1
    if (-not $deno) { throw "deno.exe not found in archive" }
    Copy-Item $deno.FullName (Join-Path $dir "deno-$triple.exe") -Force

    Write-Host "Done."
    Get-ChildItem $dir -Filter "*-$triple.exe" | Select-Object Name, Length
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
