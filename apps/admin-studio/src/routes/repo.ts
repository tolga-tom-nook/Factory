/**
 * Phase D — Repository browser + write routes.
 *
 *   GET  /repo/branches              → list branches (default flagged)
 *   GET  /repo/tree?ref=:ref         → full recursive tree at ref
 *   GET  /repo/file?path=…&ref=…     → single-file content (text or binary flag)
 *   POST /repo/branches              → create a new branch off `main`
 *   POST /repo/commit                → commit a single file (refuses `main`)
 *   POST /repo/pull-requests         → open a PR
 *
 * The Worker proxies all GitHub calls so the browser never sees the PAT.
 * Writes are blocked against the default branch and any branch GitHub
 * reports as protected.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  RepoCommitRequest,
  RepoCreateBranchRequest,
  RepoOpenPRRequest,
} from '@latimer-woods-tech/studio-core';
import type { AppEnv } from '../types.js';
import {
  GitHubApiError,
  commitFile,
  createBranch,
  fetchBranches,
  fetchFile,
  fetchTree,
  openPullRequest,
} from '../lib/github-api.js';
import { getGithubToken, hasGithubAuth } from '../lib/github-app.js';

const repo = new Hono<AppEnv>();

const PROTECTED_BRANCHES = new Set(['main']);

/** Hard caps on writes — prevent abuse and accidental huge payloads. */
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
const MAX_MESSAGE_BYTES = 4_096; // 4 KiB
const MAX_PR_TITLE_BYTES = 256;
const MAX_PR_BODY_BYTES = 16_384; // 16 KiB

async function readJson<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch (err) {
    throw Object.assign(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : 'parse error'}`), { status: 400 });
  }
}

repo.get('/branches', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  try {
    const branches = await fetchBranches(await getGithubToken(c.env));
    return c.json({ branches });
  } catch (err) {
    return mapError(c, err);
  }
});

repo.get('/tree', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  const ref = c.req.query('ref') || 'main';
  try {
    const tree = await fetchTree(await getGithubToken(c.env), ref);
    return c.json(tree);
  } catch (err) {
    return mapError(c, err);
  }
});

repo.get('/file', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  const path = c.req.query('path');
  const ref = c.req.query('ref') || 'main';
  if (!path) return c.json({ error: 'path query is required' }, 400);
  if (path.includes('..')) return c.json({ error: 'invalid path' }, 400);
  try {
    const file = await fetchFile(await getGithubToken(c.env), path, ref);
    return c.json({ file });
  } catch (err) {
    return mapError(c, err);
  }
});

repo.post('/branches', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  let body: RepoCreateBranchRequest;
  try { body = await readJson<RepoCreateBranchRequest>(c); } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (!body.name || !/^[A-Za-z0-9._/-]{1,128}$/.test(body.name)) {
    return c.json({ error: 'invalid branch name' }, 400);
  }
  if (PROTECTED_BRANCHES.has(body.name)) {
    return c.json({ error: 'branch is protected' }, 403);
  }
  try {
    const created = await createBranch(await getGithubToken(c.env), body.name, body.from ?? 'main');
    return c.json({ branch: created }, 201);
  } catch (err) {
    return mapError(c, err);
  }
});

repo.post('/commit', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  let body: RepoCommitRequest;
  try { body = await readJson<RepoCommitRequest>(c); } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (!body.path || body.path.includes('..')) return c.json({ error: 'invalid path' }, 400);
  if (!body.branch) return c.json({ error: 'branch required' }, 400);
  if (PROTECTED_BRANCHES.has(body.branch)) {
    return c.json({ error: 'cannot commit to protected branch', branch: body.branch }, 403);
  }
  if (!body.message?.trim()) return c.json({ error: 'message required' }, 400);
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
  if (body.message.length > MAX_MESSAGE_BYTES) {
    return c.json({ error: 'commit message too long', maxBytes: MAX_MESSAGE_BYTES }, 413);
  }
  // Approximate UTF-8 byte length via TextEncoder (no Buffer in Workers).
  const contentBytes = new TextEncoder().encode(body.content).length;
  if (contentBytes > MAX_FILE_BYTES) {
    return c.json({ error: 'file too large', bytes: contentBytes, maxBytes: MAX_FILE_BYTES }, 413);
  }

  // Belt-and-braces: also reject branches GitHub reports as protected.
  try {
    const branches = await fetchBranches(await getGithubToken(c.env));
    const branch = branches.find((b) => b.name === body.branch);
    if (branch?.protected) {
      return c.json({ error: 'cannot commit to protected branch', branch: body.branch }, 403);
    }
  } catch (err) {
    return mapError(c, err);
  }

  try {
    const result = await commitFile(await getGithubToken(c.env), {
      branch: body.branch,
      path: body.path,
      content: body.content,
      baseSha: body.baseSha,
      message: body.message,
    });
    return c.json({
      commitSha: result.commitSha,
      blobSha: result.blobSha,
      branch: body.branch,
      path: body.path,
    });
  } catch (err) {
    return mapError(c, err);
  }
});

repo.post('/pull-requests', async (c) => {
  if (!hasGithubAuth(c.env)) return c.json({ error: 'GitHub auth not configured' }, 503);
  let body: RepoOpenPRRequest;
  try { body = await readJson<RepoOpenPRRequest>(c); } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (!body.head || !body.title) return c.json({ error: 'head + title required' }, 400);
  if (PROTECTED_BRANCHES.has(body.head)) {
    return c.json({ error: 'head must not be a protected branch' }, 400);
  }
  if (body.title.length > MAX_PR_TITLE_BYTES) {
    return c.json({ error: 'title too long', maxBytes: MAX_PR_TITLE_BYTES }, 413);
  }
  if (body.body && body.body.length > MAX_PR_BODY_BYTES) {
    return c.json({ error: 'body too long', maxBytes: MAX_PR_BODY_BYTES }, 413);
  }
  try {
    const pr = await openPullRequest(await getGithubToken(c.env), body);
    return c.json({ pr }, 201);
  } catch (err) {
    return mapError(c, err);
  }
});

function mapError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof GitHubApiError) {
    if (err.status === 404) return c.json({ error: 'github', status: 404, detail: err.body.slice(0, 500) }, 404);
    if (err.status === 403) return c.json({ error: 'github', status: 403, detail: err.body.slice(0, 500) }, 403);
    if (err.status === 422) return c.json({ error: 'github', status: 422, detail: err.body.slice(0, 500) }, 422);
    return c.json({ error: 'github', status: err.status, detail: err.body.slice(0, 500) }, 502);
  }
  console.error('[repo] unexpected error:', (err as Error).message);
  return c.json({ error: 'internal' }, 500);
}

export default repo;
