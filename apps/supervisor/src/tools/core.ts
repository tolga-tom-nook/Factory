import type { ToolRegistry, Tool } from '@latimer-woods-tech/agent';
import type { Env } from '../index';
import { GENERATED_CAPABILITIES } from '../capabilities.generated';
import { loadTemplates } from '../planner/load';
import { readMemory } from '../memory/d1';
import { fetchApprovedIssues } from './github';
import { getInstallationToken } from './github-auth';

const FACTORY_OWNER = 'Latimer-Woods-Tech';
const FACTORY_REPO = 'Factory';
const GITHUB_API = 'https://api.github.com';
const ALLOWED_WRITE_LABELS = new Set(['docs', 'supervisor', 'tier-green', 'auto-merge-green']);

function readonlyTool(name: string, description: string, invoke: Tool['invoke'], parameters?: Record<string, unknown>): Tool {
  return {
    name,
    description,
    side_effects: 'none',
    required_scope: 'supervisor.readonly',
    invoke,
    parameters,
    exposeToLLM: false,
  };
}

function readExternalTool(name: string, description: string, invoke: Tool['invoke'], parameters?: Record<string, unknown>): Tool {
  return {
    name,
    description,
    side_effects: 'read-external',
    required_scope: 'supervisor.readonly',
    invoke,
    parameters,
    exposeToLLM: false,
  };
}

function writeExternalTool(name: string, description: string, invoke: Tool['invoke'], parameters?: Record<string, unknown>): Tool {
  return {
    name,
    description,
    side_effects: 'write-external',
    required_scope: 'supervisor.mutator-' + name,
    invoke,
    parameters,
    exposeToLLM: false,
  };
}

async function installationToken(env: Env): Promise<string> {
  return getInstallationToken(
    env.FACTORY_APP_ID,
    env.FACTORY_APP_PRIVATE_KEY,
    env.FACTORY_APP_INSTALLATION_ID,
  );
}

async function github<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await installationToken(env);
  const res = await fetch(GITHUB_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'factory-supervisor',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('GitHub API ' + res.status + ': ' + text.slice(0, 500));
  return text ? JSON.parse(text) as T : undefined as T;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(name + ' required');
  return value.trim();
}

function asNumber(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(name + ' must be a positive integer');
  return number;
}

function assertSafeRepoPath(path: string): void {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) throw new Error('unsafe path');
}

function assertDocsPath(path: string): void {
  assertSafeRepoPath(path);
  if (!/^(docs|documents)\/.+\.md$/.test(path)) throw new Error('only docs/documents markdown paths are writable');
}

function assertDocsBranch(branch: string): void {
  if (!/^(supervisor\/docs|docs)\/[a-z0-9][a-z0-9-]{0,60}$/.test(branch)) throw new Error('branch must be supervisor/docs/* or docs/*');
}

function allowedLabels(value: unknown): string[] {
  const labels = Array.isArray(value) ? value.map(String) : [];
  for (const label of labels) {
    if (!ALLOWED_WRITE_LABELS.has(label)) throw new Error('label not allowed: ' + label);
  }
  return labels;
}

