import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { MarketingVideo, marketingSchema } from './compositions/MarketingVideo';
import { TrainingVideo, trainingSchema } from './compositions/TrainingVideo';
import { WalkthroughVideo, walkthroughSchema } from './compositions/WalkthroughVideo';
import { EnergyBlueprintVideo, blueprintSchema } from './compositions/EnergyBlueprintVideo';

export const VIDEO_FPS = 30;
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;

/**
 * Remotion composition registry.
 * Each composition maps to a {@link RenderJobType} and is parameterised
 * by brand tokens resolved at render time.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MarketingVideo"
        component={MarketingVideo}
        durationInFrames={450}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(450, Math.ceil((props.durationSeconds || 15) * VIDEO_FPS)),
        })}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
        schema={marketingSchema}
        defaultProps={{
          appId: 'prime_self',
          topic: 'Peak Performance',
          script: 'Raise your standard. Execute without compromise.',
          narrationUrl: '',
          brandColor: '#0066FF',
          brandAccent: '#FF6600',
          logoUrl: '',
          durationSeconds: 15,
          visualBeats: [],
        }}
      />

      <Composition
        id="TrainingVideo"
        component={TrainingVideo}
        durationInFrames={900}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(450, Math.ceil((props.durationSeconds || 30) * VIDEO_FPS)),
        })}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
        schema={trainingSchema}
        defaultProps={{
          appId: 'prime_self',
          topic: 'Daily Discipline Protocol',
          script: 'This is your training protocol.',
          narrationUrl: '',
          brandColor: '#0066FF',
          brandAccent: '#FF6600',
          logoUrl: '',
          steps: ['Wake at 5am', 'Cold shower', 'Review goals', 'Execute the plan'],
          durationSeconds: 30,
        }}
      />

      <Composition
        id="WalkthroughVideo"
        component={WalkthroughVideo}
        durationInFrames={1200}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
        schema={walkthroughSchema}
        defaultProps={{
          appId: 'prime_self',
          topic: 'App Feature Walkthrough',
          script: 'Here is how to use this feature.',
          narrationUrl: '',
          brandColor: '#0066FF',
          brandAccent: '#FF6600',
          logoUrl: '',
          screenshotUrls: [],
        }}
      />

      {/*
       * EnergyBlueprintVideo — 75-second multi-scene composition.
       * Arrival → Revelation → Concept (with body graph) → Breath →
       * Concept → Triad (shadow/gift/siddhi) → Invitation.
       *
       * 2250 frames at 30fps = 75 seconds.
       * Forges: chronos | eros | aether | lux | phoenix | self (default).
       */}
      <Composition
        id="EnergyBlueprintVideo"
        component={EnergyBlueprintVideo}
        durationInFrames={2250}
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
        schema={blueprintSchema}
        defaultProps={{
          appId: 'prime_self',
          topic: 'Your Pattern Has Always Been Here',
          script: 'Before you learned to explain yourself, your pattern was already complete. The moment of your birth encoded something specific — not a destiny imposed from outside, but a frequency that was yours from the beginning. Human Design maps the architecture of that frequency. Nine centers. Sixty-four gates. The way energy moves through you, and the way it does not. What your authority is — the inner signal you can actually trust when the mind goes quiet. This is not a personality type. It is a map of your original pattern. The patterns of how you were built to make decisions, to give energy, to hold it back, to move through the world. When you stop trying to be what you think you should be, and return to what the data actually says — that is when life stops feeling like resistance. That is when it starts to flow.',
          narrationUrl: '',
          brandColor: '#c9a84c',
          brandAccent: '#c9a84c',
          logoUrl: '',
          forgeTheme: 'self',
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
