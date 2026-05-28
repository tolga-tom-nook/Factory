import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';

export const COMPOSITIONS = new Set([
  'MarketingVideo',
  'TrainingVideo',
  'WalkthroughVideo',
  'EnergyBlueprintVideo',
]);

const WORDS_PER_SECOND = {
  MarketingVideo: 2.8,
  TrainingVideo: 2.7,
  WalkthroughVideo: 2.6,
  EnergyBlueprintVideo: 2.5,
};

const DEFAULT_DURATION_SECONDS = {
  MarketingVideo: 15,
  TrainingVideo: 30,
  WalkthroughVideo: 40,
  EnergyBlueprintVideo: 75,
};

const TECHNICAL_MAX_DURATION_SECONDS = 30 * 60;
const LONG_FORM_CHAPTER_SECONDS = 5 * 60;
const PRIVATE_READING_PRIVACY_MODES = new Set(['private', 'signed', 'scoped']);

const REQUIRED_BASE_FIELDS = [
  'briefKey',
  'composition',
  'topic',
  'learningGoal',
  'keyPoints',
  'forbiddenClaims',
  'toneNotes',
];

export function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

export function getRenderPlan(brief) {
  const plan = isRecord(brief.renderPlan) ? brief.renderPlan : {};
  const durationSeconds = Number(
    plan.durationSeconds ?? brief.durationSeconds ?? brief.duration_seconds ?? DEFAULT_DURATION_SECONDS[brief.composition] ?? 30,
  );
  return {
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0,
    steps: arrayOfStrings(plan.steps ?? brief.steps),
    visualBeats: arrayOfStrings(plan.visualBeats ?? brief.visualBeats),
    screenshotUrls: arrayOfStrings(plan.screenshotUrls ?? brief.screenshotUrls),
    chapters: arrayOfChapterEntries(plan.chapters ?? brief.chapters),
  };
}

export function getDeliveryPolicy(brief) {
  const delivery = isRecord(brief.delivery) ? brief.delivery : {};
  return {
    privacy: String(delivery.privacy ?? brief.privacy ?? '').trim().toLowerCase(),
    transcript: Boolean(delivery.transcript ?? brief.transcript ?? false),
    destination: String(delivery.destination ?? brief.destination ?? '').trim(),
  };
}

export function estimateMinimumDurationSeconds(brief) {
  const count = Number(brief.script_word_count) || wordCount(brief.script);
  const rate = WORDS_PER_SECOND[brief.composition] ?? 2.5;
  return count > 0 ? Math.ceil(count / rate) : 0;
}

