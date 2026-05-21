# Video Studio

Automated video render engine for Factory applications — powered by [Remotion](https://remotion.dev).

## Compositions

| ID                 | Duration | Description                                              |
| ------------------ | -------- | -------------------------------------------------------- |
| `MarketingVideo`   | 15s      | Brand-voice headline + script + animated CTA badge       |
| `TrainingVideo`    | 30s      | Step-by-step training module with sidebar navigation     |
| `WalkthroughVideo` | 40s      | Product walkthrough driven by ordered screenshot URLs    |

All compositions are parameterised by brand tokens (`brandColor`, `brandAccent`, `logoUrl`) resolved at render time.

## Brief-driven renders

The GitHub Actions workflow now accepts an optional `brief_key` input. When provided, it loads
`apps/video-studio/content-briefs/{app-id}/{brief_key}.json` and uses that brief to resolve the
render topic, brand tokens, narration guidance, and optional `screenshotUrls` for walkthroughs.

If the brief also includes a top-level `script` field, the workflow skips the LLM generation step
and renders that exact narration deterministically. This is useful for homepage or launch assets
where wording must be approved and repeatable.

Example Prime Self homepage replacement brief:

```bash
gh workflow run render-video.yml \
  --repo Latimer-Woods-Tech/Factory \
  -f job_id=manual-homepage-welcome \
  -f composition_id=MarketingVideo \
  -f app_id=prime_self \
  -f topic="placeholder" \
  -f brief_key=homepage-welcome \
  -f brand_color=#8B5CF6 \
  -f brand_accent=#10B981 \
  -f logo_url=https://selfprime.net/icons/icon-72.png
```

`topic` remains required by the workflow contract for backward compatibility, but when
`brief_key` is set the brief's `topic` becomes the actual rendered topic.

## Development

```bash
# Install dependencies
npm install

# Open the Remotion Studio (visual editor)
npm run studio

# Type-check
npm run typecheck
```

## Render (used by GitHub Actions)

```bash
COMPOSITION_ID=MarketingVideo \
PROPS_JSON='{"appId":"prime_self","topic":"Q4 launch","script":"Raise your standard.","narrationUrl":"https://r2.example.com/narration.mp3","brandColor":"#0066FF","brandAccent":"#FF6600","logoUrl":"https://r2.example.com/logo.png"}' \
OUTPUT_PATH=/tmp/output.mp4 \
node -r ts-node/register src/render.ts
```

Or using CLI flags:

```bash
node -r ts-node/register src/render.ts \
  --composition MarketingVideo \
  --props '{"appId":"prime_self",...}' \
  --output /tmp/output.mp4
```

## Pipeline integration

The full automated pipeline:

```
PostHog signals
  → @latimer-woods-tech/schedule: scheduleVideo()
  → cron Worker: getPendingJobs() → dispatch to GitHub Actions
  → render-video.yml workflow:
      1. Generate narration (ElevenLabs)
      2. Render MP4 (Remotion → ffmpeg)
      3. Upload to Cloudflare R2
      4. Register with Cloudflare Stream
      5. Update video_calendar: updateJobStatus('done', { streamUid, videoUrl })
  → Landing page updated with new embed URL
  → PostHog tracks engagement → loop
```

## Constraints

- Runs in **GitHub Actions** only (not Cloudflare Workers — needs real Chromium + ffmpeg)
- No `process.env` for secrets — all passed as `PROPS_JSON` or workflow inputs
- Composition IDs must match `RenderJobType`: `marketing` → `MarketingVideo`, etc.
