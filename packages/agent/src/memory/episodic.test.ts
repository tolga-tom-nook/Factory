import { describe, it, expect } from 'vitest';
import {
  recordEpisode,
  getRecentEpisodes,
  getProjectEpisodes,
  getEpisodeSummary,
  type D1Like,
} from './episodic.js';

/**
 * In-memory D1 stub. Captures inserted rows and answers the queries the
 * episodic module issues, mirroring the subset of D1's API we depend on.
 */
function makeD1(): D1Like & { rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: () => {
              if (query.startsWith('INSERT')) {
                rows.push({
                  id: values[0], session_id: values[1], user_id: values[2], project: values[3],
                  summary: values[4], stop_reason: values[5], total_turns: values[6],
                  cost_usd: values[7], tool_names: values[8], created_at: values[9],
                });
              }
              return Promise.resolve({ success: true });
            },
            all: <T = Record<string, unknown>>() => {
              if (query.includes('COUNT(*)')) {
                const userId = values[0];
                const since = values[1] as string;
                const matched = rows.filter((r) => r['user_id'] === userId && String(r['created_at']) >= since);
                const tools = matched.map((r) => String(r['tool_names'])).join(',');
                return Promise.resolve({ results: [{
                  sessions: matched.length,
                  turns: matched.reduce((n, r) => n + Number(r['total_turns']), 0),
                  cost: matched.reduce((n, r) => n + Number(r['cost_usd']), 0),
                  tools: tools || null,
                }] as T[] });
              }
              if (query.includes('user_id = ?')) {
                const matched = rows.filter((r) => r['user_id'] === values[0])
                  .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])));
                return Promise.resolve({ results: matched.slice(0, Number(values[1])) as T[] });
              }
              if (query.includes('project = ?')) {
                const matched = rows.filter((r) => r['project'] === values[0])
                  .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])));
                return Promise.resolve({ results: matched.slice(0, Number(values[1])) as T[] });
              }
              return Promise.resolve({ results: [] as T[] });
            },
          };
        },
      };
    },
  };
}