export function validateBrief(brief, options = {}) {
  const issues = [];
  const strict = Boolean(options.strict);
  const file = options.file || brief.briefKey || 'unknown';
  const renderPlan = getRenderPlan(brief);
  const delivery = getDeliveryPolicy(brief);
  const scriptWords = Number(brief.script_word_count) || wordCount(brief.script);
  const minimumDurationSeconds = estimateMinimumDurationSeconds(brief);
  const readingDeliverable = isReadingDeliverable(brief);

  for (const field of REQUIRED_BASE_FIELDS) {
    if (isMissingField(brief, field)) {
      addIssue(issues, 'error', 'missing_field', `${field} is required for production readiness`, { field });
    }
  }

  if (!COMPOSITIONS.has(brief.composition)) {
    addIssue(issues, 'error', 'invalid_composition', `Unsupported composition: ${String(brief.composition || '')}`, {
      composition: brief.composition,
    });
  }

  if (!Array.isArray(brief.keyPoints) || brief.keyPoints.length < 2) {
    addIssue(issues, 'error', 'weak_key_points', 'At least two approved key points are required', {
      count: Array.isArray(brief.keyPoints) ? brief.keyPoints.length : 0,
    });
  }

  if (!Array.isArray(brief.forbiddenClaims) || brief.forbiddenClaims.length < 1) {
    addIssue(issues, 'error', 'missing_forbidden_claims', 'At least one forbidden claim is required');
  }

  if (renderPlan.durationSeconds <= 0) {
    addIssue(issues, 'error', 'missing_duration', 'renderPlan.durationSeconds must be a positive number');
  }

  if (renderPlan.durationSeconds > TECHNICAL_MAX_DURATION_SECONDS) {
    addIssue(
      issues,
      'error',
      'duration_exceeds_technical_limit',
      `renderPlan.durationSeconds cannot exceed ${String(TECHNICAL_MAX_DURATION_SECONDS)}s without a dedicated long-form renderer`,
      { durationSeconds: renderPlan.durationSeconds, technicalMaxSeconds: TECHNICAL_MAX_DURATION_SECONDS },
    );
  }

  if (scriptWords > 0 && minimumDurationSeconds > renderPlan.durationSeconds) {
    addIssue(
      issues,
      'error',
      'script_too_long',
      `Script needs at least ${String(minimumDurationSeconds)}s but render plan allows ${String(renderPlan.durationSeconds)}s`,
      { scriptWords, minimumDurationSeconds, durationSeconds: renderPlan.durationSeconds },
    );
  }

  if (brief.composition === 'TrainingVideo') {
    const hasTrainingVisualPlan = renderPlan.steps.length >= 3 || renderPlan.visualBeats.length >= 3;
    if (!hasTrainingVisualPlan) {
      addIssue(
        issues,
        'error',
        'missing_training_visual_plan',
        'TrainingVideo requires at least three renderPlan.steps or renderPlan.visualBeats',
        { steps: renderPlan.steps.length, visualBeats: renderPlan.visualBeats.length },
      );
    }
  }

  if (brief.composition === 'WalkthroughVideo') {
    const hasWalkthroughVisualPlan = renderPlan.screenshotUrls.length > 0 || renderPlan.visualBeats.length >= 3;
    if (!hasWalkthroughVisualPlan) {
      addIssue(
        issues,
        'error',
        'missing_walkthrough_visual_plan',
        'WalkthroughVideo requires screenshotUrls or at least three renderPlan.visualBeats',
      );
    }
  }

  if (brief.composition === 'MarketingVideo' && scriptWords > 80 && renderPlan.visualBeats.length < 3) {
    addIssue(
      issues,
      'error',
      'missing_marketing_visual_plan',
      'Long-form MarketingVideo briefs require at least three renderPlan.visualBeats',
      { visualBeats: renderPlan.visualBeats.length, scriptWords },
    );
  }

  if (renderPlan.durationSeconds >= LONG_FORM_CHAPTER_SECONDS && renderPlan.chapters.length < 2) {
    addIssue(
      issues,
      readingDeliverable ? 'error' : 'warning',
      'long_form_needs_chapters',
      'Long-form videos should include renderPlan.chapters so viewers can navigate the material',
      { durationSeconds: renderPlan.durationSeconds, chapters: renderPlan.chapters.length },
    );
  }

  if (readingDeliverable) {
    if (!PRIVATE_READING_PRIVACY_MODES.has(delivery.privacy)) {
      addIssue(
        issues,
        'error',
        'private_reading_requires_scoped_delivery',
        'Personal or client readings require delivery.privacy to be private, signed, or scoped',
        { privacy: delivery.privacy || null },
      );
    }

    if (!delivery.transcript) {
      addIssue(
        issues,
        'warning',
        'private_reading_should_include_transcript',
        'Personal or client readings should include a transcript for review, accessibility, and trust',
      );
    }
  }

  if (brief.status === 'published') {
    for (const field of ['stream_uid', 'stream_url', 'thumbnail_url', 'rendered_at']) {
      if (isMissingField(brief, field)) {
        addIssue(issues, 'error', 'missing_publish_metadata', `${field} is required for published briefs`, { field });
      }
    }
  }

  if (strict && brief.status === 'planned') {
    addIssue(issues, 'warning', 'planned_not_renderable', 'Planned briefs are not eligible for production render dispatch');
  }

  const blockers = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  return {
    file,
    briefKey: brief.briefKey || basename(file, '.json'),
    composition: brief.composition || null,
    status: blockers.length ? 'blocked' : 'ready',
    sourceStatus: brief.status || 'draft',
    scriptWords,
    durationSeconds: renderPlan.durationSeconds,
    minimumDurationSeconds,
    renderPlan,
    delivery,
    blockers,
    warnings,
    issues,
  };
}

export function loadBriefs(briefDir) {
  return readdirSync(briefDir)
    .filter(name => name.endsWith('.json') && name !== 'training-library.json')
    .map(name => {
      const file = join(briefDir, name);
      const raw = readFileSync(file, 'utf8');
      return {
        file,
        brief: JSON.parse(raw),
      };
    })
    .filter(({ brief }) => Boolean(brief.composition));
}

export function validateBriefDirectory(briefDir, options = {}) {
  const briefKeys = Array.isArray(options.briefKeys) ? new Set(options.briefKeys) : null;
  const results = loadBriefs(briefDir)
    .filter(({ brief }) => !briefKeys || briefKeys.has(brief.briefKey))
    .map(({ file, brief }) => validateBrief(brief, { ...options, file }));
  return summarizeResults(results);
}

export function summarizeResults(results) {
  const blockers = results.flatMap(result => result.blockers.map(issue => ({ ...issue, briefKey: result.briefKey })));
  const warnings = results.flatMap(result => result.warnings.map(issue => ({ ...issue, briefKey: result.briefKey })));
  return {
    checked: results.length,
    ready: results.filter(result => result.status === 'ready').length,
    blocked: results.filter(result => result.status === 'blocked').length,
    blockers,
    warnings,
    results,
  };
}

function addIssue(issues, severity, code, message, details = {}) {
  issues.push({ severity, code, message, details });
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
}

function arrayOfChapterEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => (
      (typeof item === 'string' && item.trim())
      || (isRecord(item) && typeof item.title === 'string' && item.title.trim())
    ))
    .map(item => (typeof item === 'string' ? item.trim() : {
      title: item.title.trim(),
      startSecond: Number.isFinite(Number(item.startSecond)) ? Number(item.startSecond) : undefined,
    }));
}

function isReadingDeliverable(brief) {
  const signals = [
    brief.deliverableType,
    brief.contentType,
    brief.audience,
    brief.delivery?.kind,
  ].map(value => String(value || '').toLowerCase());
  return signals.some(value => ['personal_reading', 'client_reading', 'reading'].includes(value));
}

function isMissingField(record, field) {
  const value = record[field];
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
