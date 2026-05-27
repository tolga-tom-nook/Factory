/**
 * Browser-agent HTTP client for qa-tools-worker.
 *
 * Calls the browser-agent Cloud Run service's /visual-review endpoint
 * (with runAxe: true) for Phase 1 accessibility audits + screenshots.
 * Auth uses Google OIDC ID tokens via @latimer-woods-tech/browser.
 *
 * See: apps/browser-agent/src/index.ts for the full endpoint interface.
 */

import { mintBrowserAgentIdToken } from '@latimer-woods-tech/browser';
import { InternalError } from '@latimer-woods-tech/errors';
import type { VisualReviewResult, ScenarioStep, Profile } from '../types.js';
import { PROFILE_DEFAULTS } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional authentication credentials for authenticated audit scenarios. */
export interface AuditAuth {
  /** Login username or email. */
  username: string;
  /** Login password. */
  password: string;
  /** Optional TOTP secret (base32) for MFA flows. */
  mfaSecret?: string;
}

export interface AuditDispatchParams {
  targetUrl: string;
  profile: Profile;
  steps?: ScenarioStep[];
  runAxe?: boolean;
  /** When provided, browser-agent will perform a login flow before auditing. */
  auth?: AuditAuth;
}

export interface AuditDispatchResult {
  visualReview: VisualReviewResult;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Token cache (per Worker instance — avoids minting a new token every run)
// ---------------------------------------------------------------------------

interface CachedToken {
  value: string;
  expiresAt: number;  // Unix epoch ms
}

let _tokenCache: CachedToken | null = null;

async function getIdToken(saKey: string, audience: string): Promise<string> {
  const now = Date.now();
  // Refresh 5 minutes before expiry (tokens are 1h)
  if (_tokenCache && _tokenCache.expiresAt > now + 5 * 60 * 1000) {
    return _tokenCache.value;
  }
  const token = await mintBrowserAgentIdToken(saKey, audience);
  // Google ID tokens are valid for 1 hour
  _tokenCache = { value: token, expiresAt: now + 55 * 60 * 1000 };
  return token;
}

// ---------------------------------------------------------------------------
// Main dispatch function
// ---------------------------------------------------------------------------

/**
 * Dispatches an audit to the browser-agent /visual-review endpoint.
 * Returns the raw VisualReviewResult plus wall-clock duration.
 *
 * Timeout is derived from the audit profile. On timeout or HTTP error,
 * throws InternalError so the caller can update the run status to 'error'.
 */
export async function dispatchAudit(
  agentUrl: string,
  agentAudience: string,
  saKey: string,
  params: AuditDispatchParams,
): Promise<AuditDispatchResult> {
  const profile = PROFILE_DEFAULTS[params.profile];
  // Add 15s margin over profile timeout for browser-agent round-trip overhead
  const requestTimeoutMs = profile.timeoutMs + 15_000;

  const token = await getIdToken(saKey, agentAudience);
  const baseUrl = agentUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/visual-review`;

  const payload: Record<string, unknown> = {
    url: params.targetUrl,
    runAxe: params.runAxe !== false,
    viewports: [{ name: 'desktop', width: 1280, height: 720 }],
    captureConsole: true,
    statusThreshold: 400,
  };

  if (params.steps && params.steps.length > 0) {
    // Filter to only the step types browser-agent supports
    payload['steps'] = params.steps.filter((s) =>
      ['goto', 'fill', 'click', 'wait', 'waitForSelector'].includes(s.action),
    );
  }

  if (params.auth) {
    // Pass credentials to browser-agent for authenticated scenarios.
    // The browser-agent uses these to perform a login flow before the audit.
    payload['auth'] = {
      username: params.auth.username,
      password: params.auth.password,
      ...(params.auth.mfaSecret ? { mfaSecret: params.auth.mfaSecret } : {}),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  const startMs = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      throw new InternalError(`browser-agent returned ${String(response.status)}: ${text}`);
    }

    const jsonBody: unknown = await response.json();
    const result = jsonBody as VisualReviewResult;
    return { visualReview: result, durationMs: Date.now() - startMs };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new InternalError(
        `browser-agent timed out after ${String(requestTimeoutMs)}ms for profile '${params.profile}'`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Result normalization helpers
// ---------------------------------------------------------------------------

/**
 * Maps an axe impact string to our internal severity enum.
 * Null impact (axe best-practice violations) maps to 'moderate'.
 */
export function mapAxeImpact(impact: string | null): string {
  switch (impact) {
    case 'critical': return 'critical';
    case 'serious':  return 'serious';
    case 'moderate': return 'moderate';
    case 'minor':    return 'minor';
    default:         return 'moderate';
  }
}

/**
 * Builds a human-readable remediation hint from an axe violation.
 * Combines the help text with the helpUrl for developer context.
 */
export function buildRemediationHint(help: string, helpUrl: string): string {
  if (!helpUrl) return help;
  return `${help} — ${helpUrl}`;
}
