/**
 * Capability Design Studio — backend route surface.
 *
 * Implements Stages A + B + C of the council-approved Golden Design
 * (docs/CAPABILITY_DESIGN_STUDIO_GOLDEN_DESIGN.md):
 *
 *   GET  /capabilities                  — list governed concepts
 *   POST /capabilities/resolve          — concept + params → recipe (reversible)
 *   POST /capabilities/preview          — resolve + compiled plan + markdown
 *   POST /capabilities/handoff          — durable, content-addressable handoff
 *   POST /capabilities/provision-staging — audited staging-provision request
 *
 * Every mutating route emits an audit entry via the audit middleware. The
 * handoff and provision-staging endpoints persist their artifacts in
 * Postgres via `handoff-store.ts`.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import {
  CapabilityResolutionError,
  type CapabilityResolution,
  listCapabilityCatalog,
  resolveCapabilityConcept,
} from '../lib/capability-registry.js';
import type { CapabilityPlan } from '../lib/capability-plan.js';
import { compileCapabilityPlan, renderCapabilityPlanPreview } from '../lib/capability-plan.js';
import { hashHandoffBody } from '../lib/handoff-hash.js';
import {
  findHandoffById,
  listHandoffs,
  listProvisionRequests,
  persistHandoff,
  recordProvisionRequest,
  transitionProvisionRequest,
  validateProofGates,
  type HandoffRecord,
  type ProofGateState,
  type ProvisionRequestRecord,
} from '../lib/handoff-store.js';

const capabilities = new Hono<AppEnv>();

const HANDOFF_SCHEMA_VERSION = '1.0.0' as const;

capabilities.get('/', (c) => {
  return c.json(listCapabilityCatalog());
});

capabilities.post('/resolve', async (c) => {
  const body = await parseConceptBody(c);
  if (!body.conceptId) {
    return c.json({ error: 'conceptId is required' }, 400);
  }

  try {
    const resolution = resolveCapabilityConcept(body.conceptId, body.params ?? {});
    c.set('auditAction', 'capabilities.resolve');
    c.set('auditResource', body.conceptId);
    c.set('auditReversibility', 'reversible');
    c.set('auditResultDetail', {
      conceptId: body.conceptId,
      recipeId: resolution.recipe.id,
      nextStep: resolution.nextStep.action,
    });
    return c.json(resolution);
  } catch (error) {
    if (error instanceof CapabilityResolutionError) {
      return c.json({ error: error.message }, { status: error.status as 400 | 404 | 500 });
    }
    throw error;
  }
});

capabilities.post('/preview', async (c) => {
  const body = await parseConceptBody(c);
  if (!body.conceptId) {
    return c.json({ error: 'conceptId is required' }, 400);
  }

  try {
    const resolution = resolveCapabilityConcept(body.conceptId, body.params ?? {});
    return c.json(buildPreviewResponse(body.conceptId, resolution));
  } catch (error) {
    if (error instanceof CapabilityResolutionError) {
      return c.json({ error: error.message }, { status: error.status as 400 | 404 | 500 });
    }
    throw error;
  }
});

capabilities.post('/handoff', async (c) => {
  const body = await parseConceptBody(c);
  if (!body.conceptId) {
    return c.json({ error: 'conceptId is required' }, 400);
  }

  try {
    const resolution = resolveCapabilityConcept(body.conceptId, body.params ?? {});
    const previewResponse = buildPreviewResponse(body.conceptId, resolution);
    const handoffBody = buildHandoffBody(previewResponse);
    const hash = await hashHandoffBody(handoffBody);

    const ctx = c.var.envContext;
    const dbBinding = c.env.DB;
    let persisted: HandoffRecord | null = null;
    if (ctx && dbBinding) {
      persisted = await persistHandoff(dbBinding, {
        hash,
        schemaVersion: HANDOFF_SCHEMA_VERSION,
        conceptId: handoffBody.conceptId,
        recipeId: handoffBody.recipeId,
        parameters: handoffBody.parameters,
        plan: handoffBody.plan,
        preview: handoffBody.preview,
        nextAction: handoffBody.nextAction,
        createdBy: ctx.userId,
        env: ctx.env,
      });
    }

    const handoff = {
      ...handoffBody,
      id: persisted?.id ?? null,
      hash,
      createdAt: persisted?.createdAt ?? new Date().toISOString(),
    };

    c.set('auditAction', 'capabilities.handoff');
    c.set('auditResource', body.conceptId);
    c.set('auditResourceId', handoff.id ?? hash);
    c.set('auditReversibility', 'reversible');
    c.set('auditResultDetail', {
      conceptId: body.conceptId,
      recipeId: handoff.recipeId,
      handoffId: handoff.id,
      handoffHash: hash,
      stagingFirst: handoff.plan.scaffold.stagingFirst,
    });

    return c.json({
      generatedAt: previewResponse.generatedAt,
      handoff,
    });
  } catch (error) {
    if (error instanceof CapabilityResolutionError) {
      return c.json({ error: error.message }, { status: error.status as 400 | 404 | 500 });
    }
    throw error;
  }
});

/**
 * Stage C: audited staging-provision request.
 *
 * This endpoint does NOT mutate Cloudflare or Neon directly — provisioning is
 * still a human-in-the-loop step. What it does:
 *   1. resolves the referenced handoff
 *   2. validates that every required proof gate is checked
 *   3. inserts a `capability_provision_requests` row (status='requested')
 *   4. emits an audit entry with reversibility='manual-rollback'
 *
 * Downstream automation can poll for `status='requested'` rows and dispatch
 * the actual scaffold + deploy workflow.
 */
