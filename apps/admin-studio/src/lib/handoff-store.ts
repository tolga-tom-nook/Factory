/**
 * Capability handoff + provision-request persistence.
 *
 * Stage B (Golden Design): durable, content-addressable handoff artifacts.
 * Stage C: audited staging-provision-request channel that references those
 * handoffs.
 *
 * Schema is mirrored in `apps/admin-studio/migrations/0006_capability_handoffs.sql`
 * and applied lazily here via `ensureCapabilityHandoffSchema()` so fresh
 * deploys don't 500 before the migration is run.
 */

import { createDb, sql, type FactoryDb, type HyperdriveBinding } from '@latimer-woods-tech/neon';
import type { CapabilityPlan } from './capability-plan.js';

export interface HandoffRecord {
  id: string;
  hash: string;
  schemaVersion: '1.0.0';
  conceptId: string;
  recipeId: string;
  parameters: Record<string, string | number | boolean | null>;
  plan: CapabilityPlan;
  preview: string;
  nextAction: {
    action: 'generate-scaffold-handoff' | 'request-staging-provision';
    conceptId: string;
    recipeId: string;
  };
  createdAt: string;
  createdBy: string;
  env: 'local' | 'staging' | 'production';
}

export interface ProvisionRequestRecord {
  id: string;
  handoffId: string;
  status: 'requested' | 'acknowledged' | 'dispatched' | 'succeeded' | 'failed' | 'withdrawn';
  proofGates: ProofGateState;
  requestedBy: string;
  requestedAt: string;
  env: 'local' | 'staging' | 'production';
  notes: string | null;
}

export interface ProofGateState {
  reviewedPlan: boolean;
  reviewedEnvContract: boolean;
  reviewedSmokeChecks: boolean;
  acknowledgedStagingFirst: boolean;
  acknowledgedCustomDomain: boolean;
}

export const REQUIRED_PROOF_GATES: ReadonlyArray<keyof ProofGateState> = [
  'reviewedPlan',
  'reviewedEnvContract',
  'reviewedSmokeChecks',
  'acknowledgedStagingFirst',
  'acknowledgedCustomDomain',
];

const dbCache = new WeakMap<HyperdriveBinding, FactoryDb>();
const schemaInitCache = new WeakMap<HyperdriveBinding, Promise<void>>();

function getDb(hyperdrive: HyperdriveBinding): FactoryDb {
  let db = dbCache.get(hyperdrive);
  if (!db) {
    db = createDb(hyperdrive);
    dbCache.set(hyperdrive, db);
  }
  return db;
}

async function ensureSchema(hyperdrive: HyperdriveBinding): Promise<void> {
  let init = schemaInitCache.get(hyperdrive);
  if (!init) {
    const db = getDb(hyperdrive);
    init = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS capability_handoffs (
          id UUID PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          schema_version TEXT NOT NULL,
          concept_id TEXT NOT NULL,
          recipe_id TEXT NOT NULL,
          parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
          plan JSONB NOT NULL,
          preview TEXT NOT NULL,
          next_action JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by TEXT NOT NULL,
          env TEXT NOT NULL CHECK (env IN ('local','staging','production'))
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_capability_handoffs_concept ON capability_handoffs (concept_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_capability_handoffs_recipe  ON capability_handoffs (recipe_id,  created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_capability_handoffs_created ON capability_handoffs (created_at DESC)`);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS capability_provision_requests (
          id UUID PRIMARY KEY,
          handoff_id UUID NOT NULL REFERENCES capability_handoffs(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK (status IN ('requested','acknowledged','dispatched','succeeded','failed','withdrawn')),
          proof_gates JSONB NOT NULL,
          requested_by TEXT NOT NULL,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          env TEXT NOT NULL CHECK (env IN ('local','staging','production')),
          notes TEXT
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_capability_provision_requests_handoff ON capability_provision_requests (handoff_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_capability_provision_requests_status ON capability_provision_requests (status, requested_at DESC)`);
    })();
    schemaInitCache.set(hyperdrive, init);
    init.catch(() => { schemaInitCache.delete(hyperdrive); });
  }
  await init;
}

/**
 * Persist a handoff (idempotent on hash). If a handoff with the same content
 * hash already exists, returns the existing record. Otherwise inserts a fresh
 * row and returns it.
 *
 * Best-effort: a DB outage returns the in-memory record so the response stays
 * useful — the caller's audit middleware still records the attempt.
 */
