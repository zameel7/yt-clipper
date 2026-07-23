use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

#[derive(Serialize, Clone)]
struct Segment {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Serialize)]
struct TranscriptResult {
    video_id: String,
    duration: f64,
    segments: Vec<Segment>,
}

#[derive(Serialize, Clone)]
struct Progress {
    stage: String,
    message: String,
}

/// Resolve a bundled sidecar binary path. Sidecars sit next to the app
/// executable in both dev (target/debug) and release builds.
fn sidecar_path(base: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    };
    let p = dir.join(name);
    if p.exists() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Extra yt-dlp args: point it at the bundled deno JS runtime (reliable YouTube
/// extraction) and the bundled ffmpeg (for muxing merged formats).
fn ytdlp_extra_args() -> Vec<String> {
    let mut v = Vec::new();
    if let Some(deno) = sidecar_path("deno") {
        v.push("--js-runtimes".into());
        v.push(format!("deno:{deno}"));
    }
    if let Some(ffmpeg) = sidecar_path("ffmpeg") {
        v.push("--ffmpeg-location".into());
        v.push(ffmpeg);
    }
    v
}

fn unique_tmp_dir(prefix: &str) -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("yt-clipper-{}-{}", prefix, nanos));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Parse a `HH:MM:SS.mmm` (or `MM:SS.mmm`) VTT timestamp into seconds.
fn parse_ts(s: &str) -> Option<f64> {
    let s = s.trim();
    let mut parts = s.split(':').rev();
    let sec: f64 = parts.next()?.replace(',', ".").parse().ok()?;
    let min: f64 = parts.next().map(|m| m.parse().unwrap_or(0.0)).unwrap_or(0.0);
    let hour: f64 = parts.next().map(|h| h.parse().unwrap_or(0.0)).unwrap_or(0.0);
    Some(hour * 3600.0 + min * 60.0 + sec)
}

/// Strip inline VTT tags like <00:00:01.000> and <c>...</c>, collapse whitespace.
fn clean_cue(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse a WebVTT file into de-duplicated timed segments.
fn parse_vtt(content: &str) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(arrow) = line.find("-->") {
            let start_raw = &line[..arrow];
            let rest = &line[arrow + 3..];
            let end_raw = rest.split_whitespace().next().unwrap_or("");
            let start = parse_ts(start_raw);
            let end = parse_ts(end_raw);
            i += 1;
            let mut text_lines: Vec<String> = Vec::new();
            while i < lines.len() && !lines[i].trim().is_empty() && !lines[i].contains("-->") {
                let cleaned = clean_cue(lines[i]);
                if !cleaned.is_empty() {
                    text_lines.push(cleaned);
                }
                i += 1;
            }
            let text = text_lines.join(" ");
            if let (Some(start), Some(end)) = (start, end) {
                let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !text.is_empty() {
                    // Dedup rolling auto-captions: merge when this text overlaps
                    // the previous segment (common with auto-subs).
                    let dup = segments
                        .last()
                        .map(|s| {
                            s.text == text || s.text.ends_with(&text) || text.starts_with(&s.text)
                        })
                        .unwrap_or(false);
                    if dup {
                        if let Some(last) = segments.last_mut() {
                            if text.len() > last.text.len() {
                                last.text = text;
                            }
                            last.end = end;
                        }
                    } else {
                        segments.push(Segment { start, end, text });
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    segments
}

#[tauri::command]
async fn fetch_transcript(app: AppHandle, url: String) -> Result<TranscriptResult, String> {
    let dir = unique_tmp_dir("sub")?;
    let out_tpl = dir.join("%(id)s").to_string_lossy().to_string();

    let mut args: Vec<String> = vec![
        "--skip-download".into(),
        "--write-auto-subs".into(),
        "--write-subs".into(),
        "--sub-langs".into(),
        "en,en-orig,en-US,en-GB".into(),
        "--sub-format".into(),
        "vtt".into(),
        "--convert-subs".into(),
        "vtt".into(),
        "--no-playlist".into(),
        "-o".into(),
        out_tpl.clone(),
        url.clone(),
    ];
    args.extend(ytdlp_extra_args());

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("yt-dlp run failed: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("yt-dlp error: {}", err.trim()));
    }

    // Find the first .vtt file written.
    let mut vtt_path: Option<PathBuf> = None;
    let mut video_id = String::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("vtt") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    // stem is like "<id>.en"
                    video_id = stem.split('.').next().unwrap_or("").to_string();
                }
                vtt_path = Some(p);
                break;
            }
        }
    }

    let vtt_path = match vtt_path {
        Some(p) => p,
        None => {
            let _ = fs::remove_dir_all(&dir);
            return Err(
                "No captions found for this video. It has no subtitles or auto-captions."
                    .to_string(),
            );
        }
    };

    let content = fs::read_to_string(&vtt_path).map_err(|e| e.to_string())?;
    let segments = parse_vtt(&content);
    let _ = fs::remove_dir_all(&dir);

    if segments.is_empty() {
        return Err("Captions file was empty or unparseable.".to_string());
    }

    let duration = segments.last().map(|s| s.end).unwrap_or(0.0);
    Ok(TranscriptResult {
        video_id,
        duration,
        segments,
    })
}

