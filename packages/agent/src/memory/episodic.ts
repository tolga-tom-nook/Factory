/**
 * Episodic memory — D1 ledger of prior agent sessions.
 *
 * Persists a summary of each completed session so future sessions can query
 * "what did this user/agent do before?" without replaying full message history.
 * Enables personalisation, continuity across sessions, and agent self-reflection.
 *
 * Schema (apply once per D1 database):
 * ```sql
 * CREATE TABLE IF NOT EXISTS agent_sessions (
 *   id           TEXT PRIMARY KEY,
 *   session_id   TEXT NOT NULL,
 *   user_id      TEXT,
 *   project      TEXT NOT NULL,
 *   summary      TEXT NOT NULL,
 *   stop_reason  TEXT NOT NULL,
 *   total_turns  INTEGER NOT NULL DEFAULT 0,
 *   cost_usd     REAL NOT NULL DEFAULT 0,
 *   tool_names   TEXT,          -- JSON array of tool names invoked
 *   created_at   TEXT NOT NULL
 * );
 * CREATE INDEX IF NOT EXISTS idx_agent_sessions_user   ON agent_sessions (user_id, created_at DESC);
 * CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions (project, created_at DESC);
 * ```
 */

/** Minimal D1 binding shape — matches Cloudflare `D1Database`. */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ success: boolean }>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

/** A persisted episode record. */
export interface Episode {
  id: string;
  sessionId: string;
  userId?: string;
  project: string;
  summary: string;
  stopReason: string;
  totalTurns: number;
  costUsd: number;
  toolNames: string[];
  createdAt: string;
}

function nanoid(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parameters for recording a new episode. */
export interface RecordEpisodeParams {
  sessionId: string;
  userId?: string;
  project: string;
  /** Human-readable summary of what the session accomplished. */
  summary: string;
  stopReason: string;
  totalTurns: number;
  costUsd: number;
  toolNames?: string[];
}

/**
 * Records a completed session as an episode in D1.
 * Called at the end of a session (after `runSession` returns).
 *
 * @returns The generated episode `id`.
 */
export async function recordEpisode(db: D1Like, params: RecordEpisodeParams): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agent_sessions
         (id, session_id, user_id, project, summary, stop_reason, total_turns, cost_usd, tool_names, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.sessionId,
      params.userId ?? null,
      params.project,
      params.summary,
      params.stopReason,
      params.totalTurns,
      params.costUsd,
      JSON.stringify(params.toolNames ?? []),
      now,
    )
    .run();
  return id;
}

/**
 * Retrieves the most recent episodes for a user, newest first.
 * Useful for injecting prior-session context into a new session's system prompt.
 */
export async function getRecentEpisodes(
  db: D1Like,
  userId: string,
  limit = 10,
): Promise<Episode[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Record<string, unknown>>();
  return results.map(rowToEpisode);
}

/**
 * Retrieves the most recent episodes for a project (all users).
 * Useful for project-level pattern analysis.
 */
export async function getProjectEpisodes(
  db: D1Like,
  project: string,
  limit = 20,
): Promise<Episode[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM agent_sessions WHERE project = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(project, limit)
    .all<Record<string, unknown>>();
  return results.map(rowToEpisode);
}

/**
 * Summarises recent usage: total sessions, turns, cost, and unique tools.
 */
export async function getEpisodeSummary(
  db: D1Like,
  userId: string,
  sinceIso?: string,
): Promise<{ totalSessions: number; totalTurns: number; totalCostUsd: number; toolsUsed: string[] }> {
  const since = sinceIso ?? '1970-01-01T00:00:00.000Z';
  const row = await db
    .prepare(
      `SELECT COUNT(*) as sessions, SUM(total_turns) as turns, SUM(cost_usd) as cost, GROUP_CONCAT(tool_names) as tools
       FROM agent_sessions WHERE user_id = ? AND created_at >= ?`,
    )
    .bind(userId, since)
    .all<{ sessions: number; turns: number; cost: number; tools: string | null }>();
  const r = row.results[0] ?? { sessions: 0, turns: 0, cost: 0, tools: null };
  const toolsUsed = r.tools
    ? [...new Set((JSON.parse(`[${r.tools}]`) as string[]).flat())]
    : [];
  return {
    totalSessions: r.sessions ?? 0,
    totalTurns: r.turns ?? 0,
    totalCostUsd: r.cost ?? 0,
    toolsUsed,
  };
}

function rowToEpisode(r: Record<string, unknown>): Episode {
  return {
    id: String(r['id'] ?? ''),
    sessionId: String(r['session_id'] ?? ''),
    userId: r['user_id'] != null ? String(r['user_id']) : undefined,
    project: String(r['project'] ?? ''),
    summary: String(r['summary'] ?? ''),
    stopReason: String(r['stop_reason'] ?? ''),
    totalTurns: Number(r['total_turns'] ?? 0),
    costUsd: Number(r['cost_usd'] ?? 0),
    toolNames: (() => { try { return JSON.parse(String(r['tool_names'] ?? '[]')) as string[]; } catch { return []; } })(),
    createdAt: String(r['created_at'] ?? ''),
  };
}