async function readFactoryFile(env: Env, slots: Record<string, unknown>) {
  const path = asString(slots.path, 'path');
  assertSafeRepoPath(path);
  const ref = typeof slots.ref === 'string' && slots.ref ? slots.ref : 'main';
  const allowMissing = slots.allow_missing === true;
  try {
    const safePath = encodeURIComponent(path).replaceAll('%2F', '/');
    const data = await github<{ content?: string; encoding?: string; sha: string; type: string }>(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/contents/' + safePath + '?ref=' + encodeURIComponent(ref));
    return { ok: true as const, result: { path, ref, sha: data.sha, type: data.type, content: data.content && data.encoding === 'base64' ? atob(data.content.replace(/\s/g, '')) : null } };
  } catch (err) {
    if (allowMissing && err instanceof Error && err.message.includes('GitHub API 404')) return { ok: true as const, result: { path, ref, missing: true } };
    throw err;
  }
}

async function openDocsPR(env: Env, slots: Record<string, unknown>) {
  const branch = asString(slots.branch, 'branch');
  const base = typeof slots.base === 'string' && slots.base ? slots.base : 'main';
  const title = asString(slots.title, 'title');
  const commitMessage = asString(slots.commit_message, 'commit_message');
  const body = typeof slots.body === 'string' ? slots.body.slice(0, 10_000) : 'Supervisor docs PR.';
  const files = Array.isArray(slots.files) ? slots.files : [];
  if (base !== 'main') throw new Error('base must be main');
  assertDocsBranch(branch);
  if (!/^(docs|chore)[(:]/.test(title) || !/^(docs|chore)[(:]/.test(commitMessage)) throw new Error('title and commit_message must start with docs/chore');
  if (files.length !== 1) throw new Error('exactly one docs file may be written');
  const file = files[0] as { path?: unknown; content?: unknown };
  const path = asString(file.path, 'files[0].path');
  const content = asString(file.content, 'files[0].content');
  assertDocsPath(path);
  if (content.length > 200_000) throw new Error('file content too large');
  const labels = allowedLabels(slots.labels);
  const safePath = encodeURIComponent(path).replaceAll('%2F', '/');

  const mainRef = await github<{ object: { sha: string } }>(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/git/ref/heads/main');
  try {
    await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: mainRef.object.sha }) });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('GitHub API 422')) throw err;
    await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/git/refs/heads/' + encodeURIComponent(branch), { method: 'PATCH', body: JSON.stringify({ sha: mainRef.object.sha, force: true }) });
  }

  let existingSha: string | undefined;
  try {
    const existing = await github<{ sha: string }>(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/contents/' + safePath + '?ref=' + encodeURIComponent(branch));
    existingSha = existing.sha;
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('GitHub API 404')) throw err;
  }
  await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/contents/' + safePath, {
    method: 'PUT',
    body: JSON.stringify({ message: commitMessage, content: btoa(content), branch, ...(existingSha ? { sha: existingSha } : {}) }),
  });

  const open = await github<Array<{ number: number; html_url: string }>>(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/pulls?head=' + FACTORY_OWNER + ':' + encodeURIComponent(branch) + '&state=open&per_page=1');
  const pr = open[0] ?? await github<{ number: number; html_url: string }>(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/pulls', { method: 'POST', body: JSON.stringify({ title, head: branch, base, body }) });
  if (labels.length > 0) await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/issues/' + pr.number + '/labels', { method: 'POST', body: JSON.stringify({ labels }) });
  return { ok: true as const, result: { number: pr.number, html_url: pr.html_url, branch, base, files: [path] } };
}

async function commentOnPR(env: Env, slots: Record<string, unknown>) {
  const pr = asNumber(slots.pr ?? slots.issue, 'pr');
  const body = asString(slots.body, 'body');
  if (!body.toLowerCase().includes('supervisor')) throw new Error('comment must identify supervisor provenance');
  await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/issues/' + pr + '/comments', { method: 'POST', body: JSON.stringify({ body: body.slice(0, 5000) }) });
  return { ok: true as const, result: { number: pr } };
}

async function addAllowedLabel(env: Env, slots: Record<string, unknown>) {
  const number = asNumber(slots.pr ?? slots.issue, 'issue/pr');
  const label = asString(slots.label, 'label');
  allowedLabels([label]);
  await github(env, '/repos/' + FACTORY_OWNER + '/' + FACTORY_REPO + '/issues/' + number + '/labels', { method: 'POST', body: JSON.stringify({ labels: [label] }) });
  return { ok: true as const, result: { number, label } };
}

export function registerCoreSupervisorTools(registry: ToolRegistry, env: Env): void {
  registry.register(readonlyTool(
    'supervisor.health.snapshot',
    'Return a local supervisor health snapshot without external side effects.',
    async () => ({
      ok: true,
      result: {
        phase: 'SUP-4',
        app_count: GENERATED_CAPABILITIES.length,
        capability_count: GENERATED_CAPABILITIES.reduce((total, app) => total + app.capabilities.length, 0),
      },
    }),
  ));

  registry.register(readonlyTool(
    'registry.capabilities.list',
    'List generated app capability counts from the local supervisor bundle.',
    async () => ({
      ok: true,
      result: GENERATED_CAPABILITIES.map((app) => ({
        app: app.app,
        tiers_allowed: app.tiers_allowed,
        capability_count: app.capabilities.length,
      })),
    }),
  ));

  registry.register(readonlyTool(
    'template.list',
    'Load supervisor templates and return their ids, tiers, and step counts.',
    async () => {
      const templates = await loadTemplates();
      return {
        ok: true,
        result: templates.map((template) => ({
          id: template.id,
          tier: template.tier,
          step_count: template.steps?.length ?? 0,
        })),
      };
    },
  ));

  registry.register(readonlyTool(
    'state.lastRun.read',
    'Read the last supervisor run record from D1 memory.',
    async () => ({ ok: true, result: await readMemory(env.MEMORY, 'last_run') }),
  ));

  registry.register(readExternalTool(
    'github.issue.searchApproved',
    'Fetch open GitHub issues labeled supervisor:approved-source from the Factory repo.',
    async () => {
      const token = await installationToken(env);
      const issues = await fetchApprovedIssues(token);
      return {
        ok: true,
        result: issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((label) => label.name),
        })),
      };
    },
  ));

  registry.register(readExternalTool('github.readFile', 'Read a file from the Factory repository.', async (slots) => readFactoryFile(env, slots)));
  registry.register(writeExternalTool('github.openPR', 'Open a guarded docs-only PR in the Factory repository.', async (slots) => openDocsPR(env, slots)));
  registry.register(writeExternalTool('github.comment', 'Comment on a Factory PR with supervisor provenance.', async (slots) => commentOnPR(env, slots)));
  registry.register(writeExternalTool('github.addLabel', 'Apply an allowlisted label to a Factory issue or PR.', async (slots) => addAllowedLabel(env, slots)));
}
