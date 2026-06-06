/**
 * GitHub API tool implementations for the Factory Supervisor.
 *
 * All functions use `GH_TOKEN` (Bearer token) and explicitly handle errors —
 * no raw fetch without checking res.ok. Issue bodies are treated as untrusted
 * data: we extract only declared facts (numbers, labels) and never evaluate
 * or execute strings from issue content.
 *
 * Target repository: Latimer-Woods-Tech/factory
 */

const REPO = 'Latimer-Woods-Tech/factory';
const GITHUB_API = 'https://api.github.com';
const CODEOWNERS = new Set(['adrper79-dot']);
const GITHUB_TIMEOUT_MS = 10_000;

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

interface GitHubReaction {
  content: string;
  user: { login: string };
}

export interface GitHubCountResult {
  count: number;
  sampleNumbers: number[];
}

async function githubJson<T>(token: string, url: string, op: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'factory-supervisor',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`${op}: GitHub API error ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

export async function countOpenPullRequests(token: string): Promise<number> {
  const q = encodeURIComponent('repo:Latimer-Woods-Tech/Factory is:pr is:open');
  const data = await githubJson<{ total_count: number }>(
    token,
    `${GITHUB_API}/search/issues?q=${q}&per_page=1`,
    'countOpenPullRequests',
  );
  return data.total_count;
}

export async function countOpenIssuesWithLabel(token: string, label: string): Promise<GitHubCountResult> {
  const q = encodeURIComponent(`repo:Latimer-Woods-Tech/Factory is:issue is:open label:"${label}"`);
  const data = await githubJson<{ total_count: number; items: Array<{ number: number }> }>(
    token,
    `${GITHUB_API}/search/issues?q=${q}&per_page=5`,
    `countOpenIssuesWithLabel(${label})`,
  );
  return {
    count: data.total_count,
    sampleNumbers: data.items.map((item) => item.number),
  };
}

/**
 * Fetch all open issues labelled `supervisor:approved-source` from the
 * factory repo. Returns an array capped at 10 (per-run cap).
 */
export async function fetchApprovedIssues(token: string): Promise<GitHubIssue[]> {
  const url = `${GITHUB_API}/repos/${REPO}/issues?labels=supervisor%3Aapproved-source&state=open&per_page=10`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`fetchApprovedIssues: GitHub API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as GitHubIssue[];
  return data.slice(0, 10);
}

/**
 * Post a plan comment to a factory issue.
 * Returns the created comment ID so it can be stored in memory.
 */
export async function postPlanComment(
  token: string,
  issueNumber: number,
  planMarkdown: string,
): Promise<number> {
  const url = `${GITHUB_API}/repos/${REPO}/issues/${issueNumber}/comments`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: planMarkdown }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`postPlanComment: GitHub API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { id: number };
  return data.id;
}

/**
 * Add a label to a factory issue. Idempotent: GitHub silently ignores
 * labels that are already applied.
 */
export async function addLabel(
  token: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${REPO}/issues/${issueNumber}/labels`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels: [label] }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`addLabel: GitHub API error ${res.status}: ${text}`);
  }
}

/**
 * Check if a plan comment has been approved by a CODEOWNER via 👍 reaction.
 * Returns true if at least one reaction with content `+1` exists from a
 * recognised CODEOWNER.
 */
export async function getPlanApproval(
  token: string,
  issueNumber: number,
  commentId: number,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${REPO}/issues/comments/${commentId}/reactions?content=%2B1&per_page=100`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(
      `getPlanApproval: GitHub API error ${res.status} for issue #${issueNumber} comment ${commentId}: ${text}`,
    );
  }

  const reactions = (await res.json()) as GitHubReaction[];
  return reactions.some(
    (r) => r.content === '+1' && CODEOWNERS.has(r.user.login),
  );
}

/**
 * Format a plan as Markdown for posting to a GitHub issue comment.
 *
 * The formatted output is deterministic given the same inputs, and never
 * interpolates untrusted data into executable positions — only display text.
 */
export function formatPlanComment(
  templateId: string,
  templateDescription: string,
  tier: 'green' | 'yellow' | 'red',
  steps: Array<{ tool: string; slots?: Record<string, unknown> }>,
  patternCheck?: number[],
): string {
  const tierEmoji = { green: '🟢', yellow: '🟡', red: '🔴' }[tier];
  const stepLines = steps
    .map((s, i) => `${i + 1}. **${s.tool}**`)
    .join('\n');

  const sections: string[] = [
    `## Supervisor Plan — \`${templateId}\``,
    '',
    `**Tier:** ${tierEmoji} ${tier}  `,
    `**Template:** ${templateDescription || templateId}`,
    '',
    '### Steps',
    stepLines,
  ];

  // Tier-3 gap 2 — render the template's declared PATTERNS.md cross-references
  // so the human approving the plan AND the executing LLM both see exactly
  // which operational patterns this run must satisfy.
  if (patternCheck && patternCheck.length > 0) {
    sections.push(
      '',
      '### Patterns this template must satisfy',
      ...patternCheck.map(
        (n) =>
          `- [\`docs/architecture/PATTERNS.md\` §${n}](https://github.com/Latimer-Woods-Tech/factory/blob/main/docs/architecture/PATTERNS.md)`,
      ),
    );
  }

  sections.push(
    '',
    '---',
    '_React 👍 to approve this plan. The supervisor will execute on the next scheduled run._',
    '',
    '> ⚠️ This plan was generated automatically. Review each step before approving.',
  );

  return sections.join('\n');
}
