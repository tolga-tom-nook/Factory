#!/usr/bin/env node
// pr-advisory-sweep.mjs — scheduled advisory sweep replacing per-push PR checks.
//
// Runs every 4 hours. For each open non-draft PR, checks if the current HEAD SHA
// has already been advised. If not, runs 4 advisory checks and posts/updates a
// single bundled comment. This replaces 4 separate per-push workflows
// (pr-quality-check, pr-size-warning, reviewer-class-hints, secret-contract-preflight)
// with 1 scheduled runner every 4 hours.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const { GH_TOKEN, REPO } = process.env;
if (!GH_TOKEN || !REPO) throw new Error('GH_TOKEN and REPO env vars required');

const [OWNER, REPO_NAME] = REPO.split('/');
const COMMENT_MARKER = '<!-- pr-advisory-sweep-v1 -->';

// ─── GitHub API ───────────────────────────────────────────────────────────────

async function gh(method, apiPath, body) {
  const url = apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(`GH ${method} ${apiPath} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ─── List open PRs ────────────────────────────────────────────────────────────

async function listOpenPRs() {
  const prs = [];
  let page = 1;
  while (true) {
    const batch = await gh('GET', `/repos/${REPO}/pulls?state=open&per_page=50&page=${page}`);
    if (!batch?.length) break;
    for (const pr of batch) {
      if (!pr.draft && pr.user?.type !== 'Bot') prs.push(pr);
    }
    if (batch.length < 50) break;
    page++;
  }
  return prs;
}

// ─── Find existing advisory comment ──────────────────────────────────────────

async function findAdvisoryComment(prNumber) {
  let page = 1;
  while (true) {
    const comments = await gh('GET', `/repos/${REPO}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!comments?.length) break;
    const found = comments.find(c => c.body?.includes(COMMENT_MARKER));
    if (found) return found;
    if (comments.length < 100) break;
    page++;
  }
  return null;
}

async function upsertComment(prNumber, existingId, body) {
  if (existingId) {
    await gh('PATCH', `/repos/${REPO}/issues/comments/${existingId}`, { body });
  } else {
    await gh('POST', `/repos/${REPO}/issues/${prNumber}/comments`, { body });
  }
}

// ─── Check 1: PR description quality ─────────────────────────────────────────

function checkQuality(prBody, prTitle) {
  const body = prBody || '';
  const checks = [
    {
      name: 'Summary / Objective',
      pass: /##\s*(summary|objective|what|overview|changes?)\b/i.test(body) || body.trim().length > 50,
      hint: 'Add a `## Summary` section explaining *what* this PR does and *why*.',
    },
    {
      name: 'Test plan',
      pass: /##\s*(test\s*plan|testing|how\s+to\s+test|verification)\b/i.test(body) ||
            /\[ \]|\[x\]/i.test(body),
      hint: 'Add a `## Test plan` section or a checklist so reviewers know what to verify.',
    },
    {
      name: 'Rollback / revert guidance',
      pass: !/\b(migration|schema|wrangler|d1_database|secret|credential)\b/i.test(body) ||
            /##\s*(rollback|revert|undo|recovery)\b/i.test(body) ||
            /rollback/i.test(body),
      hint: 'This PR looks infra-related. Add a `## Rollback` note explaining how to revert.',
    },
  ];
  const failing = checks.filter(c => !c.pass);
  if (failing.length === 0) return { ok: true, text: '✅ Description quality OK' };
  const bullets = failing.map(c => `- **${c.name}**: ${c.hint}`).join('\n');
  return { ok: false, text: `⚠️ Missing recommended sections:\n${bullets}` };
}

// ─── Check 2: PR size ─────────────────────────────────────────────────────────

const LINES_WARN = 500, LINES_SPLIT = 1000, FILES_WARN = 30, FILES_SPLIT = 60;

