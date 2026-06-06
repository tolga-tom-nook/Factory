import type { D1Database } from '@cloudflare/workers-types';

/** Blessed threshold — 3 clean merges, zero reverts. */
const BLESSED_MIN_MERGED = 3;
/** Demotion threshold — revert rate above this demotes the template. */
const DEMOTE_REVERT_RATE = 0.2;

interface TemplateStatsRow {
  template_id: string;
  template_version: number;
  runs_attempted: number;
  runs_merged: number;
  runs_reverted: number;
  blessed_at: number | null;
  demoted_at: number | null;
  last_run_at: number | null;
}

export interface TemplateStats {
  templateId: string;
  version: number;
  attempted: number;
  merged: number;
  reverted: number;
  blessed: boolean;
  demoted: boolean;
  lastRunAt: number | null;
}

function toStats(row: TemplateStatsRow): TemplateStats {
  return {
    templateId: row.template_id,
    version: row.template_version,
    attempted: row.runs_attempted,
    merged: row.runs_merged,
    reverted: row.runs_reverted,
    blessed: row.blessed_at !== null && row.demoted_at === null,
    demoted: row.demoted_at !== null,
    lastRunAt: row.last_run_at,
  };
}

export async function getTemplateStats(
  db: D1Database,
  templateId: string,
  version = 1,
): Promise<TemplateStats | null> {
  const row = await db
    .prepare(
      `SELECT * FROM template_stats WHERE template_id = ? AND template_version = ?`,
    )
    .bind(templateId, version)
    .first<TemplateStatsRow>();
  return row ? toStats(row) : null;
}

/** Returns true if the template has crossed the blessed threshold. */
export async function isTemplateBlessed(
  db: D1Database,
  templateId: string,
  version = 1,
): Promise<boolean> {
  const stats = await getTemplateStats(db, templateId, version);
  if (!stats) return false;
  return stats.blessed && !stats.demoted;
}

/**
 * Increment counters after a run completes.
 * `merged` and `reverted` are mutually exclusive — pass the one that applies.
 */
export async function recordRun(
  db: D1Database,
  templateId: string,
  version: number,
  outcome: 'attempted' | 'merged' | 'reverted',
): Promise<TemplateStats> {
  const now = Date.now();

  // Upsert: ensure row exists, then increment.
  await db
    .prepare(
      `INSERT INTO template_stats (template_id, template_version, runs_attempted, runs_merged, runs_reverted, last_run_at)
       VALUES (?, ?, 0, 0, 0, ?)
       ON CONFLICT (template_id, template_version) DO NOTHING`,
    )
    .bind(templateId, version, now)
    .run();

  const col =
    outcome === 'merged'
      ? 'runs_merged = runs_merged + 1, runs_attempted = runs_attempted + 1'
      : outcome === 'reverted'
        ? 'runs_reverted = runs_reverted + 1'
        : 'runs_attempted = runs_attempted + 1';

  await db
    .prepare(`UPDATE template_stats SET ${col}, last_run_at = ? WHERE template_id = ? AND template_version = ?`)
    .bind(now, templateId, version)
    .run();

  // Re-read updated row.
  const updated = (await db
    .prepare(`SELECT * FROM template_stats WHERE template_id = ? AND template_version = ?`)
    .bind(templateId, version)
    .first<TemplateStatsRow>())!;

  // Auto-bless.
  if (
    updated.blessed_at === null &&
    updated.runs_merged >= BLESSED_MIN_MERGED &&
    updated.runs_reverted === 0
  ) {
    await db
      .prepare(`UPDATE template_stats SET blessed_at = ? WHERE template_id = ? AND template_version = ?`)
      .bind(now, templateId, version)
      .run();
    updated.blessed_at = now;
  }

  // Auto-demote: revert rate > 20% (with at least 5 runs so sample is meaningful).
  if (
    updated.demoted_at === null &&
    updated.runs_attempted >= 5 &&
    updated.runs_reverted / updated.runs_attempted > DEMOTE_REVERT_RATE
  ) {
    await db
      .prepare(`UPDATE template_stats SET blessed_at = NULL, demoted_at = ? WHERE template_id = ? AND template_version = ?`)
      .bind(now, templateId, version)
      .run();
    updated.blessed_at = null;
    updated.demoted_at = now;
  }

  return toStats(updated);
}
