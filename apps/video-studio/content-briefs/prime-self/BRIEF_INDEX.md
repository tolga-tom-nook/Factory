# Prime Self Content Brief Library — Index

This directory contains the full content brief library for Prime Self video production. Briefs are organized into six strategic categories, each addressing a distinct viewer moment.

The video pipeline is operational. First live video: <https://capricast.com/watch/5209dd21-71a8-4ee4-afeb-0c030ade1a70>.

---

## Six-Category Strategy

1. **Landing / Welcome** — one anchor video for the homepage (60–90s)
2. **User Guide Series** — organized by viewer moment of need, not feature order
3. **Core Philosophy Series** — the structural arc, mapped to the six overtones (Polarity → Trinity → Quaternity → Pentad → Hexad → Heptad)
4. **Synthesis Moments** — cross-system convergence (the moat)
5. **Type-Specific Onboarding** — short personalized welcomes per type
6. **Temporal / Cyclical** — eclipses, transits, the wheel of becoming

---

## Category 1 — Landing / Welcome

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `homepage-welcome` | See Your Pattern Clearly | 75s | (default) | The first-time visitor hook — what Prime Self gives you and why starting now is easy. |

---

## Category 2 — User Guide Series

Organized by the moment the viewer needs the video, not by feature order.

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `user-guide-first-look-at-your-blueprint` | Your First Look at Your Blueprint | 75s | aether | The body graph is a map. Centers, channels, gates — permission to take it slowly. |
| `user-guide-reading-the-centers` | Reading the Centers: Defined and Undefined | 90s | chronos | Defined broadcasts. Undefined receives. Neither is better. Both are the architecture. |
| `user-guide-working-with-transits` | Working With Transits | 75s | aether | Transits are weather, not destiny. A light-touch approach to the daily view. |
| `user-guide-relationships-overlay` | The Relationships Overlay | 90s | eros | Electromagnetic. Companionship. Amplification. The three dynamics when blueprints meet. |
| `user-guide-the-life-diary` | The Life Diary: Why Your Story Deepens the Reading | 75s | phoenix | The temporal-validation layer — your history cross-referenced with the transits of those days. |

---

## Category 3 — Core Philosophy Series

The structural arc, mapped to the six overtones. Read in order.

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `philosophy-1-polarity` | Polarity: The First Overtone | 90s | aether | Octave 2:1. Defined and undefined as two registers of one architecture. |
| `philosophy-2-trinity` | Trinity: The Second Overtone | 90s | lux | Perfect Fifth 3:2. Type, Strategy, Authority — three points make a plane. |
| `philosophy-3-quaternity` | Quaternity: The Third Overtone | 75s | chronos | Fourth 4:3. Four motors, four awareness centers, four pure types — and the quintaEssentia. |
| `philosophy-4-pentad` | Pentad: The Fourth Overtone | 90s | phoenix | Major Third 5:4. Five Forges — and the K₁,₄ → C₅ topological pivot from struggle to mastery. |
| `philosophy-5-hexad` | Hexad: The Fifth Overtone | 90s | eros | Minor Third 6:5. Six Knowledges. Hexagonal optimality — nature's chosen packing pattern. |
| `philosophy-6-heptad` | Heptad: The Sixth Overtone | 90s | self | Major Seventh 15:8. Synthesis as the seventh that holds the six. |

---

## Category 4 — Synthesis Moments (The Moat)

Cross-system convergence. Each video focuses on one specific resonance.

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `synthesis-gate-key-resonance` | When the Gate and the Frequency Key Tell the Same Story | 75s | lux | Gate 41 and Frequency Key 41 — two systems naming one territory. |
| `synthesis-sabian-confirms-gate` | When the Sabian Symbol Confirms the Gate | 75s | chronos | 360 Sabian symbols meeting 64 Human Design gates at the same archetypal motion. |
| `synthesis-nakshatra-meets-chart` | When the Vedic Nakshatra Confirms the Chart | 75s | aether | Vedic lunar mansions and Human Design emotional signatures pointing to the same lunar truth. |
| `synthesis-data-confirms-chart` | When the Data Confirms the Chart | 90s | phoenix | The lived-evidence layer — Big Five psychometric scores meeting structural signatures. |

---

## Category 5 — Type-Specific Onboarding

Surfaced the moment the viewer's type is identified.

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `type-welcome-generator` | Welcome, Generator | 60s | phoenix | Response over initiation. Sacral as compass. Satisfaction as signature. |
| `type-welcome-manifesting-generator` | Welcome, Manifesting Generator | 60s | eros | Multi-passionate. Response plus speed. Inform before you pivot. |
| `type-welcome-projector` | Welcome, Projector | 60s | lux | Invitation as strategy. Perception as gift. Success as signature. |
| `type-welcome-manifestor` | Welcome, Manifestor | 60s | phoenix | Initiator. Direct motor-to-throat current. Informing as the practice. |
| `type-welcome-reflector` | Welcome, Reflector | 75s | self | The lunar cycle as decision-making instrument. The cosmic mirror as gift. |

---

## Category 6 — Temporal / Cyclical

| Brief Key | Title | Length | Forge | Synopsis |
|---|---|---|---|---|
| `daily-transits-guide` | Using Daily Transits Without Overcomplicating Your Day | 90s | (default) | The shipped temporal anchor — transits as weather, light-touch reflection. |
| `temporal-eclipse-season` | Eclipse Season Through Your Chart | 75s | phoenix | What eclipses do collectively, and how to read them through your own gates. |
| `temporal-quarter-of-civilization` | The Four Quarters of the Wheel | 90s | chronos | Initiation, Civilization, Duality, Mutation — and how your incarnation cross maps to one. |

---

## Forge Tonality Reference

The Forge atmosphere selected for each brief is rendered by Remotion's `ForgeAtmosphere` component. Each Forge is one of five (plus `self`) and signals the emotional/structural register of the piece.

| Forge | Register | Use When |
|---|---|---|
| `chronos` | time, depth, slow grind | Structural / historical / cyclical themes |
| `eros` | passion, intimacy, connection | Relationships, attraction, magnetism |
| `aether` | universal connection, openness | Introductions, weather, breath |
| `lux` | illumination, clarity, revelation | Recognition, insight, the moment something lands |
| `phoenix` | rebirth, transformation, fire | Initiation, life events, breakthrough |
| `self` | pure deep space, silence | Reflectors, capstone synthesis, the seventh |

---

## Schema Notes

All briefs in this directory share a common JSON schema. New briefs (added in this batch) carry both the canonical existing fields (`briefKey`, `composition`, `topic`, `script`, `forgeTheme`, `brandColor`, etc.) and the strategy-layer fields (`category`, `length_seconds`, `narration_script`, `scene_directives`, `output_metadata`) — keeping forward compatibility with the existing render pipeline while exposing the strategic taxonomy for indexing and dispatch.

`composition` is one of: `EnergyBlueprintVideo`, `MarketingVideo`, `TrainingVideo`, `WalkthroughVideo`. The seven-scene arc (`arrival → revelation → concept → breath → concept → triad → invitation`) is the default for `EnergyBlueprintVideo`; `scene_directives` may override the default scene layout per brief.

---

_Index updated: 2026-05-21._
