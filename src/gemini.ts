export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Clip {
  start: number;
  end: number;
  title: string;
  reason: string;
}

// Tried in order. Newly created API keys / projects do not always have every
// pinned model ID enabled — Gemini 3 Flash replaced 2.5 Flash as the default for
// new projects — so walk from newest to oldest and keep the rolling alias as a
// catch-all. Every entry is free-of-charge tier and supports JSON schema output.
// https://ai.google.dev/gemini-api/docs/pricing
const MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

// Once a model works for this key, stick with it instead of re-walking the
// chain (and re-paying the failed round trips) on every generate.
let workingModel: string | null = null;

const ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    key
  )}`;

// A model the key cannot use at all — worth retrying with the next candidate.
// Auth/quota/bad-request failures are not, they will fail identically.
function isModelUnavailable(status: number, message: string): boolean {
  if (status === 404) return true;
  const m = message.toLowerCase();
  return (
    (status === 400 || status === 403) &&
    (m.includes("not found") ||
      m.includes("not supported") ||
      m.includes("is not available") ||
      m.includes("does not have access"))
  );
}

function buildTranscript(segments: Segment[]): string {
  // One line per segment: "[start-end] text" (seconds, 1 decimal).
  return segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");
}

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
          reason: {
            type: "STRING",
            description: "One sentence: why this makes a good short clip",
          },
        },
        required: ["start", "end", "title", "reason"],
      },
    },
  },
  required: ["clips"],
};

export async function suggestClips(
  apiKey: string,
  segments: Segment[],
  count: number,
  targetSeconds: number
): Promise<Clip[]> {
  const transcript = buildTranscript(segments);
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

  let res: Response | undefined;
  let lastError: { status: number; msg: string } | undefined;

  const candidates = workingModel
    ? [workingModel, ...MODELS.filter((m) => m !== workingModel)]
    : MODELS;

  for (const model of candidates) {
    const attempt = await fetch(ENDPOINT(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (attempt.ok) {
      res = attempt;
      workingModel = model;
      break;
    }

    const errText = await attempt.text();
    let msg = errText;
    try {
      msg = JSON.parse(errText)?.error?.message ?? errText;
    } catch {
      /* keep raw text */
    }
    lastError = { status: attempt.status, msg };

    if (!isModelUnavailable(attempt.status, msg)) break;
  }

  if (!res) {
    const { status, msg } = lastError ?? { status: 0, msg: "unknown error" };
    const suffix = isModelUnavailable(status, msg)
      ? ` (tried: ${MODELS.join(", ")} — none are available to this API key)`
      : "";
    throw new Error(`Gemini API error (${status}): ${msg}${suffix}`);
  }

  const data = await res.json();
  const text: string | undefined =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no content.");
  }

  const parsed = JSON.parse(text) as { clips: Clip[] };
  const clips = (parsed.clips ?? []).filter(
    (c) => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start
  );
  if (clips.length === 0) {
    throw new Error("Gemini did not return any clips.");
  }
  return clips;
}
