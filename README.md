# 🎬 YT Clipper

Desktop app that turns a YouTube video into short, ready-to-share clips.

Paste a URL → **Gemini** reads the transcript and suggests the best moments →
tweak the in/out times, preview them, and cut real `.mp4` clips locally — with an
optional decorative frame or your own PNG overlay.

Everything (download + cutting) runs **on your machine** via bundled `yt-dlp` and
`ffmpeg`. No server, no upload, no account.

---

## Features

- 🤖 **AI clip suggestions** — Gemini 2.5 Flash (free tier) picks engaging moments from the transcript.
- ✂️ **Real local cuts** — `yt-dlp` downloads, `ffmpeg` cuts. Output is a normal `.mp4`.
- ⏱️ **Editable in/out times** — nudge start/end per clip before cutting.
- ▶️ **Preview** — watch the exact clip range inline (embedded player) before you cut.
- 🖼️ **Frames** — color borders (black / white / blue / yellow) **or upload your own PNG** overlay.
- 🔑 **Your key, stored locally** — bring your own free Gemini API key.
- 🖥️ **macOS + Windows + Linux** — one codebase, native installers (Fedora `.rpm`, `.deb`, `.AppImage`).

---

## Download

Grab the latest installer from the **[Releases page](https://github.com/zameel7/yt-clipper/releases/latest)**.

Or via `curl` (replace `VERSION`, e.g. `0.1.0`, with the latest tag):

**macOS (Apple Silicon):**
```bash
VERSION=0.1.0
curl -L -o YTClipper.dmg \
  "https://github.com/zameel7/yt-clipper/releases/download/v${VERSION}/yt-clipper_${VERSION}_aarch64.dmg"
open YTClipper.dmg
```

**Windows (x64):**
```powershell
$VERSION = "0.1.0"
curl.exe -L -o YTClipper-setup.exe `
  "https://github.com/zameel7/yt-clipper/releases/download/v$VERSION/yt-clipper_${VERSION}_x64-setup.exe"
.\YTClipper-setup.exe
```

**Linux — Fedora / RHEL (`.rpm`):**
```bash
VERSION=0.1.0
curl -L -o yt-clipper.rpm \
  "https://github.com/zameel7/yt-clipper/releases/download/v${VERSION}/yt-clipper-${VERSION}-1.x86_64.rpm"
sudo dnf install ./yt-clipper.rpm
```

**Linux — universal (`.AppImage`):**
```bash
VERSION=0.1.0
curl -L -o yt-clipper.AppImage \
  "https://github.com/zameel7/yt-clipper/releases/download/v${VERSION}/yt-clipper_${VERSION}_amd64.AppImage"
chmod +x yt-clipper.AppImage && ./yt-clipper.AppImage
```

**Linux — Debian / Ubuntu (`.deb`):**
```bash
VERSION=0.1.0
curl -L -o yt-clipper.deb \
  "https://github.com/zameel7/yt-clipper/releases/download/v${VERSION}/yt-clipper_${VERSION}_amd64.deb"
sudo apt install ./yt-clipper.deb
```

> Exact asset filenames are listed on each release.

### ⚠️ macOS: "yt-clipper is damaged and can't be opened"

Not damaged — the app is **unsigned** (no paid Apple Developer cert), so macOS
quarantines it. Clear the flag once:

```bash
xattr -dr com.apple.quarantine /Applications/yt-clipper.app
```

Then open it normally. (Adjust the path if the app is elsewhere, e.g. `~/Downloads/`.)

---

## Setup (first run)

1. Open the app → **⚙ Settings**.
2. Paste a **Gemini API key** — get a free one at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey). It's stored locally.
3. Paste a YouTube URL → **Get suggestions**.
4. Edit times / preview → **✂ Cut** → choose where to save.

---

## How it works

```
Paste URL ──► fetch_transcript (yt-dlp: auto-captions → VTT → timed segments)
          ──► Gemini (generateContent, structured JSON) ──► [{start,end,title,reason}]
edit/preview
   ✂ Cut  ──► cut_clip (yt-dlp download best mp4 ──► ffmpeg -ss/-t + frame) ──► saved .mp4
```

- **Frontend:** React + Vite (`src/`). Gemini call in `src/gemini.ts`.
- **Core:** Rust (`src-tauri/src/lib.rs`) — `fetch_transcript` and `cut_clip` commands.
- **Sidecars:** `yt-dlp`, `ffmpeg`, and `deno` (yt-dlp's JS runtime for reliable
  YouTube extraction) bundled per-OS.

---

## Build from source

**Prerequisites:** [Rust](https://rustup.rs), Node 18+, and the
[Tauri v2 system deps](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/zameel7/yt-clipper.git
cd yt-clipper
npm install

# Download the sidecar binaries for your OS (not committed to git):
bash scripts/fetch-binaries.sh          # macOS or Linux
# pwsh scripts/fetch-binaries.ps1        # Windows

npm run tauri dev      # run
npm run tauri build    # produce an installer in src-tauri/target/release/bundle/
```

The sidecar binaries live in `src-tauri/binaries/` named `<tool>-<target-triple>`
(e.g. `ffmpeg-aarch64-apple-darwin`). They are git-ignored and fetched by the
scripts above; CI does the same per-platform.

---

## Releasing

Push a tag and GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml))
builds macOS + Windows installers and attaches them to the release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## ⚠️ Legal

This tool downloads YouTube video locally. Downloading may violate YouTube's
Terms of Service and can infringe copyright. **Only clip content you own or are
authorized to use.** Provided for personal use — you are responsible for how you
use it.

---

## License

[MIT](LICENSE)
