-- @latimer-woods-tech/agent — episodic memory schema.
-- Apply once per consumer D1 database:
--   wrangler d1 execute <DB> --file=node_modules/@latimer-woods-tech/agent/migrations/0001_agent_sessions.sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  user_id      TEXT,
  project      TEXT NOT NULL,
  summary      TEXT NOT NULL,
  stop_reason  TEXT NOT NULL,
  total_turns  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  tool_names   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user    ON agent_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions (project, created_at DESC);
