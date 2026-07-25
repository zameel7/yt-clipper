# YT Clipper — demo proxy (Cloudflare Worker)

Powers the **live "Get suggestions" demo** on the landing page. Holds the Gemini
key server-side, reads a video's captions, and returns clip suggestions — the
same prompt the desktop app uses. Rate-limited to protect the free-tier quota.

`POST /suggest`

```json
{ "url": "https://www.youtube.com/watch?v=…", "count": 4, "length": 30 }
```

→

```json
{
  "video_id": "…",
  "language": "en",
  "clips": [{ "start": 14, "end": 52, "title": "…", "reason": "…" }]
}
```

## Deploy

```bash
cd worker
npm install

# 1. Rate-limit KV store — paste the printed id into wrangler.toml (id = "…")
npx wrangler kv namespace create RL

# 2. Gemini API key (stored as a secret, never in the repo)
npx wrangler secret put GEMINI_KEY

# 3. Ship it
npx wrangler deploy
```

Deploy prints the URL, e.g. `https://yt-clipper-demo.<your-subdomain>.workers.dev`.

Put that URL (with `/suggest`) into the landing page: edit `DEMO_API` near the top
of the script in `docs/index.html`, or set `window.YTC_DEMO_API` before the script
runs. If it's unset or unreachable, the demo silently falls back to the static
sample clips — the page still works.

## Config (`wrangler.toml` `[vars]`)

| var                | default                      | meaning                          |
| ------------------ | ---------------------------- | -------------------------------- |
| `ALLOWED_ORIGIN`   | `https://zameel7.github.io`  | CORS origin allowed to call it   |
| `RL_PER_IP_DAILY`  | `5`                          | requests per visitor per day     |
| `RL_GLOBAL_DAILY`  | `300`                        | total requests per day (quota guard) |
| `MAX_CLIPS`        | `6`                          | upper bound on clips per request |

## Notes / limits

- Transcript is scraped from the YouTube watch page + timedtext. Videos with **no
  captions**, or that are private / age-gated / region-locked, return an error —
  that's expected, the demo just shows the message.
- This is a **best-effort demo**. The real app uses bundled `yt-dlp`, which is far
  more robust than page-scraping.
