# Media Room Production Control Plane

**Date:** 2026-05-28
**Status:** Active implementation plan
**Owner:** Factory Platform + Media Systems
**First production use case:** Prime Self landing page and tutorial videos

---

## Decision

Media Room is now a first-class Factory control plane for production media.

It does not replace `apps/video-studio`, `render-video.yml`, Cloudflare Stream,
R2, ElevenLabs, or Capricast. It owns the creative and operational contract that
decides whether a video is ready to render and publish.

```text
Media Room
  -> validates brief, script, visual plan, duration, destination
  -> creates approved render request
  -> dispatches existing render pipeline
  -> records QA and publication metadata

Video Studio
  -> Remotion templates and render entrypoint

render-video.yml
  -> narration, render, encode, upload, Stream registration, publishing
```

This keeps heavy rendering in GitHub Actions and keeps product-specific media
quality decisions out of low-level render templates.

---

## Why This Exists

The first Prime Self tutorial renders proved that the pipeline can make videos,
but they also exposed the missing production layer:

- scripts can exceed the composition duration,
- training videos can render without meaningful visual aids,
- static approved scripts can skip step generation,
- published video metadata can claim a duration that does not fit the words,
- operators have no single place to approve, block, rerender, or publish.

Media Room exists to prevent those failures before render time.

---

## Non-Negotiable Requirements

1. **No render without a timing fit.**
   A script must fit the target duration using the configured words-per-second
   ceiling for the composition. Duration is a production contract, not a
   short-attention-span content rule.

2. **No tutorial without a visual plan.**
   Every training or walkthrough video needs steps, screenshots, scene beats, or
   another explicit visual progression.

3. **No production publish from an unapproved brief.**
   Drafts can preview. Approved briefs can render. Published artifacts must have
   stream UID, thumbnail, transcript, duration, and source brief version.

4. **No personal reading without scoped delivery.**
   Personal or client readings require private, signed, or scoped playback, plus
   transcript support and chaptering for long-form review.

5. **No raw private data in shared queues.**
   Private SelfPrime chart or client context must remain in the product app and
   be referenced by stable, scoped pointers.

6. **No renderer coupling.**
   Media Room prepares and validates. Video Studio renders. Schedule Worker
   queues. Video Cron dispatches. Stream/R2 store artifacts.

---

## Contract Model

### Brief Fields

Required for production readiness:

| Field | Purpose |
|---|---|
| `briefKey` | Stable source identifier |
| `composition` | Remotion composition id |
| `topic` | Human-readable title |
| `learningGoal` | What the viewer should be able to do after watching |
| `keyPoints` | Approved factual points |
| `forbiddenClaims` | Claims the script must not make |
| `toneNotes` | Voice and pacing guidance |
| `renderPlan.durationSeconds` | Target render duration |
| `renderPlan.steps` | Training-video visual navigation |
| `renderPlan.visualBeats` | Scene-level visual plan |
| `renderPlan.chapters` | Long-form navigation points |
| `screenshotUrls` | Required for screenshot walkthroughs |
| `delivery.privacy` | `private`, `signed`, or `scoped` for personal/client readings |
| `delivery.transcript` | Transcript availability for review and accessibility |

### Duration Policy

Media Room does not enforce marketing-style brevity. It enforces fit and
navigability:

| Format | Typical Use | Production Requirement |
|---|---|---|
| Landing / welcome | First impression | Script must fit duration; long scripts need visual beats |
| Feature tutorial | Teach a workflow | Steps or visual beats required |
| Personal reading | User-specific explanation | Scoped playback, transcript, and chapters |
| Practitioner/client reading | Deliverable sent to someone else | Scoped playback, transcript, chapters, and private-data pointers only |

The shared renderer currently allows up to 30 minutes per generated video. That
is a technical ceiling for GitHub Actions and Remotion reliability, not a
product recommendation. Longer formats should use a dedicated long-form
renderer or chaptered multipart output.

### Readiness States