describe('episodic memory', () => {
  it('recordEpisode inserts a row and returns an id', async () => {
    const db = makeD1();
    const id = await recordEpisode(db, {
      sessionId: 's1', userId: 'u1', project: 'oracle',
      summary: 'Answered a blueprint question', stopReason: 'end',
      totalTurns: 3, costUsd: 0.04, toolNames: ['lookup', 'synthesize'],
    });
    expect(id).toMatch(/^ep_/);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.['project']).toBe('oracle');
  });

  it('getRecentEpisodes returns user episodes newest-first', async () => {
    const db = makeD1();
    await recordEpisode(db, { sessionId: 's1', userId: 'u1', project: 'p', summary: 'first', stopReason: 'end', totalTurns: 1, costUsd: 0.01 });
    await new Promise((r) => setTimeout(r, 5));
    await recordEpisode(db, { sessionId: 's2', userId: 'u1', project: 'p', summary: 'second', stopReason: 'end', totalTurns: 2, costUsd: 0.02 });
    const episodes = await getRecentEpisodes(db, 'u1');
    expect(episodes).toHaveLength(2);
    expect(episodes[0]?.summary).toBe('second');
    expect(episodes[0]?.totalTurns).toBe(2);
  });

  it('getRecentEpisodes parses toolNames JSON back to an array', async () => {
    const db = makeD1();
    await recordEpisode(db, { sessionId: 's1', userId: 'u1', project: 'p', summary: 's', stopReason: 'end', totalTurns: 1, costUsd: 0.01, toolNames: ['a', 'b'] });
    const [ep] = await getRecentEpisodes(db, 'u1');
    expect(ep?.toolNames).toEqual(['a', 'b']);
  });

  it('getRecentEpisodes respects the limit', async () => {
    const db = makeD1();
    for (let i = 0; i < 5; i++) {
      await recordEpisode(db, { sessionId: `s${i}`, userId: 'u1', project: 'p', summary: `${i}`, stopReason: 'end', totalTurns: 1, costUsd: 0.01 });
    }
    expect(await getRecentEpisodes(db, 'u1', 3)).toHaveLength(3);
  });

  it('getProjectEpisodes scopes by project', async () => {
    const db = makeD1();
    await recordEpisode(db, { sessionId: 's1', userId: 'u1', project: 'oracle', summary: 'a', stopReason: 'end', totalTurns: 1, costUsd: 0.01 });
    await recordEpisode(db, { sessionId: 's2', userId: 'u2', project: 'voice', summary: 'b', stopReason: 'end', totalTurns: 1, costUsd: 0.01 });
    const oracle = await getProjectEpisodes(db, 'oracle');
    expect(oracle).toHaveLength(1);
    expect(oracle[0]?.project).toBe('oracle');
  });

  it('getEpisodeSummary aggregates sessions, turns, cost, and unique tools', async () => {
    const db = makeD1();
    await recordEpisode(db, { sessionId: 's1', userId: 'u1', project: 'p', summary: 'a', stopReason: 'end', totalTurns: 3, costUsd: 0.05, toolNames: ['lookup'] });
    await recordEpisode(db, { sessionId: 's2', userId: 'u1', project: 'p', summary: 'b', stopReason: 'end', totalTurns: 2, costUsd: 0.03, toolNames: ['lookup', 'synthesize'] });
    const summary = await getEpisodeSummary(db, 'u1');
    expect(summary.totalSessions).toBe(2);
    expect(summary.totalTurns).toBe(5);
    expect(summary.totalCostUsd).toBeCloseTo(0.08);
    expect(summary.toolsUsed.sort()).toEqual(['lookup', 'synthesize']);
  });

  it('getEpisodeSummary returns zeros for a user with no episodes', async () => {
    const db = makeD1();
    const summary = await getEpisodeSummary(db, 'nobody');
    expect(summary.totalSessions).toBe(0);
    expect(summary.toolsUsed).toEqual([]);
  });

  it('rowToEpisode applies defaults for sparse/null DB rows', async () => {
    const sparseDb: D1Like = {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.resolve({ success: true }),
          all: <T = Record<string, unknown>>() => Promise.resolve({
            results: [{ id: 'ep_x', user_id: null, tool_names: null }] as T[],
          }),
        }),
      }),
    };
    const [ep] = await getRecentEpisodes(sparseDb, 'u1');
    expect(ep?.id).toBe('ep_x');
    expect(ep?.userId).toBeUndefined();   // null → undefined branch
    expect(ep?.sessionId).toBe('');        // missing → '' default
    expect(ep?.project).toBe('');
    expect(ep?.totalTurns).toBe(0);        // missing → 0 default
    expect(ep?.costUsd).toBe(0);
    expect(ep?.toolNames).toEqual([]);     // null tool_names → [] default
  });

  it('rowToEpisode tolerates malformed tool_names JSON (returns [])', async () => {
    const badDb: D1Like = {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.resolve({ success: true }),
          all: <T = Record<string, unknown>>() => Promise.resolve({
            results: [{ id: 'ep_y', session_id: 's', project: 'p', tool_names: '{not json' }] as T[],
          }),
        }),
      }),
    };
    const [ep] = await getRecentEpisodes(badDb, 'u1');
    expect(ep?.toolNames).toEqual([]);
  });

  it('getEpisodeSummary handles an empty result set (no row[0])', async () => {
    const emptyDb: D1Like = {
      prepare: () => ({
        bind: () => ({
          run: () => Promise.resolve({ success: true }),
          all: <T = Record<string, unknown>>() => Promise.resolve({ results: [] as T[] }),
        }),
      }),
    };
    const summary = await getEpisodeSummary(emptyDb, 'u1');
    expect(summary.totalSessions).toBe(0);
    expect(summary.toolsUsed).toEqual([]);
  });

  it('records an episode with no userId (null user_id path)', async () => {
    const db = makeD1();
    const id = await recordEpisode(db, {
      sessionId: 's1', project: 'p', summary: 'anon', stopReason: 'end', totalTurns: 1, costUsd: 0.01,
    });
    expect(id).toMatch(/^ep_/);
    expect(db.rows[0]?.['user_id']).toBeNull();
  });
});