/// Map a frame-style key to an ffmpeg -vf value. None => stream copy.
fn frame_filter(style: &str) -> Option<String> {
    match style {
        "black" => Some("pad=iw+48:ih+48:24:24:color=black".to_string()),
        "white" => Some("pad=iw+48:ih+48:24:24:color=white".to_string()),
        "blue" => Some("pad=iw+56:ih+56:28:28:color=0x1e3a8a".to_string()),
        "yellow" => Some("pad=iw+56:ih+56:28:28:color=0xfacc15".to_string()),
        _ => None, // "none"
    }
}

#[tauri::command]
async fn cut_clip(
    app: AppHandle,
    url: String,
    start: f64,
    end: f64,
    frame_style: String,
    frame_png: Option<String>,
    out_path: String,
) -> Result<String, String> {
    if end <= start {
        return Err("Clip end must be after start.".to_string());
    }

    let emit = |stage: &str, message: &str| {
        let _ = app.emit(
            "clip-progress",
            Progress {
                stage: stage.to_string(),
                message: message.to_string(),
            },
        );
    };

    let dir = unique_tmp_dir("clip")?;
    let src = dir.join("src.mp4");
    let src_str = src.to_string_lossy().to_string();

    emit("download", "Downloading video…");
    let mut dl_args: Vec<String> = vec![
        "-f".into(),
        "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best".into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "--no-playlist".into(),
        "-o".into(),
        src_str.clone(),
        url.clone(),
    ];
    dl_args.extend(ytdlp_extra_args());

    let dl = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp: {e}"))?
        .args(dl_args)
        .output()
        .await
        .map_err(|e| format!("yt-dlp run failed: {e}"))?;

    if !dl.status.success() {
        let err = String::from_utf8_lossy(&dl.stderr);
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("Download failed: {}", err.trim()));
    }

    emit("cut", "Cutting clip…");
    let start_s = format!("{start}");
    let dur_s = format!("{}", end - start);

    // Input-level seek + duration reads only the wanted segment.
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-ss".into(),
        start_s,
        "-t".into(),
        dur_s,
        "-i".into(),
        src_str.clone(),
    ];

    let reencode = |a: &mut Vec<String>| {
        a.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
        ]);
    };

    let png = frame_png.filter(|p| !p.is_empty());
    if frame_style == "png" {
        match png {
            Some(png_path) => {
                emit("frame", "Applying PNG frame…");
                // Scale the PNG overlay to the video size, then composite it on top.
                args.extend([
                    "-i".into(),
                    png_path,
                    "-filter_complex".into(),
                    "[1:v][0:v]scale2ref[ovr][base];[base][ovr]overlay=0:0".into(),
                ]);
                reencode(&mut args);
            }
            None => {
                let _ = fs::remove_dir_all(&dir);
                return Err("Pick a PNG file for the frame, or choose another style.".to_string());
            }
        }
    } else {
        match frame_filter(&frame_style) {
            Some(vf) => {
                emit("frame", "Applying frame…");
                args.extend(["-vf".into(), vf]);
                reencode(&mut args);
            }
            None => {
                args.extend(["-c".into(), "copy".into()]);
            }
        }
    }
    args.push(out_path.clone());

    let cut = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("sidecar ffmpeg: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg run failed: {e}"))?;

    let _ = fs::remove_dir_all(&dir);

    if !cut.status.success() {
        let err = String::from_utf8_lossy(&cut.stderr);
        return Err(format!("ffmpeg error: {}", err.trim()));
    }

    emit("done", "Clip saved.");
    Ok(out_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![fetch_transcript, cut_clip])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
