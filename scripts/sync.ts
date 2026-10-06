// Runs one sync of every form in config/fields.json. For now the source is always the fake Google
// Forms data; the real Google client arrives in the go-live phase.
import pg from 'pg';
import { createFakeSource } from '../src/fake-google/source.ts';
import { requireEnv } from '../src/lib/db.ts';
import { loadFieldConfig } from '../src/lib/fields.ts';
import { syncAll } from '../src/lib/sync.ts';

const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
try {
  const results = await syncAll(pool, createFakeSource(), await loadFieldConfig());
  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  await pool.end();
}