export async function persistHandoff(
  hyperdrive: HyperdriveBinding,
  record: Omit<HandoffRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): Promise<HandoffRecord> {
  const id = record.id ?? crypto.randomUUID();
  const createdAt = record.createdAt ?? new Date().toISOString();
  const fullRecord: HandoffRecord = { ...record, id, createdAt };

  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);

    const existing = await db.execute(sql`
      SELECT id, hash, schema_version, concept_id, recipe_id, parameters, plan, preview, next_action, created_at, created_by, env
      FROM capability_handoffs
      WHERE hash = ${record.hash}
      LIMIT 1
    `);
    const existingRow = (existing.rows as unknown[])[0] as HandoffRow | undefined;
    if (existingRow) {
      return rowToRecord(existingRow);
    }

    await db.execute(sql`
      INSERT INTO capability_handoffs (
        id, hash, schema_version, concept_id, recipe_id, parameters, plan, preview, next_action, created_at, created_by, env
      ) VALUES (
        ${id}, ${record.hash}, ${record.schemaVersion}, ${record.conceptId}, ${record.recipeId},
        ${JSON.stringify(record.parameters)}::jsonb,
        ${JSON.stringify(record.plan)}::jsonb,
        ${record.preview},
        ${JSON.stringify(record.nextAction)}::jsonb,
        ${createdAt}, ${record.createdBy}, ${record.env}
      )
      ON CONFLICT (hash) DO NOTHING
    `);
    return fullRecord;
  } catch (err) {
    console.error('[handoff-store] persist failed:', (err as Error).message);
    return fullRecord;
  }
}

export async function findHandoffById(
  hyperdrive: HyperdriveBinding,
  id: string,
): Promise<HandoffRecord | null> {
  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);
    const result = await db.execute(sql`
      SELECT id, hash, schema_version, concept_id, recipe_id, parameters, plan, preview, next_action, created_at, created_by, env
      FROM capability_handoffs
      WHERE id = ${id}
      LIMIT 1
    `);
    const row = (result.rows as unknown[])[0] as HandoffRow | undefined;
    return row ? rowToRecord(row) : null;
  } catch (err) {
    console.error('[handoff-store] lookup failed:', (err as Error).message);
    return null;
  }
}

export async function listHandoffs(
  hyperdrive: HyperdriveBinding,
  filter: { conceptId?: string; recipeId?: string; limit?: number } = {},
): Promise<HandoffRecord[]> {
  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);
    const limit = clamp(filter.limit ?? 50, 1, 200);

    const conditions: ReturnType<typeof sql>[] = [];
    if (filter.conceptId) conditions.push(sql`concept_id = ${filter.conceptId}`);
    if (filter.recipeId) conditions.push(sql`recipe_id = ${filter.recipeId}`);
    const whereChunks: ReturnType<typeof sql>[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
      whereChunks.push(i === 0 ? sql`WHERE` : sql`AND`);
      whereChunks.push(conditions[i]!);
    }
    const whereClause = sql.join(whereChunks, sql` `);

    const result = await db.execute(sql`
      SELECT id, hash, schema_version, concept_id, recipe_id, parameters, plan, preview, next_action, created_at, created_by, env
      FROM capability_handoffs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as HandoffRow[]).map(rowToRecord);
  } catch (err) {
    console.error('[handoff-store] list handoffs failed:', (err as Error).message);
    return [];
  }
}

export async function listProvisionRequests(
  hyperdrive: HyperdriveBinding,
  filter: {
    status?: ProvisionRequestRecord['status'];
    handoffId?: string;
    limit?: number;
  } = {},
): Promise<ProvisionRequestRecord[]> {
  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);
    const limit = clamp(filter.limit ?? 50, 1, 200);

    const conditions: ReturnType<typeof sql>[] = [];
    if (filter.status) conditions.push(sql`status = ${filter.status}`);
    if (filter.handoffId) conditions.push(sql`handoff_id = ${filter.handoffId}`);
    const whereChunks: ReturnType<typeof sql>[] = [];
    for (let i = 0; i < conditions.length; i += 1) {
      whereChunks.push(i === 0 ? sql`WHERE` : sql`AND`);
      whereChunks.push(conditions[i]!);
    }
    const whereClause = sql.join(whereChunks, sql` `);

    const result = await db.execute(sql`
      SELECT id, handoff_id, status, proof_gates, requested_by, requested_at, env, notes
      FROM capability_provision_requests
      ${whereClause}
      ORDER BY requested_at DESC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as ProvisionRequestRow[]).map((row) => ({
      id: row.id,
      handoffId: row.handoff_id,
      status: row.status,
      proofGates: row.proof_gates,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      env: row.env,
      notes: row.notes,
    }));
  } catch (err) {
    console.error('[handoff-store] list provision-requests failed:', (err as Error).message);
    return [];
  }
}