capabilities.post('/provision-staging', async (c) => {
  const ctx = c.var.envContext;
  if (!ctx) {
    return c.json({ error: 'auth required' }, 401);
  }

  type ProvisionBody = {
    handoffId?: string;
    proofGates?: Partial<ProofGateState>;
    notes?: string;
  };
  const body: ProvisionBody = await c.req.json<ProvisionBody>().catch((): ProvisionBody => ({}));

  if (!body.handoffId) {
    return c.json({ error: 'handoffId is required' }, 400);
  }

  const handoff = await findHandoffById(c.env.DB, body.handoffId);
  if (!handoff) {
    return c.json({ error: `Unknown handoff: ${body.handoffId}` }, 404);
  }

  const gates = validateProofGates(body.proofGates);
  if (!gates.valid) {
    c.set('auditAction', 'capabilities.provision-staging');
    c.set('auditResource', handoff.conceptId);
    c.set('auditResourceId', handoff.id);
    c.set('auditReversibility', 'manual-rollback');
    c.set('auditResultDetail', {
      handoffId: handoff.id,
      missingGates: gates.missing,
    });
    return c.json(
      {
        error: 'Proof gates not satisfied',
        missing: gates.missing,
      },
      400,
    );
  }

  const request = await recordProvisionRequest(c.env.DB, {
    handoffId: handoff.id,
    proofGates: gates.normalized,
    requestedBy: ctx.userId,
    env: ctx.env,
    notes: body.notes ?? null,
  });

  c.set('auditAction', 'capabilities.provision-staging');
  c.set('auditResource', handoff.conceptId);
  c.set('auditResourceId', handoff.id);
  c.set('auditReversibility', 'manual-rollback');
  c.set('auditResultDetail', {
    handoffId: handoff.id,
    handoffHash: handoff.hash,
    provisionRequestId: request.id,
    proofGates: gates.normalized,
  });

  return c.json({
    request,
    handoff: {
      id: handoff.id,
      hash: handoff.hash,
      conceptId: handoff.conceptId,
      recipeId: handoff.recipeId,
    },
    nextStep: {
      action: 'await-staging-deployment',
      handoffId: handoff.id,
      requestId: request.id,
    },
  }, 201);
});

/**
 * Lineage: list recent handoff packages. Optional conceptId / recipeId filter.
 * GET /capabilities/handoffs?conceptId=…&recipeId=…&limit=50
 */
capabilities.get('/handoffs', async (c) => {
  const ctx = c.var.envContext;
  if (!ctx) {
    return c.json({ error: 'auth required' }, 401);
  }
  const conceptId = c.req.query('conceptId') ?? undefined;
  const recipeId = c.req.query('recipeId') ?? undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 50)) : 50;
  const handoffs = await listHandoffs(c.env.DB, { conceptId, recipeId, limit });
  return c.json({ generatedAt: new Date().toISOString(), handoffs });
});

