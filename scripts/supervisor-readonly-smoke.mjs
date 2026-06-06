#!/usr/bin/env node

const env = globalThis.process?.env ?? {};
const url = env.SUPERVISOR_READONLY_SMOKE_URL || 'https://supervisor.latwoodtech.work/tools/read-only-smoke';
const token = env.SUPERVISOR_API_KEY;
const allowedHosts = new Set(['supervisor.latwoodtech.work', 'factory-supervisor.adrper79.workers.dev']);
const greenPlanDescription = env.SUPERVISOR_GREEN_PLAN_DESCRIPTION || '';
const expectedGreenTemplate = env.SUPERVISOR_EXPECTED_GREEN_TEMPLATE_ID || '';
const expectedWriteTools = (env.SUPERVISOR_EXPECTED_WRITE_TOOLS || '').split(',').map((name) => name.trim()).filter(Boolean).sort();
const expectedPlanEffects = new Map((env.SUPERVISOR_EXPECTED_GREEN_PLAN_EFFECTS || '').split(',').filter(Boolean).map((entry) => entry.split('=').map((part) => part.trim())));
const shouldRunGreenTemplate = env.SUPERVISOR_RUN_GREEN_TEMPLATE === 'true';
const required = [
  'supervisor.health.snapshot',
  'registry.capabilities.list',
  'template.list',
  'state.lastRun.read',
];

function fail(message, context = {}) {
  console.error(`[supervisor-readonly-smoke] ${message}`);
  if (Object.keys(context).length > 0) console.error(JSON.stringify(context, null, 2));
  process.exit(1);
}

async function fetchJson(targetUrl, options, label) {
  const response = await fetch(targetUrl, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`${label} response was not JSON`, { status: response.status, body: text.slice(0, 500) });
  }
  return { response, body };
}

if (!token) fail('SUPERVISOR_API_KEY is required');

const parsedUrl = new URL(url);
if (!allowedHosts.has(parsedUrl.hostname)) {
  fail('refusing to send supervisor API key to unapproved host', { host: parsedUrl.hostname });
}

const authHeaders = {
  accept: 'application/json',
  authorization: `Bearer ${token}`,
};

const { response, body } = await fetchJson(parsedUrl, { headers: authHeaders }, 'readonly smoke');
if (!response.ok || body.ok !== true) fail('readonly smoke endpoint failed', { status: response.status, body });
if (body.kind !== 'supervisor-readonly-smoke') fail('unexpected smoke kind', { kind: body.kind });
if (body.tools_invoked !== required.length) fail('unexpected invoked tool count', { tools_invoked: body.tools_invoked });

const invoked = new Map((body.invoked || []).map((tool) => [tool.name, tool]));
for (const name of required) {
  const tool = invoked.get(name);
  if (!tool) fail('required tool was not invoked', { name, invoked: [...invoked.keys()] });
  if (tool.side_effects !== 'none' || tool.ok !== true) fail('tool was not a successful readonly invocation', { tool });
}

const registeredNames = body.registered?.tool_names || [];
if (!registeredNames.includes('github.issue.searchApproved')) fail('read-external GitHub search tool is not registered', { registeredNames });
const writeCapableTools = (body.write_capable_tools || []).slice().sort();
if (expectedWriteTools.length > 0 && JSON.stringify(writeCapableTools) !== JSON.stringify(expectedWriteTools)) {
  fail('unexpected write-capable tool surface', { expectedWriteTools, writeCapableTools });
}
if ((body.registered?.tools_registered || 0) < 5 + expectedWriteTools.length) fail('too few tools registered', { registered: body.registered });

let greenPlan = null;
if (greenPlanDescription) {
  const planUrl = new URL('/plan', parsedUrl.origin);
  const plan = await fetchJson(planUrl, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      description: greenPlanDescription,
      source: 'smoke:green-template-dry-run',
    }),
  }, 'green plan dry-run');

  if (!plan.response.ok || plan.body.matched !== true) fail('green plan dry-run did not match a template', { status: plan.response.status, body: plan.body });
  if (expectedGreenTemplate && plan.body.template !== expectedGreenTemplate) fail('green plan matched the wrong template', { expectedGreenTemplate, actual: plan.body.template });
  if (plan.body.plan?.tier !== 'green') fail('green plan matched a non-green tier', { tier: plan.body.plan?.tier, template: plan.body.template });
  for (const step of plan.body.plan?.steps || []) {
    const expected = expectedPlanEffects.get(step.tool);
    if (expected && step.side_effects !== expected) fail('green plan step has wrong side effect classification', { step, expected });
    if (!expected && step.side_effects !== 'none') fail('green plan contains unexpected side-effectful step', { step });
  }
  if (JSON.stringify(plan.body.plan).includes('$slots.')) fail('green plan dry-run left unresolved slot placeholders', { plan: plan.body.plan });
  greenPlan = {
    matched: true,
    template: plan.body.template,
    tier: plan.body.plan.tier,
    steps: plan.body.plan.steps.length,
  };

  if (shouldRunGreenTemplate) {
    const runUrl = new URL('/run', parsedUrl.origin);
    const run = await fetchJson(runUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: expectedGreenTemplate,
        description: greenPlanDescription,
        source: 'workflow_dispatch:first-controlled-green-pr',
      }),
    }, 'green template run');

    if (!run.response.ok || run.body.ok !== true) fail('green template run failed', { status: run.response.status, body: run.body });
    const prReceipt = (run.body.receipts || []).find((receipt) => receipt.tool_name === 'github.openPR');
    const prUrl = prReceipt?.result?.result?.html_url;
    if (!prUrl) fail('green template run did not return a PR URL from github.openPR', { body: run.body });
    greenPlan.run = { run_id: run.body.run_id, pr_url: prUrl, steps_executed: run.body.steps_executed };
  }
}

console.log(JSON.stringify({
  ok: true,
  url,
  tools_registered: body.registered.tools_registered,
  tools_invoked: body.tools_invoked,
  tool_side_effects: body.tool_side_effects,
  green_plan: greenPlan,
}, null, 2));
