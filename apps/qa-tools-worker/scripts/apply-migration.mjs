/**
 * One-shot migration runner using @neondatabase/serverless.
 * Usage: node scripts/apply-migration.mjs <sql-file>
 *
 * Environment:
 *   DATABASE_URL — Neon connection string (with sslmode=require)
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [,, sqlPath] = process.argv;
if (!sqlPath) {
  console.error('Usage: node scripts/apply-migration.mjs <sql-file>');
  process.exit(1);
}

const connStr = process.env['DATABASE_URL'];
if (!connStr) {
  console.error('DATABASE_URL env var is required');
  process.exit(1);
}

const absolutePath = resolve(sqlPath);
const sql = readFileSync(absolutePath, 'utf8');

const db = neon(connStr);
try {
  await db.unsafe(sql);
  console.log(`✓ Migration applied: ${absolutePath}`);
} catch (err) {
  console.error('Migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
