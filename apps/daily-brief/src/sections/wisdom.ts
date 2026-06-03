/**
 * Wisdom section — LLM-generated opening for the daily brief.
 * Produces a mantra, 3 words of wisdom, and a word of the day.
 * Tone: spiritual grounding meets founder grit meets quiet excellence.
 */

import { complete } from '@latimer-woods-tech/llm';
import type { LlmEnv } from './insights';

export interface WisdomSection {
  /** One short, powerful opening mantra — meant to be read aloud or meditated on */
  mantra: string;
  /** 3 pieces of founder/creator wisdom for the day */
  wisdomLines: string[];
  /** Word of the day */
  wordOfTheDay: {
    word: string;
    pronunciation: string;
    partOfSpeech: string;
    definition: string;
    usageExample: string;
    whyItMatters: string;
  };
}

const SYSTEM_PROMPT = `You are a wise, quiet, deeply grounded guide — part Zen master, part battle-tested founder,
part philosopher. You speak in plain language that lands hard. No clichés. No hustle-bro energy.
The person you're speaking to is a visionary builder: tenacious, creative, building real things that matter.

Output valid JSON matching this exact shape:
{
  "mantra": "<One sentence. Present tense. Grounding. Max 15 words. Should feel like something to breathe in.>",
  "wisdomLines": [
    "<First insight — 1-2 sentences. Specific to the founder/builder mindset.>",
    "<Second insight — 1-2 sentences. Different angle — could be about patience, craft, or momentum.>",
    "<Third insight — 1-2 sentences. Leave them with something to carry through the day.>"
  ],
  "wordOfTheDay": {
    "word": "<An uncommon, powerful English word — preferably one that builders or thinkers would find useful>",
    "pronunciation": "<phonetic pronunciation, e.g. /ˈkæt.ə.lɪst/>",
    "partOfSpeech": "<noun | verb | adjective | adverb>",
    "definition": "<Clear, direct definition in 1-2 sentences>",
    "usageExample": "<1 sentence showing it used naturally in a founder/creator context>",
    "whyItMatters": "<1 sentence on why this word deserves to be in a builder's vocabulary>"
  }
}

Do not include any text before or after the JSON object.
Vary your choices daily — do not repeat the same mantra, insights, or word across days.`;

export async function fetchWisdomSection(env: LlmEnv): Promise<WisdomSection> {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000,
  );

  const result = await complete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Today is day ${dayOfYear} of the year. Generate today's wisdom section. Make it feel fresh and specific to this moment.`,
      },
    ],
    {
      AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      GROQ_API_KEY: env.GROQ_API_KEY,
      GROK_API_KEY: env.GROK_API_KEY,
      VERTEX_ACCESS_TOKEN: env.VERTEX_ACCESS_TOKEN,
      VERTEX_PROJECT: env.VERTEX_PROJECT,
      VERTEX_LOCATION: env.VERTEX_LOCATION,
    },
    { tier: 'fast', temperature: 0.85, maxTokens: 600, maxCostUsd: 0.05, project: 'daily-brief', actor: 'worker', workload: 'wisdom' },
  );

  if (result.error || !result.data?.content) {
    return {
      mantra: 'Build the thing. Ship the thing. Learn from the thing.',
      wisdomLines: [
        'Every great product started as an idea someone almost talked themselves out of.',
        'Momentum is not about speed — it is about not stopping.',
        'The version you ship today is the foundation the future stands on.',
      ],
      wordOfTheDay: {
        word: 'Sonder',
        pronunciation: '/ˈsɒn.dər/',
        partOfSpeech: 'noun',
        definition: 'The realization that each passerby has a life as vivid and complex as your own.',
        usageExample:
          'Building for real users requires a daily practice of sonder — remembering the full human behind every click.',
        whyItMatters: 'Empathy at scale starts with this word.',
      },
    };
  }

  try {
    return JSON.parse(result.data.content) as WisdomSection;
  } catch {
    return {
      mantra: result.data.content.slice(0, 100),
      wisdomLines: [],
      wordOfTheDay: {
        word: 'Persevere',
        pronunciation: '/ˌpɜː.sɪˈvɪər/',
        partOfSpeech: 'verb',
        definition: 'Continue in a course of action even in the face of difficulty.',
        usageExample: 'The founders chose to persevere through three pivots before finding product-market fit.',
        whyItMatters: 'The most underrated competitive advantage.',
      },
    };
  }
}
