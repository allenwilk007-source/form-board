// Runs one sync of every listed form, from the same place the owner area's "Sync now" reads:
// FORMS_SOURCE=google for the owner's real forms, otherwise the fake ones.
import pg from 'pg';
import { requireEnv } from '../src/lib/db.ts';
import { syncAll } from '../src/lib/sync.ts';
import { formsSource } from '../src/server/source.ts';

const source = formsSource();
console.log(`Syncing from ${process.env.FORMS_SOURCE === 'google' ? "the owner's real Google Forms" : 'the fake forms'}.`);
const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
try {
  const results = await syncAll(pool, source);
  console.table(results);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  await pool.end();
}
