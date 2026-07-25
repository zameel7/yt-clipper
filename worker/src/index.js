/**
 * YT Clipper — demo proxy (Cloudflare Worker)
 *
 * POST /suggest  { url, count?, length? }
 *   → { video_id, language, clips: [{ start, end, title, reason }] }
 *
 * Holds the Gemini key server-side (secret GEMINI_KEY), fetches the video's
 * captions, and asks Gemini 2.5 Flash for clip suggestions — the same prompt
 * the desktop app uses. Rate-limited per IP and globally (KV) to protect the
 * free-tier quota from abuse.
 *
 * Deploy:
 *   cd worker
 *   npx wrangler kv namespace create RL      # paste the id into wrangler.toml
 *   npx wrangler secret put GEMINI_KEY        # your Gemini API key
 *   npx wrangler deploy
 */

const MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    clips: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start: { type: "NUMBER", description: "Clip start time in seconds" },
          end: { type: "NUMBER", description: "Clip end time in seconds" },
          title: { type: "STRING", description: "Short punchy title for the clip" },
          reason: { type: "STRING", description: "One sentence: why this makes a good short clip" },
        },
        required: ["start", "end", "title", "reason"],
      },
    },
  },
  required: ["clips"],
};

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/suggest") {
      return json({ error: "POST /suggest" }, 404, cors);
    }

    // ---- rate limit ----
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const rl = await rateLimit(env, ip);
    if (!rl.ok) return json({ error: rl.message }, 429, cors);

    // ---- input ----
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400, cors);
    }
    const videoId = extractVideoId(String(payload?.url || ""));
    if (!videoId) return json({ error: "Couldn't read a YouTube video ID from that URL." }, 400, cors);

    const count = clamp(parseInt(payload?.count, 10) || 4, 1, parseInt(env.MAX_CLIPS, 10) || 6);
    const length = clamp(parseInt(payload?.length, 10) || 30, 5, 180);

    try {
      const { segments, language } = await fetchTranscript(videoId);
      if (!segments.length) {
        return json({ error: "This video has no usable captions to read." }, 422, cors);
      }
      const clips = await suggestClips(env.GEMINI_KEY, segments, count, length);
      return json({ video_id: videoId, language, clips }, 200, cors);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502, cors);
    }
  },
};

/* ------------------------------------------------------------------ */

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function extractVideoId(input) {
  const s = input.trim();
  const m =
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    s.match(/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/) ||
    s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

async function rateLimit(env, ip) {
  const kv = env.RL;
  if (!kv) return { ok: true }; // no KV bound → limiting disabled
  const day = new Date().toISOString().slice(0, 10);
  const perIp = parseInt(env.RL_PER_IP_DAILY, 10) || 5;
  const global = parseInt(env.RL_GLOBAL_DAILY, 10) || 300;

  const ipKey = `ip:${ip}:${day}`;
  const gKey = `global:${day}`;
  const [ipN, gN] = await Promise.all([kv.get(ipKey), kv.get(gKey)]);
  const ipCount = parseInt(ipN, 10) || 0;
  const gCount = parseInt(gN, 10) || 0;

  if (ipCount >= perIp) return { ok: false, message: `Daily demo limit reached (${perIp}/day). Download the app for unlimited use.` };
  if (gCount >= global) return { ok: false, message: "The demo hit its daily cap. Try again tomorrow, or download the app." };

  await Promise.all([
    kv.put(ipKey, String(ipCount + 1), { expirationTtl: 172800 }),
    kv.put(gKey, String(gCount + 1), { expirationTtl: 172800 }),
  ]);
  return { ok: true };
}

/* ---- transcript via YouTube watch page + timedtext ---- */

async function fetchTranscript(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "CONSENT=YES+1",
    },
  });
  const html = await res.text();
  const pr = extractJsonAfter(html, "ytInitialPlayerResponse");
  if (!pr) throw new Error("Couldn't read the video page (it may be private or region-locked).");

  const status = pr?.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(pr?.playabilityStatus?.reason || "This video can't be read (login/age gate).");
  }

  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error("This video has no captions.");

  // Prefer manual English, then any manual, then auto (asr).
  const pick =
    tracks.find((t) => /^en/.test(t.languageCode || "") && t.kind !== "asr") ||
    tracks.find((t) => t.kind !== "asr") ||
    tracks.find((t) => /^en/.test(t.languageCode || "")) ||
    tracks[0];

  const capRes = await fetch(pick.baseUrl, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  const xml = await capRes.text();
  const segments = parseTimedText(xml);
  return { segments, language: pick.languageCode || "unknown" };
}

// Scan matching braces after `name = ` to pull a JSON object out of HTML.
function extractJsonAfter(html, name) {
  const idx = html.indexOf(name);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseTimedText(xml) {
  const out = [];
  const re = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2] || "0") || 0;
    const text = decodeEntities(m[3]).replace(/\s+/g, " ").trim();
    if (text) out.push({ start, end: start + dur, text });
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/* ---- Gemini (mirrors src/gemini.ts) ---- */

async function suggestClips(apiKey, segments, count, targetSeconds) {
  if (!apiKey) throw new Error("Server is missing its Gemini key.");

  // Bound transcript size to keep token cost predictable.
  let transcript = segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
  const MAX = 18000;
  if (transcript.length > MAX) transcript = transcript.slice(0, MAX);

  const prompt = `You are a short-form video editor. Below is a timestamped transcript of a YouTube video (each line is "[start-end] text", times in seconds). The transcript may be in any language.

Pick the ${count} most engaging, self-contained moments that would make great short clips (each roughly ${targetSeconds} seconds long — pick natural start/end times from the transcript timestamps so a clip does not cut mid-sentence).

For each clip return: start (seconds), end (seconds), a short catchy title, and a one-sentence reason it works as a short. Write the title and reason in English (you may keep a short key phrase in the original language if it is the hook).

Transcript:
${transcript}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const res = await fetch(GEMINI_ENDPOINT(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    let msg = t;
    try {
      msg = JSON.parse(t)?.error?.message ?? t;
    } catch {}
    throw new Error(`Gemini error (${res.status}): ${msg}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content.");
  const parsed = JSON.parse(text);
  const clips = (parsed.clips ?? []).filter(
    (c) => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start
  );
  if (!clips.length) throw new Error("Gemini did not return any clips.");
  return clips;
}
