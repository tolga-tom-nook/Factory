import type { Env } from './index';
import { matchTemplate } from './planner/match';
import { parameterize } from './planner/parameterize';
import { loadTemplates } from './planner/load';
import { listMemoryKeys, readMemory, writeMemory } from './memory/d1';
import { ToolRegistry } from '@latimer-woods-tech/agent';
import { GENERATED_CAPABILITIES } from './capabilities.generated';
import { getTemplateStats, recordRun } from './stats';
import { executePlan } from './executor';
import { runVerifier } from './verifier';
import { openSupervisorPR } from './pr-opening';
// All GitHub API helpers (fetchApprovedIssues, postPlanComment, addLabel,
// getPlanApproval) use AbortSignal.timeout(10_000) — see tools/github.ts.
// sendDigest uses AbortSignal.timeout(5_000) — see tools/pushover.ts.
// getInstallationToken uses AbortSignal.timeout(10_000) — see tools/github-auth.ts.
import {
  fetchApprovedIssues,
  postPlanComment,
  addLabel,
  getPlanApproval,
  formatPlanComment,
  countOpenIssuesWithLabel,
  countOpenPullRequests,
} from './tools/github';
import { sendDigest } from './tools/pushover';
import { getInstallationToken } from './tools/github-auth';
import { registerCoreSupervisorTools } from './tools/core';

/** Maximum issues processed in a single scheduled run. */
const PER_RUN_ISSUE_CAP = 5;

/**
 * Wall-clock deadline for a single handleScheduled execution (ms).
 * Durable Object alarm handlers in the Workers Paid plan are not subject to
 * the 30 s CPU limit that applies to regular Worker requests. The alarm
 * handler can run for up to 15 minutes. However, a per-run deadline is still
 * enforced here as a defensive bound: the loop checks elapsed time before
 * each issue and exits early if the deadline is approached, rather than
 * relying solely on PER_RUN_ISSUE_CAP or individual AbortSignal timeouts.
 * Set to match the lock TTL (10 min) — prior value of 25 s left < 18 s of
 * usable time after GitHub token fetch + lock acquire.
 */
const ALARM_SOFT_DEADLINE_MS = 600_000;

/** Lock key used to prevent concurrent supervisor runs. */
const LOCK_KEY = 'supervisor-run';

/** TTL for the run lock in milliseconds (10 minutes). */
const LOCK_TTL_MS = 600_000;

/** Phrase that marks an issue as ineligible for supervisor processing. */
const LOCKOUT_PHRASE = 'wordis-bond';

function summarizeSmokeResult(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (value === null) return { type: 'null' };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() };
  return { type: typeof value };
}

interface PlanRecord {
  commentId: number;
  templateId: string;
  postedAt: number;
}

