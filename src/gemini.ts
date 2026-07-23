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

const MODEL = "gemini-2.5-flash";
const ENDPOINT = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(
    key
  )}`;

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

  const res = await fetch(ENDPOINT(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = errText;
    try {
      msg = JSON.parse(errText)?.error?.message ?? errText;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Gemini API error (${res.status}): ${msg}`);
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