function checkSize(additions, deletions, fileCount) {
  const total = additions + deletions;
  let linesLabel = '✅';
  if (total > LINES_SPLIT) linesLabel = `🔴 ${total} lines — suggest splitting`;
  else if (total > LINES_WARN) linesLabel = `⚠️ ${total} lines (warn threshold ${LINES_WARN})`;
  else linesLabel = `✅ ${total} lines`;

  let filesLabel = '✅';
  if (fileCount > FILES_SPLIT) filesLabel = `🔴 ${fileCount} files — suggest splitting`;
  else if (fileCount > FILES_WARN) filesLabel = `⚠️ ${fileCount} files (warn threshold ${FILES_WARN})`;
  else filesLabel = `✅ ${fileCount} files`;

  const ok = total <= LINES_WARN && fileCount <= FILES_WARN;
  return { ok, text: `Lines: ${linesLabel}  ·  Files: ${filesLabel}` };
}

// ─── Check 3: Reviewer class hints ───────────────────────────────────────────
// Patterns aligned with .github/CODEOWNERS red/yellow tiers.

function classifyFiles(filePaths) {
  const red = [], yellow = [];
  for (const f of filePaths) {
    if (
      /^\.github\/workflows\//.test(f) ||
      /^\.github\/(CODEOWNERS|settings\.yml)$/.test(f) ||
      /^packages\//.test(f) ||
      /^migrations\//.test(f) ||
      /workers\/src\/db\/migrations\//.test(f) ||
      /\/handlers\/(billing|admin|stripe)/.test(f) ||
      /^(wrangler\.jsonc|wrangler\.toml)$/.test(f) ||
      /^apps\/[^/]+\/wrangler\./.test(f) ||
      /^(capabilities\.yml|apps\/[^/]+\/capabilities\.yml|docs\/service-registry\.yml)$/.test(f) ||
      /^apps\/supervisor\//.test(f) ||
      /^docs\/supervisor\/(plans\/|FRIDGE\.md)/.test(f)
    ) {
      red.push(f);
    } else if (
      /^apps\/[^/]+\/src\//.test(f) ||
      /^client\//.test(f) ||
      /^tests\//.test(f)
    ) {
      yellow.push(f);
    }
  }

  if (red.length === 0 && yellow.length === 0) return { tier: 'green', text: '✅ Green-tier paths only' };

  const parts = [];
  if (red.length > 0) {
    parts.push(`🔴 **Red-tier** (${red.length} file${red.length > 1 ? 's' : ''}): requires CODEOWNER approval + LLM consensus, no auto-merge`);
    if (red.length <= 8) parts.push('```\n' + red.join('\n') + '\n```');
  }
  if (yellow.length > 0) {
    parts.push(`🟡 **Yellow-tier** (${yellow.length} file${yellow.length > 1 ? 's' : ''}): LLM review satisfies code-owner gate, auto-merge on green CI allowed`);
  }
  return { tier: red.length > 0 ? 'red' : 'yellow', text: parts.join('\n') };
}

// ─── Check 4: Secret contracts ────────────────────────────────────────────────
// Ported from secret-contract-preflight.mjs (same logic, no duplication).

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractList(block, key) {
  const re = new RegExp(`\\b${escapeRe(key)}:\\s*\\n((?:[ \\t]+-[ \\t]+\\S+[ \\t]*\\n?)+)`);
  const m = re.exec(block);
  if (!m) return [];
  return m[1].split('\n').map(l => l.match(/^\s+-\s+(.+)$/)?.[1]?.trim()).filter(Boolean);
}

function extractScalar(block, key) {
  return block.match(new RegExp(`\\b${escapeRe(key)}:\\s+(.+)`))?.[1]?.trim() ?? null;
}

function parseRegistry() {
  const regPath = path.resolve('docs/service-registry.yml');
  if (!existsSync(regPath)) return [];
  const content = readFileSync(regPath, 'utf8');
  const [rawWorkers = '', rawPages = ''] = content.split(/^pages:/m);
  const entries = [];
  function parseSection(block, kind) {
    for (const part of block.split(/^  - id:/m).slice(1)) {
      const id = part.split('\n')[0].trim();
      if (!id) continue;
      entries.push({ id, kind, repo: extractScalar(part, 'repo'), required: extractList(part, 'required_secrets'), optional: extractList(part, 'optional_secrets') });
    }
  }
  parseSection(rawWorkers, 'worker');
  parseSection(rawPages, 'pages');
  return entries;
}

