import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const trainingSchema = z.object({
  /** Factory application identifier. */
  appId: z.string(),
  /** Training module title. */
  topic: z.string(),
  /** Full narration script. */
  script: z.string(),
  /** URL of the ElevenLabs narration audio file. Empty string = no audio. */
  narrationUrl: z.string(),
  /** Primary brand hex colour. */
  brandColor: z.string(),
  /** Accent hex colour for step highlights. */
  brandAccent: z.string(),
  /** Logo image URL. */
  logoUrl: z.string(),
  /** Ordered list of training steps (max 8 for readability). */
  steps: z.array(z.string()).max(8),
  /** Target duration in seconds. Media Room validates content fit before dispatch. */
  durationSeconds: z.number().min(15).max(1800),
});

export type TrainingVideoProps = z.infer<typeof trainingSchema>;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Dark sidebar with brand colour stripe. */
const Sidebar: React.FC<{ color: string }> = ({ color }) => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: 480,
      height: '100%',
      background: `linear-gradient(180deg, ${color} 0%, ${color}cc 100%)`,
    }}
  />
);

/** Step list — highlights the current step based on frame. */
const StepList: React.FC<{
  steps: string[];
  frame: number;
  accent: string;
  stepFrames: number;
}> = ({ steps, frame, accent, stepFrames }) => {
  const activeStep = Math.min(
    Math.floor(frame / stepFrames),
    steps.length - 1,
  );

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: 60,
        width: 360,
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {steps.map((step, i) => {
        const isActive = i === activeStep;
        const isPast = i < activeStep;

        // Frame offset within this step's window — used for enter animations.
        // Remotion renders each frame as a static snapshot; CSS transitions
        // have no effect. All animations must be driven by interpolate().
        const localFrame = frame - i * stepFrames;

        // Opacity: future steps are dimmed; active steps fade in over 15 frames;
        // past steps immediately drop to 0.5 (already rendered).
        const opacity = isPast
          ? 0.5
          : isActive
          ? interpolate(localFrame, [0, 15], [0.6, 1.0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          : 0.7;

        // Active bullet pops in with a slight overshoot for tactile feedback.
        const bulletScale = isActive
          ? interpolate(localFrame, [0, 12], [0.7, 1.0], {
              easing: Easing.out(Easing.back(1.5)),
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          : 1.0;

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              opacity,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                background: isActive ? accent : isPast ? '#ffffff44' : '#ffffff22',
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'Inter, system-ui, sans-serif',
                fontSize: 16,
                fontWeight: 700,
                flexShrink: 0,
                transform: `scale(${String(bulletScale)})`,
              }}
            >
              {isPast ? '✓' : String(i + 1)}
            </div>
            <span
              style={{
                fontFamily: 'Inter, system-ui, sans-serif',
                fontSize: isActive ? 20 : 17,
                fontWeight: isActive ? 700 : 400,
                color: '#ffffff',
              }}
            >
              {step}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** Main content area — shows the active step description. */
const ContentArea: React.FC<{
  step: string;
  stepIndex: number;
  frame: number;
  fps: number;
  stepFrames: number;
}> = ({ step, stepIndex, frame, stepFrames }) => {
  const stepStart = stepIndex * stepFrames;
  const localFrame = frame - stepStart;
  const opacity = interpolate(localFrame, [0, 20], [0, 1], {
    easing: Easing.out(Easing.quad),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const translateY = interpolate(localFrame, [0, 20], [30, 0], {
    easing: Easing.out(Easing.quad),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: 540,
        right: 80,
        transform: `translateY(calc(-50% + ${String(translateY)}px))`,
        opacity,
      }}
    >
      <div
        style={{
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 52,
          fontWeight: 700,
          color: '#111111',
          lineHeight: 1.2,
        }}
      >
        Step {String(stepIndex + 1)}
      </div>
      <div
        style={{
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 38,
          fontWeight: 400,
          color: '#333333',
          marginTop: 16,
          lineHeight: 1.4,
        }}
      >
        {step}
      </div>
    </div>
  );
};

/** Module title card. */
const TitleCard: React.FC<{ topic: string; fps: number; frame: number }> = ({
  topic,
  fps,
  frame,
}) => {
  const opacity = interpolate(frame, [0, fps * 0.5], [0, 1], {
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        top: 60,
        left: 540,
        right: 80,
        opacity,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 24,
        fontWeight: 600,
        color: '#666666',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {topic}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Training video composition.
 *
 * Structure:
 * - Left sidebar: brand colour gradient with ordered step navigation
 * - Right content: active step description animates in on each step change
 * - Each step displays for an even slice of the approved render duration
 * - Narration audio plays across the full duration
 */
export const TrainingVideo: React.FC<TrainingVideoProps> = ({
  topic,
  script,
  steps,
  narrationUrl,
  brandColor,
  brandAccent,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Distribute steps evenly across the full composition duration so visual
  // progression stays in sync with the audio narration.
  const stepFrames = steps.length > 0 ? Math.floor(durationInFrames / steps.length) : 60;

  const activeStep = Math.min(
    Math.floor(frame / stepFrames),
    steps.length - 1,
  );

  const currentStep = steps[activeStep] ?? '';

  return (
    <AbsoluteFill style={{ background: '#f8f9fa' }}>
      <Sidebar color={brandColor} />
      <StepList steps={steps} frame={frame} accent={brandAccent} stepFrames={stepFrames} />
      <TitleCard topic={topic} fps={fps} frame={frame} />
      <ContentArea
        step={currentStep}
        stepIndex={activeStep}
        frame={frame}
        fps={fps}
        stepFrames={stepFrames}
      />
      {/* Script is used as narration; display as hidden accessibility text */}
      <div
        aria-hidden="true"
        style={{ display: 'none' }}
      >
        {script}
      </div>
      {narrationUrl && <Audio src={narrationUrl} />}
    </AbsoluteFill>
  );
};
