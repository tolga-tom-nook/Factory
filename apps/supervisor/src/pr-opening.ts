/**
 * PR opening integration with factory-cross-repo GitHub App.
 *
 * Supervisor calls factory-cross-repo after successful verification to open
 * audit PRs. This is a best-effort operation: if factory-cross-repo is
 * unreachable or returns an error, we log a warning and continue (the run
 * is not failed retroactively).
 */

import type { Env } from './index';
import type { StepReceipt } from './executor';
import { ToolRegistry } from '@latimer-woods-tech/agent';

/**
 * Extracted repository information from a step receipt.
 * Used to identify which repos are affected by a run.
 */
interface AffectedRepo {
  app_id: string;
  owner: string;
  repo: string;
}

/**
 * Result of a PR opening attempt.
 */
export interface PROpeningResult {
  ok: boolean;
  pr_url?: string;
  pr_number?: number;
  error?: string;
}

/**
 * Extract affected repositories from step receipts.
 *
 * Tool names are structured as "app_id.path.to.tool". We extract the app_id
 * from the tool name prefix and deduplicate.
 *
 * @param receipts - Step execution results
 * @param tools - ToolRegistry for validation (optional)
 * @returns List of affected repos (deduplicated by app_id)
 */
function extractAffectedRepos(receipts: StepReceipt[], tools: ToolRegistry): AffectedRepo[] {
  const seen = new Set<string>();
  const repos: AffectedRepo[] = [];

  for (const receipt of receipts) {
    // Skip non-mutating steps
    if (receipt.side_effects === 'none') {
      continue;
    }

    // Extract app_id from tool_name: "app_id.path.to.tool"
    const appId = receipt.tool_name.split('.')[0];
    if (!appId) {
      // Malformed tool name; skip (non-critical)
      continue;
    }

    if (seen.has(appId)) {
      continue;
    }
    seen.add(appId);

    // Map app_id to owner/repo using hardcoded mappings
    const repo = mapAppIdToRepo(appId);
    if (repo) {
      repos.push(repo);
    }
  }

  return repos;
}

/**
 * Map app_id to GitHub repo owner/name.
 * This is a placeholder; in production, fetch from GENERATED_CAPABILITIES or a registry.
 */
function mapAppIdToRepo(app_id: string): AffectedRepo | null {
  // Hardcoded mappings for now (Team C to expand)
  const mapping: Record<string, AffectedRepo> = {
    selfprime: { app_id: 'selfprime', owner: 'Latimer-Woods-Tech', repo: 'HumanDesign' },
    capricast: { app_id: 'capricast', owner: 'Latimer-Woods-Tech', repo: 'capricast' },
    coh: { app_id: 'coh', owner: 'Latimer-Woods-Tech', repo: 'coh' },
    // Add more as needed
  };
  return mapping[app_id] ?? null;
}

/**
 * Open a supervisor PR via factory-cross-repo.
 *
 * Called after successful verification and before logging receipts.
 * If factory-cross-repo returns an error or is unreachable, logs a warning
 * and returns gracefully (run is NOT failed).
 *
 * @param receipts - All step execution results from the run
 * @param templateId - Template ID (for audit trail)
 * @param runId - Run ID (unique run identifier)
 * @param description - Issue description (context for the PR)
 * @param tools - ToolRegistry for extracting affected repos
 * @param env - Env with FACTORY_CROSS_REPO_URL and FACTORY_CROSS_REPO_TOKEN
 * @returns PROpeningResult with ok flag and optional pr_url
 */
export async function openSupervisorPR(
  receipts: StepReceipt[],
  templateId: string,
  runId: string,
  description: string,
  tools: ToolRegistry,
  env: Env,
): Promise<PROpeningResult> {
  // Skip PR opening if no mutating steps
  const hasMutations = receipts.some((r) => r.side_effects !== 'none');
  if (!hasMutations) {
    return { ok: true }; // No PR needed for read-only runs
  }

  // Extract affected repos
  const affectedRepos = extractAffectedRepos(receipts, tools);
  if (affectedRepos.length === 0) {
    // No identified repos; skip gracefully
    console.warn('[supervisor] no affected repos identified for PR opening; skipping');
    return { ok: true };
  }

  // Build request payload
  const payload = {
    template_id: templateId,
    run_id: runId,
    description: description.slice(0, 200),
    affected_repos: affectedRepos,
    receipts,
  };

  // Call factory-cross-repo
  const url = env.FACTORY_CROSS_REPO_URL;
  const token = env.FACTORY_CROSS_REPO_TOKEN;

  if (!url || !token) {
    console.warn(
      '[supervisor] FACTORY_CROSS_REPO_URL or FACTORY_CROSS_REPO_TOKEN not configured; skipping PR opening',
    );
    return { ok: true };
  }

  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    response = await fetch(`${url}/api/supervisor/create-pr`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[supervisor] factory-cross-repo fetch failed: ${msg}`);
    return { ok: false, error: `Network error: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }

  // Parse response
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[supervisor] factory-cross-repo response parse failed: ${msg}`);
    return {
      ok: false,
      error: `Response parse error: ${msg} (status: ${response.status})`,
    };
  }

  // Check response status
  if (!response.ok) {
    const prData = responseBody as { ok?: boolean; error?: string };
    const errorMsg = prData?.error ?? `HTTP ${response.status}`;
    console.warn(`[supervisor] factory-cross-repo error: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }

  // Success: extract PR URL
  const prData = responseBody as { ok?: boolean; pr_url?: string; pr_number?: number };
  if (!prData.pr_url) {
    console.warn('[supervisor] factory-cross-repo success but no pr_url in response');
    return { ok: true }; // Still consider it a success; the PR may be in progress
  }

  console.log(`[supervisor] PR opened: ${prData.pr_url}`);
  return { ok: true, pr_url: prData.pr_url, pr_number: prData.pr_number };
}
