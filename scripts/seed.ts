// Replaces all data with the fake forms, by running a normal sync against the fake Google source.
import pg from 'pg';
import { createFakeSource } from '../src/fake-google/source.ts';
import { requireEnv } from '../src/lib/db.ts';
import { loadFormsConfig } from '../src/lib/forms-config.ts';
import { syncAll } from '../src/lib/sync.ts';

const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
try {
  await pool.query('TRUNCATE forms, questions, submissions, sync_runs RESTART IDENTITY CASCADE');
  const results = await syncAll(pool, createFakeSource(), await loadFormsConfig());
  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  await pool.end();
}
