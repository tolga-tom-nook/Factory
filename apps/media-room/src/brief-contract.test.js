import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResults, estimateMinimumDurationSeconds, validateBrief, wordCount } from './brief-contract.js';

const baseBrief = {
  briefKey: 'sample-training',
  composition: 'TrainingVideo',
  topic: 'Sample Training',
  learningGoal: 'Viewer can complete one task.',
  keyPoints: ['Open the page', 'Follow the prompt'],
  forbiddenClaims: ['guaranteed outcome'],
  toneNotes: 'Clear and grounded.',
  script: 'Open the page. Read the guidance. Choose one next step.',
  renderPlan: {
    durationSeconds: 30,
    steps: ['Open the page', 'Read the guidance', 'Choose one next step'],
  },
};

test('wordCount ignores whitespace-only content', () => {
  assert.equal(wordCount('  one   two\nthree  '), 3);
  assert.equal(wordCount('   '), 0);
});

test('estimateMinimumDurationSeconds uses composition pacing', () => {
  const brief = { ...baseBrief, script_word_count: 270 };
  assert.equal(estimateMinimumDurationSeconds(brief), 100);
});

test('validateBrief accepts a timed training brief with visual steps', () => {
  const result = validateBrief(baseBrief);
  assert.equal(result.status, 'ready');
  assert.equal(result.blockers.length, 0);
});

test('validateBrief blocks scripts that cannot fit target duration', () => {
  const result = validateBrief({
    ...baseBrief,
    script_word_count: 215,
    renderPlan: { ...baseBrief.renderPlan, durationSeconds: 30 },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'script_too_long'), true);
});

test('validateBrief blocks training videos without a visual plan', () => {
  const result = validateBrief({
    ...baseBrief,
    renderPlan: { durationSeconds: 30, steps: [] },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'missing_training_visual_plan'), true);
});

test('validateBrief blocks walkthrough videos without screenshots or visual beats', () => {
  const result = validateBrief({
    ...baseBrief,
    composition: 'WalkthroughVideo',
    renderPlan: { durationSeconds: 40 },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'missing_walkthrough_visual_plan'), true);
});

test('validateBrief blocks long marketing videos without visual beats', () => {
  const result = validateBrief({
    ...baseBrief,
    composition: 'MarketingVideo',
    script_word_count: 100,
    renderPlan: { durationSeconds: 45, visualBeats: [] },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'missing_marketing_visual_plan'), true);
});

test('validateBrief allows long-form teaching when duration fits and chapters exist', () => {
  const result = validateBrief({
    ...baseBrief,
    script_word_count: 900,
    renderPlan: {
      durationSeconds: 420,
      steps: ['Orient', 'Read the chart', 'Practice'],
      chapters: [
        { title: 'Orientation', startSecond: 0 },
        { title: 'Chart reading', startSecond: 120 },
        { title: 'Practice', startSecond: 300 },
      ],
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.blockers.length, 0);
});

test('validateBrief requires scoped delivery for personal readings', () => {
  const result = validateBrief({
    ...baseBrief,
    deliverableType: 'personal_reading',
    script_word_count: 1200,
    renderPlan: {
      durationSeconds: 600,
      steps: ['Orient', 'Read the chart', 'Synthesize'],
      chapters: ['Orientation', 'Chart architecture', 'Synthesis'],
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'private_reading_requires_scoped_delivery'), true);
});

test('validateBrief accepts private readings with transcript and chapters', () => {
  const result = validateBrief({
    ...baseBrief,
    deliverableType: 'client_reading',
    script_word_count: 1200,
    renderPlan: {
      durationSeconds: 600,
      steps: ['Orient', 'Read the chart', 'Synthesize'],
      chapters: ['Orientation', 'Chart architecture', 'Synthesis'],
    },
    delivery: {
      privacy: 'signed',
      transcript: true,
      destination: 'client_portal',
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.blockers.length, 0);
});

test('validateBrief blocks renders beyond the shared technical ceiling', () => {
  const result = validateBrief({
    ...baseBrief,
    script_word_count: 5400,
    renderPlan: {
      durationSeconds: 1900,
      steps: ['Orient', 'Read', 'Synthesize'],
      chapters: ['Orientation', 'Reading', 'Synthesis'],
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers.some(issue => issue.code === 'duration_exceeds_technical_limit'), true);
});

test('summarizeResults reports ready and blocked counts', () => {
  const ready = validateBrief(baseBrief);
  const blocked = validateBrief({
    ...baseBrief,
    script_word_count: 215,
    renderPlan: { ...baseBrief.renderPlan, durationSeconds: 30 },
  });
  const summary = summarizeResults([ready, blocked]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.ready, 1);
  assert.equal(summary.blocked, 1);
});
