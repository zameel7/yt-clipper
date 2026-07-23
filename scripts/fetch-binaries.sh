#!/usr/bin/env bash
# Download the sidecar binaries (yt-dlp, ffmpeg, deno) that ship inside the app.
# Places them in src-tauri/binaries/ with Tauri's <name>-<target-triple> naming.
# Handles macOS and Linux targets. For Windows use fetch-binaries.ps1.
# Usage: scripts/fetch-binaries.sh [target-triple]   (defaults to host triple)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../src-tauri/binaries" && pwd)"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
echo "Fetching sidecars for $TRIPLE -> $DIR"

case "$TRIPLE" in
  aarch64-apple-darwin) OS=macos; FF_ARCH=arm64; YTDLP=yt-dlp_macos ;;
  x86_64-apple-darwin)  OS=macos; FF_ARCH=amd64; YTDLP=yt-dlp_macos ;;
  x86_64-unknown-linux-gnu)  OS=linux; FF_ARCH=amd64; YTDLP=yt-dlp_linux ;;
  aarch64-unknown-linux-gnu) OS=linux; FF_ARCH=arm64; YTDLP=yt-dlp_linux_aarch64 ;;
  *)
    echo "Unsupported target: $TRIPLE (Windows uses fetch-binaries.ps1)."
    exit 1
    ;;
esac

cd "$DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "• yt-dlp"
curl -fL -o "yt-dlp-$TRIPLE" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP"
chmod +x "yt-dlp-$TRIPLE"

echo "• ffmpeg"
curl -fL -o "$tmp/ffmpeg.zip" \
  "https://ffmpeg.martin-riedl.de/redirect/latest/$OS/$FF_ARCH/release/ffmpeg.zip"
unzip -o -q "$tmp/ffmpeg.zip" -d "$tmp/ff"
mv "$tmp/ff/ffmpeg" "ffmpeg-$TRIPLE"
chmod +x "ffmpeg-$TRIPLE"

echo "• deno"
curl -fL -o "$tmp/deno.zip" \
  "https://github.com/denoland/deno/releases/latest/download/deno-$TRIPLE.zip"
unzip -o -q "$tmp/deno.zip" -d "$tmp/dn"
mv "$tmp/dn/deno" "deno-$TRIPLE"
chmod +x "deno-$TRIPLE"

echo "Done:"
ls -la "yt-dlp-$TRIPLE" "ffmpeg-$TRIPLE" "deno-$TRIPLE"