export class SupervisorDO {
  private state: DurableObjectState;
  private env: Env;
  private tools: ToolRegistry;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.tools = new ToolRegistry();
    registerCoreSupervisorTools(this.tools, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /health':
          return await this.handleHealth();
        case 'GET /state':
          return await this.handleState();
        case 'GET /aos/status':
          return await this.handleAosStatus();
        case 'GET /capabilities':
          return await this.handleCapabilities();
        case 'GET /tools/read-only-smoke':
          return await this.handleReadOnlySmoke();
        case 'POST /scheduled':
          return await this.handleScheduled();
        case 'POST /plan':
          return await this.handlePlan(request);
        case 'POST /run':
          return await this.handleRun(request);
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      // Log-only: message is truncated and never sent to the client.
      // Response body is a generic sentinel — no internal details exposed.
      const logMsg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.error('[supervisor.do] unhandled error (logged, not returned):', logMsg);
      return new Response(
        JSON.stringify({ error: 'internal error' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  private handleHealth(): Response {
    return Response.json({
      ok: true,
      phase: 'SUP-4',
      tools_registered: this.tools.list().length,
      tool_names: this.tools.list().map((tool) => tool.name),
      tool_side_effects: this.tools.list().reduce((counts, tool) => {
        counts[tool.side_effects] = (counts[tool.side_effects] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>),
      app_count: GENERATED_CAPABILITIES.length,
      capability_count: GENERATED_CAPABILITIES.reduce((n, a) => n + a.capabilities.length, 0),
    });
  }

  private async handleState(): Promise<Response> {
    const lastRun = await readMemory(this.env.MEMORY, 'last_run');
    return Response.json({
      lastRun,
      toolCount: this.tools.list().length,
      toolNames: this.tools.list().map((t) => t.name),
      capabilities: {
        appCount: GENERATED_CAPABILITIES.length,
        apps: GENERATED_CAPABILITIES.map((a) => ({
          app: a.app,
          tiers_allowed: a.tiers_allowed,
          capability_count: a.capabilities.length,
        })),
      },
    });
  }

  private async handleAosStatus(): Promise<Response> {
    const lastRun = await readMemory(this.env.MEMORY, 'last_run');
    const planKeys = await listMemoryKeys(this.env.MEMORY, 'plan:');
    const approvedKeys = await listMemoryKeys(this.env.MEMORY, 'approved:');
    const approvedIssueNumbers = new Set(approvedKeys.map((key) => key.replace('approved:', '')));
    const pendingPlanApprovalIssues = planKeys
      .map((key) => key.replace('plan:', ''))
      .filter((issueNumber) => issueNumber && !approvedIssueNumbers.has(issueNumber))
      .slice(0, 20);

    const blockedApprovalRow = await this.env.MEMORY
      .prepare(`SELECT COUNT(*) AS count FROM supervisor_steps WHERE awaiting_approval IS NOT NULL`)
      .first<{ count: number }>()
      .catch(() => ({ count: 0 }));

    const recentRuns = await this.env.MEMORY
      .prepare(
        `SELECT id, template_id, template_version, status, dry_run, pr_url, pr_open_error, started_at, finished_at
         FROM supervisor_runs
         ORDER BY started_at DESC
         LIMIT 5`,
      )
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] }));

    const templateStats = await this.env.MEMORY
      .prepare(
        `SELECT template_id, template_version, runs_attempted, runs_merged, runs_reverted, blessed_at, demoted_at, last_run_at
         FROM template_stats
         ORDER BY last_run_at DESC
         LIMIT 20`,
      )
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] }));

    let github: Record<string, unknown> = { ok: false, error: 'not checked' };
    try {
      const ghToken = await getInstallationToken(
        this.env.FACTORY_APP_ID,
        this.env.FACTORY_APP_PRIVATE_KEY,
        this.env.FACTORY_APP_INSTALLATION_ID,
      );
      const [noTemplateQueue, openPullRequests] = await Promise.all([
        countOpenIssuesWithLabel(ghToken, 'supervisor:no-template'),
        countOpenPullRequests(ghToken),
      ]);
      github = { ok: true, noTemplateQueue, openPullRequests };
    } catch (err) {
      github = {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      };
    }

    const perRunCapCents = Number.parseInt(this.env.PER_RUN_CAP_CENTS ?? '500', 10);

    return Response.json({
      ok: true,
      kind: 'factory-autonomous-os-status',
      at: new Date().toISOString(),
      lastRun,
      budget: {
        perRunCapCents,
        perRunCapUsd: `$${(perRunCapCents / 100).toFixed(2)}`,
        source: this.env.PER_RUN_CAP_CENTS ? 'PER_RUN_CAP_CENTS' : 'default-calibration-cap',
      },
      approvals: {
        pendingPlanApprovalCount: pendingPlanApprovalIssues.length,
        pendingPlanApprovalIssues,
        blockedStepApprovalCount: blockedApprovalRow?.count ?? 0,
      },
      github,
      templates: {
        tracked: templateStats.results.length,
        stats: templateStats.results,
      },
      recentRuns: recentRuns.results,
      gates: {
        green: 'execute only through guarded tools; blessed template stats exposed here',
        yellow: 'plan approval required before assisted execution',
        red: 'route-and-stop; needs human owner',
        noTemplate: 'label supervisor:no-template and stop',
      },
    });
  }

  private async handleReadOnlySmoke(): Promise<Response> {
    const requiredTools = [
      'supervisor.health.snapshot',
      'registry.capabilities.list',
      'template.list',
      'state.lastRun.read',
    ];
    const invoked: Array<{ name: string; side_effects: string; ok: boolean; execution_ms: number; result_summary?: Record<string, unknown> }> = [];

    for (const name of requiredTools) {
      const tool = this.tools.get(name);
      if (!tool) {
        return Response.json({ ok: false, error: `required tool not registered: ${name}`, invoked }, { status: 500 });
      }
      if (tool.side_effects !== 'none') {
        return Response.json({ ok: false, error: `tool is not readonly: ${name}`, side_effects: tool.side_effects, invoked }, { status: 500 });
      }

      const started = Date.now();
      const result = await tool.invoke({ smoke: true });
      const executionMs = Date.now() - started;
      const resultSummary = result.ok ? summarizeSmokeResult(result.result) : undefined;
      invoked.push({ name, side_effects: tool.side_effects, ok: result.ok, execution_ms: executionMs, result_summary: resultSummary });

      if (!result.ok) {
        return Response.json({ ok: false, error: result.error, failed_tool: name, invoked }, { status: 500 });
      }
    }

    const registeredTools = this.tools.list();
    const toolSideEffects = registeredTools.reduce((counts, tool) => {
      counts[tool.side_effects] = (counts[tool.side_effects] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    const writeCapableTools = registeredTools
      .filter((tool) => tool.side_effects === 'write-app' || tool.side_effects === 'write-external')
      .map((tool) => tool.name);

    return Response.json({
      ok: true,
      kind: 'supervisor-readonly-smoke',
      tools_invoked: invoked.length,
      invoked,
      registered: {
        tools_registered: registeredTools.length,
        tool_names: registeredTools.map((tool) => tool.name),
      },
      tool_side_effects: toolSideEffects,
      write_capable_tools: writeCapableTools,
    });
  }

  private handleCapabilities(): Response {
    return Response.json({ capabilities: GENERATED_CAPABILITIES });
  }

  private async handleScheduled(): Promise<Response> {
    const runId = `run-${Date.now()}`;
    const errors: string[] = [];
    let matched = 0;
    let noTemplate = 0;
    let approved = 0;

    let ghToken: string;
    try {
      ghToken = await getInstallationToken(
        this.env.FACTORY_APP_ID,
        this.env.FACTORY_APP_PRIVATE_KEY,
        this.env.FACTORY_APP_INSTALLATION_ID,
      );
    } catch (err) {
      const msg = `getInstallationToken failed: ${String(err)}`;
      console.error('[supervisor]', msg);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }

    const lockAcquired = await this.acquireLock(runId);
    if (!lockAcquired) {
      console.log('[supervisor] lock not acquired — another run in flight, skipping');
      await writeMemory(this.env.MEMORY, 'last_scheduled_tick', {
        at: Date.now(),
        skipped: true,
        reason: 'lock-held',
      });
      return Response.json({ ok: true, skipped: true, reason: 'lock-held' });
    }

    try {
      const templates = await loadTemplates();
      await writeMemory(this.env.MEMORY, `receipt:${runId}:templates_loaded`, {
        count: templates.length,
        at: Date.now(),
      });

      let issues: Awaited<ReturnType<typeof fetchApprovedIssues>> = [];
      try {
        issues = await fetchApprovedIssues(ghToken);
        await writeMemory(this.env.MEMORY, `receipt:${runId}:issues_fetched`, {
          count: issues.length,
          at: Date.now(),
        });
      } catch (err) {
        // Explicitly surface AbortError (from AbortSignal.timeout) as a distinct
        // timeout log entry — prevents it from being silently swallowed as a
        // generic failure.
        if (err instanceof Error && err.name === 'AbortError') {
          console.warn('[supervisor] github_api_timeout', { op: 'fetchApprovedIssues', limit: 10_000 });
          errors.push('fetchApprovedIssues timed out after 10 000 ms');
        } else {
          const msg = `fetchApprovedIssues failed: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
          errors.push(msg);
          console.error('[supervisor]', msg);
        }
      }

      // Bound execution time: PER_RUN_ISSUE_CAP limits iterations; ALARM_SOFT_DEADLINE_MS
      // provides a wall-clock backstop checked before each issue. Each GitHub API call
      // carries its own AbortSignal.timeout(10_000) so no individual call can hang.
      const runStart = Date.now();
      const issuesToProcess = issues.slice(0, PER_RUN_ISSUE_CAP);

      for (const issue of issuesToProcess) {
        // Soft deadline check — exit before the next issue if the run is approaching
        // the time budget. This is defensive: slow API calls should already abort via
        // their individual AbortSignal.timeout(10_000), but the deadline prevents
        // accumulation if the clock is close to the cap.
        if (Date.now() - runStart > ALARM_SOFT_DEADLINE_MS) {
          console.warn('[supervisor] soft deadline reached — stopping issue processing early');
          errors.push(`run_soft_deadline: stopped after ${Date.now() - runStart} ms`);
          break;
        }
        const combined = `${issue.title} ${issue.body}`.toLowerCase();
        if (combined.includes(LOCKOUT_PHRASE)) {
          console.log(`[supervisor] issue #${issue.number} contains lockout phrase — skipping`);
          await writeMemory(this.env.MEMORY, `receipt:${runId}:skip:${issue.number}`, {
            reason: 'wordis-bond',
            at: Date.now(),
          });
          continue;
        }

        const searchText = `${issue.title} ${issue.body.slice(0, 500)}`;
        const issueLabels = ((issue as unknown as { labels?: Array<{ name: string }> }).labels ?? []).map((l) => l.name);
        const template = matchTemplate(searchText, templates, { labels: issueLabels });

        if (!template) {
          noTemplate++;
          try {
            await addLabel(ghToken, issue.number, 'supervisor:no-template');
          } catch (err) {
            // Explicitly surface AbortError (from AbortSignal.timeout) as a distinct
            // timeout log entry — prevents it from being silently swallowed as a
            // generic failure.
            if (err instanceof Error && err.name === 'AbortError') {
              console.warn('[supervisor] github_api_timeout', { op: 'addLabel', limit: 10_000 });
              errors.push(`addLabel(no-template) #${issue.number}: timed out after 10 000 ms`);
            } else {
              const msg = `addLabel(no-template) #${issue.number}: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
              errors.push(msg);
              console.error('[supervisor]', msg);
            }
          }
          await writeMemory(this.env.MEMORY, `receipt:${runId}:no-template:${issue.number}`, {
            issueNumber: issue.number,
            at: Date.now(),
          });
          continue;
        }

        matched++;

        if (template.tier === 'red') {
          try {
            await addLabel(ghToken, issue.number, 'needs-human');
          } catch (err) {
            const msg = `addLabel(needs-human) #${issue.number}: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
            errors.push(msg);
            console.error('[supervisor]', msg);
          }
          await writeMemory(this.env.MEMORY, `receipt:${runId}:red-route-stop:${issue.number}`, {
            issueNumber: issue.number,
            templateId: template.id,
            tier: template.tier,
            at: Date.now(),
          });
          continue;
        }

        const existingPlan = await readMemory<PlanRecord>(
          this.env.MEMORY,
          `plan:${issue.number}`,
        );

        if (!existingPlan) {
          const plan = parameterize(template, {
            description: issue.title,
            source: `github:issue:${issue.number}`,
          });

          const planMarkdown = formatPlanComment(
            template.id,
            template.description,
            template.tier,
            plan.steps,
            template.pattern_check,
          );

          try {
            const commentId = await postPlanComment(ghToken, issue.number, planMarkdown);
            const record: PlanRecord = {
              commentId,
              templateId: template.id,
              postedAt: Date.now(),
            };
            await writeMemory(this.env.MEMORY, `plan:${issue.number}`, record);
            await writeMemory(
              this.env.MEMORY,
              `receipt:${runId}:plan-posted:${issue.number}`,
              { ...record, at: Date.now() },
            );
          } catch (err) {
            // Explicitly surface AbortError (from AbortSignal.timeout) as a distinct
            // timeout log entry — prevents it from being silently swallowed as a
            // generic failure.
            if (err instanceof Error && err.name === 'AbortError') {
              console.warn('[supervisor] github_api_timeout', { op: 'postPlanComment', limit: 10_000 });
              errors.push(`postPlanComment #${issue.number}: timed out after 10 000 ms`);
            } else {
              const msg = `postPlanComment #${issue.number}: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
              errors.push(msg);
              console.error('[supervisor]', msg);
            }
          }
        } else {
          try {
            const isApproved = await getPlanApproval(
              ghToken,
              issue.number,
              existingPlan.commentId,
            );
            if (isApproved) {
              approved++;
              await writeMemory(this.env.MEMORY, `approved:${issue.number}`, {
                issueNumber: issue.number,
                templateId: existingPlan.templateId,
                approvedAt: Date.now(),
              });
              await writeMemory(
                this.env.MEMORY,
                `receipt:${runId}:approved:${issue.number}`,
                { at: Date.now() },
              );
              console.log(`[supervisor] issue #${issue.number} plan approved — queued for execution`);
            }
          } catch (err) {
            // Explicitly surface AbortError (from AbortSignal.timeout) as a distinct
            // timeout log entry — prevents it from being silently swallowed as a
            // generic failure.
            if (err instanceof Error && err.name === 'AbortError') {
              console.warn('[supervisor] github_api_timeout', { op: 'getPlanApproval', limit: 10_000 });
              errors.push(`getPlanApproval #${issue.number}: timed out after 10 000 ms`);
            } else {
              const msg = `getPlanApproval #${issue.number}: ${(err as Error).message?.slice(0, 200) ?? String(err)}`;
              errors.push(msg);
              console.error('[supervisor]', msg);
            }
          }
        }
      }

      const summary = {
        runId,
        at: Date.now(),
        matched,
        noTemplate,
        approved,
        issuesProcessed: issuesToProcess.length,
        errors,
      };
      await writeMemory(this.env.MEMORY, 'last_run', summary);

      return Response.json({ ok: true, ...summary });
    } finally {
      await this.releaseLock(runId);
      await sendDigest(this.env.PUSHOVER_TOKEN, this.env.PUSHOVER_USER_KEY, {
        matched,
        noTemplate,
        approved,
        errors,
      });
    }
  }

  private async handlePlan(request: Request): Promise<Response> {
    const body = (await request.json()) as { description?: string; source?: string };
    if (!body.description) {
      return Response.json({ error: 'description required' }, { status: 422 });
    }

    const templates = await loadTemplates();
    const match = matchTemplate(body.description, templates);
    if (!match) {
      return Response.json({
        matched: false,
        reason: 'no template matched',
        template_count: templates.length,
      });
    }

    const plan = parameterize(match, { description: body.description, source: body.source ?? 'human' });
    const stats = await getTemplateStats(this.env.MEMORY, match.id, (match as unknown as { version?: number }).version ?? 1);
    const requiresPlanApproval = match.tier !== 'green' || !stats?.blessed || stats.demoted;
    const route = match.tier === 'red' ? 'route-and-stop' : requiresPlanApproval ? 'plan-approval-required' : 'green-blessed-executable';
    return Response.json({ matched: true, template: match.id, tier: match.tier, route, requires_plan_approval: requiresPlanApproval, stats, plan });
  }

  private async handleRun(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      template_id?: string;
      version?: number;
      description?: string;
      source?: string;
      dry_run?: boolean;
    };

    if (!body.template_id) {
      return Response.json({ error: 'template_id required' }, { status: 422 });
    }

    const templateId = body.template_id;
    const version = body.version ?? 1;
    const description = body.description ?? '';
    const source = body.source ?? 'supervisor/run';

    await recordRun(this.env.MEMORY, templateId, version, 'attempted');
    await writeMemory(this.env.MEMORY, 'last_run', { templateId, version, at: Date.now() });

    if (body.dry_run) {
      const stats = await getTemplateStats(this.env.MEMORY, templateId, version);
      return Response.json({
        dry_run: true,
        template_id: templateId,
        version,
        stats,
        note: 'Dry-run recorded attempt count. Set dry_run: false for full execution.',
      });
    }

    // Load templates and find the matching one
    const templates = await loadTemplates();
    // Templates carry no explicit `version` field today; a versionless template
    // is treated as version 1 so the default `version ?? 1` request matches.
    const template = templates.find(
      (t) => t.id === templateId && ((t as unknown as { version?: number }).version ?? 1) === version,
    );
    if (!template) {
      return Response.json(
        { error: `Template not found: ${templateId}@${version}` },
        { status: 404 },
      );
    }

    const stats = await getTemplateStats(this.env.MEMORY, templateId, version);
    if (template.tier === 'red') {
      return Response.json({
        ok: false,
        template_id: templateId,
        version,
        tier: template.tier,
        route: 'route-and-stop',
        reason: 'red-tier templates require a human owner and are not executable through /run',
        stats,
      }, { status: 409 });
    }
    if (template.tier === 'yellow') {
      return Response.json({
        ok: false,
        template_id: templateId,
        version,
        tier: template.tier,
        route: 'plan-approval-required',
        reason: 'yellow-tier templates require assisted plan approval before execution',
        stats,
      }, { status: 409 });
    }

    // Parameterize the template
    const plan = parameterize(template, { description, source });

    // Execute the parameterized plan
    const receipts = await executePlan(plan.steps, this.tools, this.env);

    // Check if all steps succeeded
    const allSucceeded = receipts.every((r) => r.result.ok);
    const now = Date.now();
    // UUID run IDs so factory_runs_mirror (UUID PK) can store them verbatim.
    const runId = crypto.randomUUID();

    // If execution succeeded and acceptance_gate is set, run verifier
    if (allSucceeded && template.acceptance_gate) {
      const verifyResult = await runVerifier(
        template.acceptance_gate,
        receipts,
        this.tools,
        this.env,
        runId,
      );

      if (!verifyResult.ok) {
        // Verification failed — log run status and return error without logging receipts
        await writeMemory(this.env.MEMORY, `run:${runId}:status`, { status: 'failed_verification', reason: verifyResult.reason });
        return Response.json(
          {
            ok: false,
            template_id: templateId,
            version,
            run_id: runId,
            failed_verification: true,
            reason: verifyResult.reason ?? 'Verification failed',
            description: description.slice(0, 200),
          },
          { status: 422 },
        );
      }
    }

    // Insert run record into supervisor_runs
    const runStatus = allSucceeded ? 'passed' : 'failed_execution';
    const finishedAt = Date.now();
    const runStmt = this.env.MEMORY.prepare(
      `INSERT INTO supervisor_runs
       (id, template_id, template_version, description, source, status, dry_run, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      templateId,
      version,
      description.slice(0, 500),
      source,
      runStatus,
      0, // not a dry run (checked earlier)
      now,
      finishedAt,
    );
    await runStmt.all();

    // Attempt to open a PR post-verification (if there are mutating steps)
    let prUrl: string | null = null;
    let prOpenError: string | null = null;
    if (allSucceeded) {
      const prResult = await openSupervisorPR(
        receipts,
        templateId,
        runId,
        description,
        this.tools,
        this.env,
      );

      if (prResult.ok && prResult.pr_url) {
        prUrl = prResult.pr_url;
        // Update supervisor_runs with PR URL
        const updateStmt = this.env.MEMORY.prepare(
          `UPDATE supervisor_runs SET pr_url = ?, pr_opened_at = ? WHERE id = ?`,
        ).bind(prUrl, Date.now(), runId);
        await updateStmt.all();
      } else if (!prResult.ok && prResult.error) {
        prOpenError = prResult.error.slice(0, 500);
        // Log gracefully (don't fail the run)
        const updateStmt = this.env.MEMORY.prepare(
          `UPDATE supervisor_runs SET pr_open_error = ? WHERE id = ?`,
        ).bind(prOpenError, runId);
        await updateStmt.all();
      }
    }

    // Push-on-write: best-effort notify factory-core-api of the terminal state.
    // Never throws — a push failure does not mask the run result.
    await pushRunToFactoryCoreApi(this.env, {
      id: runId,
      templateId,
      templateVersion: version,
      description,
      source,
      status: runStatus,
      dryRun: false,
      prUrl,
      startedAt: now,
      finishedAt,
    });

    // Log all receipts to D1 (only if execution succeeded and verification passed if applicable)
    for (const receipt of receipts) {
      const stmt = this.env.MEMORY.prepare(
        `INSERT INTO supervisor_steps
         (run_id, template_id, template_version, step_index, tool_name, side_effects, slots_json, result_json, jwt_scope, execution_ms, executed_at, awaiting_approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        templateId,
        version,
        receipt.step_index,
        receipt.tool_name,
        receipt.side_effects,
        JSON.stringify(receipt.slots_provided),
        JSON.stringify(receipt.result),
        receipt.jwt_scope,
        receipt.execution_ms,
        receipt.executed_at,
        receipt.awaiting_approval ?? null,
      );
      await stmt.all();
    }

    return Response.json({
      ok: allSucceeded,
      template_id: templateId,
      version,
      run_id: runId,
      steps_executed: receipts.length,
      receipts,
      description: description.slice(0, 200),
      pr_url: prUrl,
      pr_open_error: prOpenError,
    });
  }

  private async acquireLock(holder: string): Promise<boolean> {
    try {
      const lockId = this.env.LOCK.idFromName(LOCK_KEY);
      const lockStub = this.env.LOCK.get(lockId);
      const res = await lockStub.fetch(
        new Request('https://lock/acquire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: LOCK_KEY, holder, ttlMs: LOCK_TTL_MS }),
        }),
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { acquired: boolean };
      return data.acquired === true;
    } catch (err) {
      console.error('[supervisor] acquireLock error:', err);
      return false;
    }
  }

  private async releaseLock(holder: string): Promise<void> {
    try {
      const lockId = this.env.LOCK.idFromName(LOCK_KEY);
      const lockStub = this.env.LOCK.get(lockId);
      await lockStub.fetch(
        new Request('https://lock/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: LOCK_KEY, holder }),
        }),
      );
    } catch (err) {
      console.error('[supervisor] releaseLock error:', err);
    }
  }
}

/**
 * Best-effort push of a terminal run record to factory-core-api /v1/runs/mirror.
 * Never throws — a push failure must never mask the run result.
 */
async function pushRunToFactoryCoreApi(
  env: Env,
  run: {
    id: string;
    templateId: string;
    templateVersion: number;
    description: string;
    source: string;
    status: string;
    dryRun: boolean;
    prUrl: string | null;
    startedAt: number;
    finishedAt: number;
  },
): Promise<void> {
  const baseUrl = env.FACTORY_CORE_API_URL;
  const pushKey = env.SUPERVISOR_PUSH_KEY;
  if (!baseUrl || !pushKey) return;

  try {
    const resp = await fetch(`${baseUrl}/v1/runs/mirror`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pushKey}`,
      },
      body: JSON.stringify({
        id: run.id,
        template_id: run.templateId,
        template_version: run.templateVersion,
        description: run.description,
        source: run.source,
        status: run.status,
        dry_run: run.dryRun,
        pr_url: run.prUrl,
        started_at: new Date(run.startedAt).toISOString(),
        finished_at: new Date(run.finishedAt).toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'push-on-write failed',
          run_id: run.id,
          http_status: resp.status,
          body: text.slice(0, 200),
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'push-on-write error',
        run_id: run.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