| State | Meaning |
|---|---|
| `draft` | incomplete, editable |
| `ready` | validated and eligible for render |
| `approved` | operator-approved render input |
| `rendered` | Stream/R2 artifact exists |
| `published` | artifact exposed in a product surface |
| `blocked` | failed quality gate |
| `needs_rerender` | previous artifact exists but source contract changed |

Existing Prime Self briefs may still use `ready`, `planned`, and `published`.
Media Room maps those into the stricter states during validation.

---

## Initial Build Scope

### Phase 1: Production Gate

- Add a Media Room brief validation engine.
- Validate timing, required fields, visual plan, and publish metadata.
- Generate machine-readable readiness reports.
- Fail strict mode when render blockers exist.
- Add Prime Self render plans to the existing tutorial briefs.

### Phase 2: Render Contract

- Pass `steps` and `durationSeconds` from briefs to the render workflow.
- Let `TrainingVideo` derive render length from approved duration.
- Keep static scripts deterministic while still supplying visual steps.
- Persist `briefKey` and `compositionId` through Schedule Worker and Video Cron
  so queued renders cannot fall back to topic-only generation.

### Phase 3: Operator Surface

- Expose Media Room readiness in Admin Studio.
- Add approve/block/rerender actions with audit events.
- Store artifact QA outcomes against source brief version.

### Phase 4: Multi-App Studio

- Add app tenancy, brand profiles, moderation policy, and publish destinations.
- Support SelfPrime, Capricast, Xico City, and future Factory media products.

---

## Prime Self Launch Bar

The tutorial and landing-page video item is not closed until:

- `homepage-welcome`, `daily-transits-guide`, `blueprint-reading-guide`, and
  `energy-type-overview` pass Media Room validation,
- each has a target duration that fits the script,
- each has steps or visual beats,
- the workflow passes those values into `MarketingVideo` or `TrainingVideo`,
- the scheduling catalog can dispatch all four by `briefKey`,
- newly rendered videos have Stream UIDs and playback QA,
- SelfPrime embeds point at the replacement videos.

---

## Engineering Boundaries

| Layer | Owns | Must not own |
|---|---|---|
| `apps/media-room` | readiness, validation, dispatch commands, QA metadata | Remotion rendering, ffmpeg, Stream secrets |
| `apps/video-studio` | Remotion templates and render entrypoint | approval policy, product-specific QA |
| `render-video.yml` | pipeline execution | deciding whether a brief is good enough |
| `apps/schedule-worker` | shared queue and app-scoped job status | creative validation |
| Product apps | user experience and private context | shared queue internals |

---

## Product Exposure

Do not expose "Media Room" directly to Prime Self customers. It is an internal
production control plane.

Expose the customer-facing capability as generated readings:

| Customer action | Internal Media Room contract |
|---|---|
| Generate a guided video reading | `deliverableType: personal_reading` |
| Send this reading to a client | `deliverableType: client_reading` |
| Choose depth: quick, guided, deep | Approved `renderPlan.durationSeconds` |
| Include transcript | `delivery.transcript: true` |
| Private playback link | `delivery.privacy: signed` or `scoped` |
| Chaptered reading | `renderPlan.chapters` |

Recommended product formats:

| Format | Practical length | Notes |
|---|---|---|
| Quick orientation | 2-4 minutes | Good for first-run onboarding or one feature |
| Guided reading | 5-12 minutes | Best default for personal blueprint explanation |
| Practitioner/client reading | 10-25 minutes | Requires transcript, chapters, and private delivery |
| Deep synthesis | Multipart or dedicated long-form renderer | Avoid hiding a large report in one unchaptered video |

The strategic standard is earned depth. If a user or practitioner is invested
enough to ask for a reading, the system should optimize for clarity, structure,
specificity, and replay value rather than minimum duration.

---

## First Success Metric

A Prime Self homepage or tutorial brief can be validated, approved, dispatched,
rendered at the right duration, and embedded without manual correction or audio
cutoff.
