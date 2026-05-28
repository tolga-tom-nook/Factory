# Media Room

Media Room is the production control plane for Factory generated media.

It validates whether a media brief is ready to render and publish. It does not
render video directly; `apps/video-studio` and `.github/workflows/render-video.yml`
remain the rendering path.

## Current scope

- Validate content brief structure.
- Check script word count against target duration.
- Require visual plans for tutorials.
- Require chapters and scoped delivery for long-form personal readings.
- Produce readiness reports for operators and CI.
- Generate dispatch-safe render contract inputs.

## Duration policy

Duration is a production contract, not a short-attention-span rule. Media Room
blocks audio cutoff and unusable long-form delivery; it does not force every
video to be short.

- Landing videos need timing fit and visual beats when the script is long.
- Tutorials need steps or visual beats.
- Personal or client readings need private, signed, or scoped delivery.
- Long-form readings need chapters and transcripts.
- The shared renderer has a 30-minute technical ceiling; longer readings should
  use a dedicated long-form renderer or multipart output.

## Prime Self embedded video gate

```bash
npm run validate:prime-self-embedded
```

This strict launch gate currently covers the video surfaces embedded in
`humandesign/selfprime.net`:

- `homepage-welcome`
- `daily-transits-guide`
- `blueprint-reading-guide`
- `energy-type-overview`

Use the broader non-strict report while developing future briefs:

```bash
npm run validate:prime-self
```

## Dispatching replacement renders

After the embedded gate is green, dispatch each replacement render through the
existing GitHub Actions renderer:

```bash
gh workflow run render-video.yml \
  -f job_id=manual-homepage-welcome \
  -f app_id=prime_self \
  -f composition_id=MarketingVideo \
  -f brief_key=homepage-welcome \
  -f topic='See Your Pattern Clearly'

gh workflow run render-video.yml \
  -f job_id=manual-daily-transits-guide \
  -f app_id=prime_self \
  -f composition_id=TrainingVideo \
  -f brief_key=daily-transits-guide \
  -f topic='Using Daily Transits Without Overcomplicating Your Day'

gh workflow run render-video.yml \
  -f job_id=manual-blueprint-reading-guide \
  -f app_id=prime_self \
  -f composition_id=TrainingVideo \
  -f brief_key=blueprint-reading-guide \
  -f topic='How to Read Your Body Graph'

gh workflow run render-video.yml \
  -f job_id=manual-energy-type-overview \
  -f app_id=prime_self \
  -f composition_id=TrainingVideo \
  -f brief_key=energy-type-overview \
  -f topic='Understanding Your Energy Type'
```

When Cloudflare Stream returns replacement UIDs, update the corresponding embeds
in `humandesign/selfprime.net`.

## Boundary

Media Room owns readiness, approval, and QA contracts. Video Studio owns Remotion
templates. Schedule Worker owns the queue. Render Video owns execution.
