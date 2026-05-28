import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema (Remotion input props validation)
// ---------------------------------------------------------------------------

export const marketingSchema = z.object({
  /** Factory application identifier — drives brand token selection. */
  appId: z.string(),
  /** Short topic label, shown as the headline. */
  topic: z.string(),
  /** Full narration script text (displayed as subtitles). */
  script: z.string(),
  /** URL of the ElevenLabs narration audio file. Empty string = no audio. */
  narrationUrl: z.string(),
  /** Primary brand hex colour (e.g. `'#0066FF'`). */
  brandColor: z.string(),
  /** Accent hex colour for highlights and CTAs. */
  brandAccent: z.string(),
  /** Logo image URL — displayed in the top-left corner. */
  logoUrl: z.string(),
  /** Target duration in seconds. Media Room validates content fit before dispatch. */
  durationSeconds: z.number().min(15).max(1800),
  /** Optional scene beats for longer landing videos. */
  visualBeats: z.array(z.string()).max(8).default([]),
});

export type MarketingVideoProps = z.infer<typeof marketingSchema>;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Full-bleed gradient background with the brand colour. */
const Background: React.FC<{ color: string; accent: string }> = ({ color, accent }) => (
  <AbsoluteFill
    style={{
      background: `linear-gradient(135deg, ${color} 0%, ${color}cc 40%, ${accent}33 100%)`,
    }}
  />
);

/** Animated headline that slides in from the left. */
const Headline: React.FC<{ text: string; frame: number; fps: number }> = ({
  text,
  frame,
  fps,
}) => {
  const opacity = interpolate(frame, [0, fps * 0.5], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const translateX = interpolate(frame, [0, fps * 0.5], [-80, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: '25%',
        left: 120,
        right: 120,
        opacity,
        transform: `translateX(${String(translateX)}px)`,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 72,
        fontWeight: 800,
        color: '#ffffff',
        lineHeight: 1.1,
        textShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {text}
    </div>
  );
};

/** Subtitle / scene beat text that fades in after the headline. */
const Subtitle: React.FC<{ text: string; frame: number; fps: number }> = ({
  text,
  frame,
  fps,
}) => {
  const startFrame = fps * 1;
  const opacity = interpolate(frame, [startFrame, startFrame + fps * 0.8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Trim script to a punchy one-liner for the card (full script is in narration)
  const displayText =
    text.length > 120 ? text.slice(0, 117) + '…' : text;

  return (
    <div
      style={{
        position: 'absolute',
        top: '52%',
        left: 120,
        right: 120,
        opacity,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 36,
        fontWeight: 400,
        color: 'rgba(255,255,255,0.9)',
        lineHeight: 1.5,
      }}
    >
      {displayText}
    </div>
  );
};

/** Animated CTA badge that bounces in near the end. */
const CtaBadge: React.FC<{ frame: number; fps: number; durationInFrames: number; accent: string }> = ({
  frame,
  fps,
  durationInFrames,
  accent,
}) => {
  const startFrame = Math.max(fps * 10, durationInFrames - fps * 5);
  const scale = spring({
    frame: Math.max(0, frame - startFrame),
    fps,
    config: { damping: 12, stiffness: 200 },
  });

  if (frame < startFrame) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 140,
        left: 120,
        transform: `scale(${String(scale)})`,
        transformOrigin: 'left bottom',
        background: accent,
        color: '#ffffff',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 28,
        fontWeight: 700,
        padding: '16px 40px',
        borderRadius: 8,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        boxShadow: `0 8px 32px ${accent}66`,
      }}
    >
      Get Started Today →
    </div>
  );
};

/** Logo in top-left corner. */
const Logo: React.FC<{ logoUrl: string; frame: number; fps: number }> = ({
  logoUrl,
  frame,
  fps,
}) => {
  const opacity = interpolate(frame, [0, fps * 0.3], [0, 1], {
    extrapolateRight: 'clamp',
  });

  if (!logoUrl) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 48,
        left: 60,
        opacity,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logoUrl} alt="Brand logo" style={{ height: 56, objectFit: 'contain' }} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Marketing video composition.
 *
 * Structure:
 * - 0s–0.5s  Fade in background + logo
 * - 0.5s–2s  Headline slides in
 * - 1s–3s    Script subtitle fades in
 * - Final 5s   CTA badge springs in
 *
 * Narration audio (ElevenLabs MP3) plays across the full duration.
 */
export const MarketingVideo: React.FC<MarketingVideoProps> = ({
  topic,
  script,
  visualBeats,
  narrationUrl,
  brandColor,
  brandAccent,
  logoUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const beats = visualBeats.length > 0 ? visualBeats : [script];
  const beatFrame = Math.max(1, Math.floor(durationInFrames / beats.length));
  const activeBeat = beats[Math.min(Math.floor(frame / beatFrame), beats.length - 1)] ?? script;

  return (
    <AbsoluteFill style={{ background: '#000000' }}>
      <Background color={brandColor} accent={brandAccent} />
      <Logo logoUrl={logoUrl} frame={frame} fps={fps} />
      <Headline text={topic} frame={frame} fps={fps} />
      <Subtitle text={activeBeat} frame={frame} fps={fps} />
      <CtaBadge frame={frame} fps={fps} durationInFrames={durationInFrames} accent={brandAccent} />
      {narrationUrl && <Audio src={narrationUrl} />}
    </AbsoluteFill>
  );
};
