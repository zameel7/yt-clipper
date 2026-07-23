import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { load, Store } from "@tauri-apps/plugin-store";
import { suggestClips, type Clip, type Segment } from "./gemini";
import "./App.css";

interface TranscriptResult {
  video_id: string;
  duration: number;
  language: string;
  segments: Segment[];
}

const FRAME_STYLES = [
  { key: "none", label: "No frame" },
  { key: "black", label: "Black border" },
  { key: "white", label: "White border" },
  { key: "blue", label: "Blue border" },
  { key: "yellow", label: "Yellow border" },
  { key: "png", label: "PNG frame…" },
];

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip"
  );
}

export default function App() {
  const storeRef = useRef<Store | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const [url, setUrl] = useState("");
  const [count, setCount] = useState(5);
  const [length, setLength] = useState(30);
  const [frameStyle, setFrameStyle] = useState("black");
  const [pngPath, setPngPath] = useState<string | null>(null);
  const [pngName, setPngName] = useState<string | null>(null);

  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [, setSegments] = useState<Segment[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);

  const [cutting, setCutting] = useState<number | null>(null);
  const [cutMsg, setCutMsg] = useState("");
  const [saved, setSaved] = useState<Record<number, string>>({});

  // Load saved API key.
  useEffect(() => {
    (async () => {
      const store = await load("settings.json", { autoSave: true });
      storeRef.current = store;
      const k = (await store.get<string>("gemini_key")) ?? "";
      setApiKey(k);
      setKeyDraft(k);
      if (!k) setShowSettings(true);
    })();
  }, []);

  // Listen for cut progress from Rust.
  useEffect(() => {
    const un = listen<{ stage: string; message: string }>("clip-progress", (e) => {
      setCutMsg(e.payload.message);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function saveKey() {
    const store = storeRef.current;
    if (store) {
      await store.set("gemini_key", keyDraft.trim());
      await store.save();
    }
    setApiKey(keyDraft.trim());
    setShowSettings(false);
  }

  async function pickPng() {
    const file = await open({
      multiple: false,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (typeof file === "string") {
      setPngPath(file);
      setPngName(file.split(/[/\\]/).pop() ?? "frame.png");
      setFrameStyle("png");
    }
  }

  function onFrameChange(v: string) {
    if (v === "png") {
      pickPng();
    } else {
      setFrameStyle(v);
    }
  }

  function editTime(idx: number, field: "start" | "end", value: number) {
    setClips((cs) => cs.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
  }

  async function getSuggestions() {
    setError(null);
    setClips([]);
    setSaved({});
    setVideoId(null);
    setLang(null);
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (!url.trim()) {
      setError("Paste a YouTube URL first.");
      return;
    }
    try {
      setBusy("Fetching transcript…");
      const t = await invoke<TranscriptResult>("fetch_transcript", { url: url.trim() });
      setVideoId(t.video_id);
      setLang(t.language);
      setSegments(t.segments);

      setBusy("Asking Gemini for clip ideas…");
      const c = await suggestClips(apiKey, t.segments, count, length);
      setClips(c);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  async function cutClip(idx: number, clip: Clip) {
    setError(null);
    if (frameStyle === "png" && !pngPath) {
      setError("Pick a PNG file for the frame, or choose another frame style.");
      return;
    }
    try {
      const defaultName = `${slug(clip.title)}.mp4`;
      const outPath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Video", extensions: ["mp4"] }],
      });
      if (!outPath) return; // cancelled

      setCutting(idx);
      setCutMsg("Starting…");
      await invoke<string>("cut_clip", {
        url: url.trim(),
        start: clip.start,
        end: clip.end,
        frameStyle,
        framePng: frameStyle === "png" ? pngPath : null,
        outPath,
      });
      setSaved((s) => ({ ...s, [idx]: outPath }));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCutting(null);
      setCutMsg("");
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>🎬 YT Clipper</h1>
        <button className="ghost" onClick={() => setShowSettings(true)}>
          ⚙ Settings
        </button>
      </header>

      <p className="disclaimer">
        Downloads video locally for personal use only. Respect YouTube's Terms and
        copyright — only clip content you own or are authorized to use.
      </p>

      <section className="controls">
        <input
          className="url"
          placeholder="Paste a YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && getSuggestions()}
        />
        <div className="row">
          <label>
            Clips
            <input
              type="number"
              min={1}
              max={12}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </label>
          <label>
            ~Length (s)
            <input
              type="number"
              min={5}
              max={180}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>
          <label>
            Frame
            <select value={frameStyle} onChange={(e) => onFrameChange(e.target.value)}>
              {FRAME_STYLES.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={getSuggestions} disabled={!!busy}>
            {busy ? "Working…" : "Get suggestions"}
          </button>
        </div>
        {frameStyle === "png" && (
          <div className="png-row">
            🖼 {pngName ? <b>{pngName}</b> : "No PNG selected"}
            <button className="link" onClick={pickPng}>
              {pngName ? "Change" : "Choose PNG…"}
            </button>
            <span className="hint-inline">
              Overlaid full-frame — use a PNG with a transparent center.
            </span>
          </div>
        )}
      </section>

      {busy && <div className="banner info">{busy}</div>}
      {error && <div className="banner error">{error}</div>}

      {clips.length > 0 && (
        <section className="clips">
          <h2>
            {clips.length} clip{clips.length > 1 ? "s" : ""} suggested
            {videoId ? ` · ${videoId}` : ""}
            {lang ? ` · captions: ${lang}` : ""}
          </h2>
          {clips.map((c, i) => (
            <div className="clip" key={i}>
              <div className="clip-row">
                <div className="clip-main">
                  <div className="clip-title">{c.title}</div>
                  <div className="clip-reason">{c.reason}</div>
                  <div className="clip-edit">
                    <label>
                      Start
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={Number(c.start.toFixed(1))}
                        onChange={(e) => editTime(i, "start", Number(e.target.value))}
                      />
                      <span className="mmss">{fmt(c.start)}</span>
                    </label>
                    <label>
                      End
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={Number(c.end.toFixed(1))}
                        onChange={(e) => editTime(i, "end", Number(e.target.value))}
                      />
                      <span className="mmss">{fmt(c.end)}</span>
                    </label>
                    <span className="dur">= {Math.max(0, Math.round(c.end - c.start))}s</span>
                  </div>
                </div>
                <div className="clip-actions">
                  <button
                    className="ghost"
                    disabled={!videoId}
                    onClick={() =>
                      videoId &&
                      openUrl(
                        `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(c.start)}s`
                      )
                    }
                  >
                    ▶ Preview
                  </button>
                  {cutting === i ? (
                    <span className="cutting">{cutMsg || "Cutting…"}</span>
                  ) : saved[i] ? (
                    <button className="ghost" onClick={() => revealItemInDir(saved[i])}>
                      ✓ Reveal
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={cutting !== null || c.end <= c.start}
                      onClick={() => cutClip(i, c)}
                    >
                      ✂ Cut
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => apiKey && setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <label className="field">
              Gemini API key
              <input
                type="password"
                placeholder="AIza…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
            </label>
            <p className="hint">
              Get a free key at{" "}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                aistudio.google.com/apikey
              </a>
              . Stored locally on this machine.
            </p>
            <div className="modal-actions">
              {apiKey && (
                <button className="ghost" onClick={() => setShowSettings(false)}>
                  Cancel
                </button>
              )}
              <button className="primary" onClick={saveKey} disabled={!keyDraft.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