/**
 * Lineage: list provision requests (optionally filtered by status / handoffId).
 * GET /capabilities/provision-requests?status=requested&limit=50
 */
capabilities.get('/provision-requests', async (c) => {
  const ctx = c.var.envContext;
  if (!ctx) {
    return c.json({ error: 'auth required' }, 401);
  }
  const status = c.req.query('status') as ProvisionRequestRecord['status'] | undefined;
  const handoffId = c.req.query('handoffId') ?? undefined;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 50)) : 50;
  const requests = await listProvisionRequests(c.env.DB, { status, handoffId, limit });
  return c.json({ generatedAt: new Date().toISOString(), requests });
});

/**
 * Operator-confirmed transition of a provision request between lifecycle
 * states. Allowed: requested → acknowledged → dispatched → (succeeded|failed),
 * or any state → withdrawn. Each transition is audited.
 *
 * POST /capabilities/provision-requests/:id/transition
 *   body: { status: 'acknowledged' | 'dispatched' | 'succeeded' | 'failed' | 'withdrawn', notes?: string }
 */
capabilities.post('/provision-requests/:id/transition', async (c) => {
  const ctx = c.var.envContext;
  if (!ctx) {
    return c.json({ error: 'auth required' }, 401);
  }
  const id = c.req.param('id');
  const body = await c.req
    .json<{ status?: ProvisionRequestRecord['status']; notes?: string }>()
    .catch(() => ({ status: undefined, notes: undefined } as { status?: ProvisionRequestRecord['status']; notes?: string }));

  const allowed: ProvisionRequestRecord['status'][] = [
    'acknowledged',
    'dispatched',
    'succeeded',
    'failed',
    'withdrawn',
  ];
  if (!body.status || !allowed.includes(body.status)) {
    return c.json(
      {
        error: 'status must be one of acknowledged|dispatched|succeeded|failed|withdrawn',
        allowed,
      },
      400,
    );
  }

  const updated = await transitionProvisionRequest(c.env.DB, id, {
    status: body.status,
    notes: body.notes,
  });
  if (!updated) {
    return c.json({ error: `Unknown provision request: ${id}` }, 404);
  }

  c.set('auditAction', 'capabilities.provision-staging.transition');
  c.set('auditResource', 'capability_provision_requests');
  c.set('auditResourceId', updated.id);
  c.set(
    'auditReversibility',
    body.status === 'succeeded' || body.status === 'failed' ? 'irreversible' : 'manual-rollback',
  );
  c.set('auditResultDetail', {
    provisionRequestId: updated.id,
    handoffId: updated.handoffId,
    nextStatus: updated.status,
  });

  return c.json({ request: updated });
});

type ConceptBody = { conceptId?: string; params?: Record<string, unknown> };

async function parseConceptBody(c: {
  req: { json: <T>() => Promise<T> };
}): Promise<ConceptBody> {
  return c.req.json<ConceptBody>().catch((): ConceptBody => ({}));
}

function buildPreviewResponse(conceptId: string, resolution: CapabilityResolution) {
  const plan = compileCapabilityPlan(resolution.recipe.id);
  const preview = renderCapabilityPlanPreview(plan);

  return {
    resolution,
    plan,
    preview,
    generatedAt: new Date().toISOString(),
    nextStep: {
      action: 'review-plan-preview' as const,
      conceptId,
      recipeId: resolution.recipe.id,
    },
  };
}

function buildHandoffBody(previewResponse: {
  resolution: CapabilityResolution;
  plan: CapabilityPlan;
  preview: string;
  nextStep: {
    action: string;
    conceptId: string;
    recipeId: string;
  };
}) {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind: 'scaffold-handoff' as const,
    conceptId: previewResponse.resolution.concept.id,
    recipeId: previewResponse.resolution.recipe.id,
    parameters: previewResponse.resolution.parameters,
    plan: previewResponse.plan,
    preview: previewResponse.preview,
    nextAction: {
      action: 'generate-scaffold-handoff' as const,
      conceptId: previewResponse.nextStep.conceptId,
      recipeId: previewResponse.nextStep.recipeId,
    },
  };
}

export default capabilities;
