import pg from 'pg';
import { requireEnv } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrate.ts';

const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
} finally {
  await client.end();
}