const ENV_SUFFIXES = new Set(['staging', 'production', 'prod', 'dev', 'preview', 'canary']);
function isEnvVariant(id, appDir) {
  if (id === appDir) return true;
  if (!id.startsWith(`${appDir}-`)) return false;
  return ENV_SUFFIXES.has(id.slice(appDir.length + 1));
}

function checkSecretContracts(filePaths, entries) {
  const touched = new Map();
  for (const file of filePaths) {
    const appDir = file.match(/^apps\/([^/]+)\//)?.[1];
    if (appDir) {
      for (const e of entries) { if (isEnvVariant(e.id, appDir)) touched.set(e.id, e); }
    }
    const wfName = file.match(/^\.github\/workflows\/([^/]+)\.yml$/)?.[1];
    if (wfName) {
      for (const e of entries) {
        const idBase = e.id.replace(/-(staging|production)$/, '');
        if (wfName.includes(e.id) || wfName.includes(idBase)) touched.set(e.id, e);
      }
    }
  }
  const services = [...touched.values()];
  if (services.length === 0) return { text: '✅ No registered services touched' };

  const rows = services.map(e => {
    const secrets = [
      ...e.required.map(s => `\`${s}\` ✅`),
      ...e.optional.map(s => `\`${s}\` ⚠️`),
    ];
    return `**${e.id}** (${e.kind}): ${secrets.length > 0 ? secrets.join(', ') : '_none declared_'}`;
  });
  return { text: rows.join('\n') };
}

// ─── Build bundled comment ────────────────────────────────────────────────────

function buildComment(sha, quality, size, hints, contracts) {
  return [
    COMMENT_MARKER,
    `<!-- advisory-sha:${sha} -->`,
    '## PR Advisory Checks',
    '',
    '> Automated sweep — advisory only, non-blocking. Refreshed every 4 hours.',
    '',
    '### Description Quality',
    quality.text,
    '',
    '### Size',
    size.text,
    '',
    '### Path Classification',
    hints.text,
    '',
    '### Secret Contracts',
    contracts.text,
    '',
    '---',
    `<sub>Sweep run at SHA \`${sha.slice(0, 8)}\` · [pr-advisory-sweep.yml](../../.github/workflows/pr-advisory-sweep.yml)</sub>`,
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const registryEntries = parseRegistry();

async function main() {
  const prs = await listOpenPRs();
  console.log(`Found ${prs.length} open non-draft PRs`);

  for (const pr of prs) {
    const sha = pr.head.sha;
    const existing = await findAdvisoryComment(pr.number);

    if (existing?.body?.includes(`<!-- advisory-sha:${sha} -->`)) {
      console.log(`PR #${pr.number}: already advised at ${sha.slice(0, 8)} — skipping`);
      continue;
    }

    console.log(`PR #${pr.number}: advising at ${sha.slice(0, 8)}...`);

    // Fetch full PR details for body + stats
    const detail = await gh('GET', `/repos/${REPO}/pulls/${pr.number}`);
    const files = await gh('GET', `/repos/${REPO}/pulls/${pr.number}/files?per_page=100`);
    const filePaths = (files || []).map(f => f.filename);

    const quality = checkQuality(detail.body, detail.title);
    const size = checkSize(detail.additions, detail.deletions, filePaths.length);
    const hints = classifyFiles(filePaths);
    const contracts = checkSecretContracts(filePaths, registryEntries);

    const comment = buildComment(sha, quality, size, hints, contracts);
    await upsertComment(pr.number, existing?.id, comment);
    console.log(`PR #${pr.number}: advisory posted`);

    // Rate-limit: 1 PR/s to stay inside secondary rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Sweep complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
