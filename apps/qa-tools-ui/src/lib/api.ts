/**
 * API client for qa-tools-worker.
 *
 * All methods inject the stored JWT via the Authorization header.
 * The worker URL is read from NEXT_PUBLIC_WORKER_URL (or defaults to
 * the production worker URL).
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §4
 */

import { getAuthHeader } from '@/lib/auth';
import type {
  AppId,
  AppHealth,
  CreateRunRequest,
  CreateRunResponse,
  Environment,
  ListRunsResponse,
  RunDetail,
  RunFinding,
  RunStatus,
} from '@/lib/types';

/** Base URL for the QA Tools Worker API. */
function workerBase(): string {
  return (
    process.env['NEXT_PUBLIC_WORKER_URL'] ??
    'https://api.qa.latimerwoods.dev'
  );
}

/** Public auth configuration used by the login page. */
export async function getAuthConfig(): Promise<{ googleClientId: string | null; hostedDomain: string | null }> {
  const res = await fetch(`${workerBase()}/auth/config`);
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => String(res.status)));
  return res.json() as Promise<{ googleClientId: string | null; hostedDomain: string | null }>;
}

/** Exchange a Google ID token for a QA Tools session JWT. */
export async function loginWithGoogle(credential: string): Promise<{ token: string; expiresAt: number }> {
  return authFetch('/auth/google', { credential });
}

/** Break-glass bootstrap login, matching the Admin Studio fallback policy. */
export async function loginWithPassword(email: string, password: string): Promise<{ token: string; expiresAt: number }> {
  return authFetch('/auth/login', { email, password });
}

async function authFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${workerBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new ApiError(res.status, text);
  }
  return res.json() as Promise<T>;
}

/** Generic fetch wrapper: adds auth header and throws on non-2xx. */
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${workerBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new ApiError(res.status, text);
  }

  const body: unknown = await res.json();
  return body as T;
}

/** Thrown when the API returns a non-2xx status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API error ${String(status)}: ${body}`);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Fetch health summary for one app/environment combination.
 * Calls GET /apps/:appId/health
 */
export async function getAppHealth(appId: AppId, environment: Environment): Promise<AppHealth> {
  return apiFetch<AppHealth>(`/apps/${appId}/health?environment=${environment}`);
}

/**
 * Fetch health for all 4 apps × both environments in parallel.
 * Returns a flat array of health summaries; errors produce an 'unknown' entry.
 */
export async function getAllAppsHealth(): Promise<AppHealth[]> {
  const APP_IDS: AppId[] = ['selfprime', 'capricast', 'cipherofhealing', 'xicocity'];
  const ENVS: Environment[] = ['production', 'staging'];

  const results = await Promise.allSettled(
    APP_IDS.flatMap((appId) =>
      ENVS.map((environment) => getAppHealth(appId, environment)),
    ),
  );

  return results.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    const appId = APP_IDS[Math.floor(idx / 2)] ?? 'capricast';
    const environment = ENVS[idx % 2] ?? 'production';
    return {
      appId,
      environment,
      statusLabel: 'unknown',
      statusColor: 'gray',
      lastRunAt: null,
      lastRunStatus: null,
      openViolationsCount: 0,
    } satisfies AppHealth;
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * List runs with optional filters.
 * Calls GET /runs
 */
export async function listRuns(params?: {
  appId?: AppId;
  environment?: Environment;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}): Promise<ListRunsResponse> {
  const qs = new URLSearchParams();
  if (params?.appId) qs.set('appId', params.appId);
  if (params?.environment) qs.set('environment', params.environment);
  if (params?.status) qs.set('status', params.status);
  if (params?.limit != null) qs.set('limit', String(params.limit));
  if (params?.offset != null) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<ListRunsResponse>(`/runs${query}`);
}

/**
 * Get run status (with progress for in-flight runs).
 * Calls GET /runs/:id/status
 */
export async function getRunStatus(id: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/runs/${id}/status`);
}

/**
 * Get grouped findings for a completed run.
 * Calls GET /runs/:id/results
 */
export async function getRunResults(id: string): Promise<{
  runId: string;
  appId: AppId;
  environment: Environment;
  results: Record<string, RunFinding[]>;
}> {
  return apiFetch(`/runs/${id}/results`);
}

/**
 * Trigger a new audit run.
 * Calls POST /runs
 */
export async function createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
  return apiFetch<CreateRunResponse>('/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Trigger a rerun of an existing run.
 * Calls POST /runs/:id/rerun
 */
export async function rerunRun(id: string, reason = 'manual-rerun'): Promise<CreateRunResponse> {
  return apiFetch<CreateRunResponse>(`/runs/${id}/rerun`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Create a GitHub issue from the findings of a run.
 * Calls POST /runs/:id/create-issue
 */
export async function createGitHubIssue(
  runId: string,
  options?: { title?: string; assignees?: string[]; labels?: string[] },
): Promise<{ issueUrl: string; issueNumber: number }> {
  return apiFetch(`/runs/${runId}/create-issue`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
}

/**
 * Acknowledge or update the status of a specific finding.
 * Calls PATCH /runs/:id/results/:resultId
 */
export async function updateFindingStatus(
  runId: string,
  resultId: string,
  status: 'acknowledged' | 'fixed' | 'false-positive' | 'open',
): Promise<void> {
  await apiFetch(`/runs/${runId}/results/${resultId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/**
 * Poll a run until it leaves pending/running state.
 * Returns the final RunDetail. Rejects after maxWaitMs (default 5 min).
 */
export async function pollRunUntilComplete(
  id: string,
  {
    intervalMs = 3000,
    maxWaitMs = 5 * 60 * 1000,
    onUpdate,
  }: {
    intervalMs?: number;
    maxWaitMs?: number;
    onUpdate?: (detail: RunDetail) => void;
  } = {},
): Promise<RunDetail> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const detail = await getRunStatus(id);
    onUpdate?.(detail);
    if (detail.status !== 'pending' && detail.status !== 'running') {
      return detail;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Run ${id} did not complete within ${String(Math.floor(maxWaitMs / 1000))}s`);
}