export async function transitionProvisionRequest(
  hyperdrive: HyperdriveBinding,
  id: string,
  next: {
    status: ProvisionRequestRecord['status'];
    notes?: string;
  },
): Promise<ProvisionRequestRecord | null> {
  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);
    const result = await db.execute(sql`
      UPDATE capability_provision_requests
      SET status = ${next.status},
          notes = COALESCE(${next.notes ?? null}, notes)
      WHERE id = ${id}
      RETURNING id, handoff_id, status, proof_gates, requested_by, requested_at, env, notes
    `);
    const row = (result.rows as unknown as ProvisionRequestRow[])[0];
    if (!row) return null;
    return {
      id: row.id,
      handoffId: row.handoff_id,
      status: row.status,
      proofGates: row.proof_gates,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      env: row.env,
      notes: row.notes,
    };
  } catch (err) {
    console.error('[handoff-store] transition provision-request failed:', (err as Error).message);
    return null;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

interface ProvisionRequestRow {
  id: string;
  handoff_id: string;
  status: ProvisionRequestRecord['status'];
  proof_gates: ProofGateState;
  requested_by: string;
  requested_at: string;
  env: ProvisionRequestRecord['env'];
  notes: string | null;
}

export async function recordProvisionRequest(
  hyperdrive: HyperdriveBinding,
  input: Omit<ProvisionRequestRecord, 'id' | 'requestedAt' | 'status'> & {
    id?: string;
    requestedAt?: string;
    status?: ProvisionRequestRecord['status'];
  },
): Promise<ProvisionRequestRecord> {
  const id = input.id ?? crypto.randomUUID();
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const status = input.status ?? 'requested';
  const record: ProvisionRequestRecord = { ...input, id, requestedAt, status };

  try {
    await ensureSchema(hyperdrive);
    const db = getDb(hyperdrive);
    await db.execute(sql`
      INSERT INTO capability_provision_requests (
        id, handoff_id, status, proof_gates, requested_by, requested_at, env, notes
      ) VALUES (
        ${id}, ${input.handoffId}, ${status},
        ${JSON.stringify(input.proofGates)}::jsonb,
        ${input.requestedBy}, ${requestedAt}, ${input.env}, ${input.notes ?? null}
      )
    `);
    return record;
  } catch (err) {
    console.error('[handoff-store] provision-request insert failed:', (err as Error).message);
    return record;
  }
}

export function validateProofGates(state: Partial<ProofGateState> | undefined | null): {
  valid: boolean;
  missing: ReadonlyArray<keyof ProofGateState>;
  normalized: ProofGateState;
} {
  const normalized: ProofGateState = {
    reviewedPlan: Boolean(state?.reviewedPlan),
    reviewedEnvContract: Boolean(state?.reviewedEnvContract),
    reviewedSmokeChecks: Boolean(state?.reviewedSmokeChecks),
    acknowledgedStagingFirst: Boolean(state?.acknowledgedStagingFirst),
    acknowledgedCustomDomain: Boolean(state?.acknowledgedCustomDomain),
  };
  const missing = REQUIRED_PROOF_GATES.filter((gate) => !normalized[gate]);
  return { valid: missing.length === 0, missing, normalized };
}

interface HandoffRow {
  id: string;
  hash: string;
  schema_version: string;
  concept_id: string;
  recipe_id: string;
  parameters: Record<string, string | number | boolean | null>;
  plan: CapabilityPlan;
  preview: string;
  next_action: HandoffRecord['nextAction'];
  created_at: string;
  created_by: string;
  env: HandoffRecord['env'];
}

function rowToRecord(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    hash: row.hash,
    schemaVersion: row.schema_version as '1.0.0',
    conceptId: row.concept_id,
    recipeId: row.recipe_id,
    parameters: row.parameters,
    plan: row.plan,
    preview: row.preview,
    nextAction: row.next_action,
    createdAt: row.created_at,
    createdBy: row.created_by,
    env: row.env,
  };
}
